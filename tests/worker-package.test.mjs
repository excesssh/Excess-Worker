import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawn,spawnSync} from "node:child_process";
import {mkdir,mkdtemp,readFile,readdir,writeFile} from "node:fs/promises";
import {join,resolve,relative,sep} from "node:path";
import {once} from "node:events";
import {createServer} from "node:http";

async function files(dir){const result=[];for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);
  if(entry.isDirectory())result.push(...await files(path));else result.push(path);}return result;}

test("the packaged Windows worker runs from its own folder with the bundled runtime and guides onboarding",{skip:process.platform!=="win32"},async t=>{
  await mkdir(".cache",{recursive:true});
  const out=await mkdtemp(resolve(".cache/package-test-")),home=await mkdtemp(resolve(".cache/package-home-"));
  const built=spawnSync(process.execPath,["scripts/package-worker.mjs","--out",out,"--no-zip"],{encoding:"utf8"});
  assert.equal(built.status,0,built.stderr);
  const summary=JSON.parse(built.stdout.trim().split("\n").at(-1)),dir=summary.directory;
  assert.equal(summary.publicDistributionReady,false,"without the Node licence text the package is marked not for public distribution");
  const manifest=JSON.parse(await readFile(join(dir,"manifest.json"),"utf8"));
  assert.deepEqual([manifest.platform,manifest.node,manifest.codeSigned],["win32-x64",process.version,false]);

  const all=(await files(dir)).map(file=>relative(dir,file).split(sep).join("/"));
  assert.ok(all.includes("node/node.exe")&&all.includes("app/worker/dist/main.js")&&all.includes("app/node_modules/@excess/adapters/dist/index.js"));
  assert.deepEqual(all.filter(file=>/\.(map|tsbuildinfo)$|\.d\.ts$/.test(file)),[],"no source maps or declarations");
  assert.deepEqual(all.filter(file=>/^(tests|packages|apps|scripts|\.local)\//.test(file)),[],"no repository sources, tests or local state");
  const sums=(await readFile(join(dir,"SHA256SUMS.txt"),"utf8")).trim().split("\n");
  assert.equal(sums.length,all.length-1);
  for(const line of sums){const [hash,file]=line.split("  ");assert.equal(createHash("sha256").update(await readFile(join(dir,file))).digest("hex"),hash,file);}

  // A clean environment with no system Node on PATH: only the bundled runtime can run it.
  const systemRoot=process.env.SystemRoot??"C:\\Windows";
  const env={SystemRoot:systemRoot,WINDIR:systemRoot,PATH:join(systemRoot,"System32"),LOCALAPPDATA:home,TEMP:home,TMP:home};
  const run=(...commandArgs)=>spawnSync(join(systemRoot,"System32","cmd.exe"),["/d","/s","/c",`"${join(dir,"excess-worker.cmd")}" ${commandArgs.join(" ")}`],
    {env,encoding:"utf8",windowsVerbatimArguments:true,timeout:60000});
  const doctor=run("doctor");
  assert.equal(doctor.status,0,doctor.stderr);
  const diagnostics=JSON.parse(doctor.stdout);
  assert.deepEqual([diagnostics.product,diagnostics.kind,diagnostics.architecture],["EXCESS","local_diagnostics","x64"]);
  let guide=JSON.parse(run("guide").stdout);
  assert.deepEqual([guide.next,guide.origin,guide.model,guide.backend,guide.steps.map(s=>s.done)],["pair",null,"qwen3-4b","cpu",[false,true,false,false,false]]);
  const models=JSON.parse(run("models").stdout);
  assert.deepEqual(models.models.map(m=>m.id),["qwen3-4b","qwen3-8b","qwen3-14b","qwen3-30b-a3b"]);
  assert.deepEqual(models.active,{model:"qwen3-4b",backend:"cpu"});
  const chosen=run("use","qwen3-8b","--gpu");
  assert.equal(chosen.status,0,chosen.stderr);assert.deepEqual([JSON.parse(chosen.stdout).policy.model,JSON.parse(chosen.stdout).policy.backend],["qwen3-8b","cuda"]);
  assert.equal(JSON.parse(run("model-plan").stdout).backend,"cuda","the plan follows the chosen model and backend");
  assert.notEqual(run("use","not-a-model").status,0);
  assert.equal(run("use","qwen3-4b").status,0);
  assert.match(guide.disclosure,/see their prompts and outputs/);
  assert.deepEqual(JSON.parse(run("offer").stdout).offer,null);
  const plan=JSON.parse(run("model-plan").stdout);
  assert.deepEqual([plan.directory,plan.modelId,plan.backend],[join(home,"EXCESS","ai"),"qwen3-4b","cpu"],"models install under the user's local app data");
  assert.notEqual(run("no-such-command").status,0);
  assert.notEqual(run("install-model").status,0,"model download still requires explicit consent flags");

  // A symbol price per million tokens becomes exact base units per token from the exchange's own market.
  const assetId="11111111-2222-4333-8444-555555555555";
  const market=createServer((request,response)=>{
    if(request.url!=="/v1/market"){response.writeHead(404).end();return;}
    response.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({markets:[{asset:{id:assetId,symbol:"TEST",decimals:6}}]}));
  });
  market.listen(0,"127.0.0.1");await once(market,"listening");t.after(()=>market.close());
  const workerHome=join(home,"EXCESS","worker");await mkdir(workerHome,{recursive:true});
  await writeFile(join(workerHome,"identity.json"),JSON.stringify({version:1,origin:"http://127.0.0.1:"+market.address().port,deviceId:"PAIRED-FIXTURE"}));
  // This process serves the market, so these commands must not block its event loop.
  const runAsync=(...commandArgs)=>new Promise((resolve,reject)=>{
    const child=spawn(join(systemRoot,"System32","cmd.exe"),["/d","/s","/c",`"${join(dir,"excess-worker.cmd")}" ${commandArgs.join(" ")}`],{env,windowsVerbatimArguments:true});
    let stdout="",stderr="";child.stdout.on("data",d=>{stdout+=d;});child.stderr.on("data",d=>{stderr+=d;});
    const timer=setTimeout(()=>{child.kill();reject(Error("worker command timed out"));},60000);
    child.on("error",reject);child.on("close",status=>{clearTimeout(timer);resolve({status,stdout,stderr});});
  });
  const priced=await runAsync("offer","TEST","3");
  assert.equal(priced.status,0,priced.stderr);
  assert.deepEqual(JSON.parse(priced.stdout).offer,{assetId,netUnits:"3"},"3 TEST per million tokens is 3 base units per token at 6 decimals");
  const fractional=await runAsync("offer","TEST","2.5");
  assert.notEqual(fractional.status,0);assert.match(fractional.stderr,/multiple of 1 TEST/);
  guide=JSON.parse(run("guide").stdout);
  assert.deepEqual([guide.next,guide.steps.map(s=>s.done)],["install-model",[true,true,false,true,false]]);
});
