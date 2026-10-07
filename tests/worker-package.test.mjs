import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawn,spawnSync} from "node:child_process";
import {mkdir,readFile,readdir,writeFile} from "node:fs/promises";
import {join,relative,sep,isAbsolute} from "node:path";
import {once} from "node:events";
import {createServer} from "node:http";
import {createFixtureScratch} from "./helpers/fixture-scratch.mjs";

async function files(dir){const result=[];for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);
  if(entry.isDirectory())result.push(...await files(path));else result.push(path);}return result;}

test("the packaged Windows worker runs from its own folder with the bundled runtime and guides onboarding",{skip:process.platform!=="win32"},async t=>{
  const scratchParent=process.env.EXCESS_TEST_FIXTURE_CACHE??process.env.EXCESS_TEST_ROOT??".cache";
  const outScratch=await createFixtureScratch("package-test-",scratchParent);
  t.after(()=>outScratch.cleanup());
  const homeScratch=await createFixtureScratch("package-home-",scratchParent);
  t.after(()=>homeScratch.cleanup());
  const out=outScratch.path,home=homeScratch.path;
  // Inert native bytes check delivery and integrity only; this is no execution proof.
  const native=join(out,"native-fixture"),helper=Buffer.from("INERT NATIVE PACKAGING FIXTURE");await mkdir(native);
  const nativeHash=createHash("sha256").update(helper).digest("hex");
  await writeFile(join(native,"ExcessSandbox.exe"),helper);
  await writeFile(join(native,"integrity-win32.json"),JSON.stringify({profile:"windows-appcontainer-v1",sha256:nativeHash}));
  await writeFile(join(native,"ExcessController.exe"),helper);
  await writeFile(join(native,"integrity-controller-win32.json"),JSON.stringify({profile:"windows-appcontainer-controller-v1",sha256:nativeHash}));
  await writeFile(join(native,"unrelated-fixture.txt"),"must not ship");
  const buildArgs=["scripts/package-worker.mjs","--out",out,"--no-zip","--native-dir",native,"--require-native"];
  // Source archives have no Git metadata; use a fixed fixture timestamp.
  const buildEnv={...process.env,SOURCE_DATE_EPOCH:"1728000000"};
  await writeFile(join(native,"ExcessSandbox.exe"),"ALTERED NATIVE PACKAGING FIXTURE");
  const altered=spawnSync(process.execPath,buildArgs,{encoding:"utf8",env:buildEnv});
  assert.notEqual(altered.status,0);assert.match(altered.stderr,/RUNTIME_SANDBOX_INTEGRITY_INVALID/);
  const missing=spawnSync(process.execPath,[...buildArgs.slice(0,-3),"--native-dir",join(out,"missing-native"),"--require-native"],{encoding:"utf8",env:buildEnv});
  assert.notEqual(missing.status,0);assert.match(missing.stderr,/RUNTIME_SANDBOX_BUILD_REQUIRED/);
  await writeFile(join(native,"ExcessSandbox.exe"),helper);
  const built=spawnSync(process.execPath,buildArgs,{encoding:"utf8",env:buildEnv});
  assert.equal(built.status,0,built.stderr);
  const summary=JSON.parse(built.stdout.trim().split("\n").at(-1)),dir=summary.directory;
  assert.equal(summary.licensesIncluded,true,"the pinned Node runtime ships with its own licence text");
  assert.equal(summary.publicDistributionReady,false,"unverified isolated execution blocks release publication");
  const manifest=JSON.parse(await readFile(join(dir,"manifest.json"),"utf8"));
  assert.deepEqual(manifest.native,{profile:"windows-appcontainer-v1",file:"app/node_modules/@excess/adapters/native/ExcessSandbox.exe",sha256:nativeHash});
  assert.deepEqual(manifest.execution,{profile:"windows-appcontainer-v1",cpuVerified:false,gpuVerified:false});
  assert.deepEqual((await readdir(join(dir,"app/node_modules/@excess/adapters/native"))).sort(),
    ["ExcessController.exe","ExcessSandbox.exe","integrity-controller-win32.json","integrity-win32.json"],"only the selected platform helpers and pins ship");
  assert.deepEqual(manifest.controller,{profile:"windows-appcontainer-controller-v1",files:[{
    file:"app/node_modules/@excess/adapters/native/ExcessController.exe",profile:"windows-appcontainer-controller-v1",sha256:nativeHash}],verified:false});
  const bundledEntry=await readFile(join(dir,"app/worker/dist/windows-controller-entry.js"));
  const bundleInputs=JSON.parse(await readFile(join(dir,"app/worker/controller-bundle-inputs.json"),"utf8"));
  assert.deepEqual([bundleInputs.builder,bundleInputs.version],["esbuild","0.28.2"]);
  assert.equal(bundleInputs.sha256,createHash("sha256").update(bundledEntry).digest("hex"));
  assert.equal(bundleInputs.bytes,bundledEntry.length);
  assert.ok(bundleInputs.inputs.length>0&&bundleInputs.inputs.every(input=>!input.path.includes("..")&&!isAbsolute(input.path)&&/^[0-9a-f]{64}$/.test(input.sha256)));
  for(const input of bundleInputs.inputs)assert.equal(createHash("sha256").update(await readFile(input.path)).digest("hex"),input.sha256,"bundle input is bound to actual compiled source");
  assert.deepEqual([manifest.platform,manifest.node,manifest.codeSigned],["win32-x64","v24.11.1",false],
    "the package pins its Node runtime rather than copying whichever node.exe built it");
  assert.ok((await readFile(join(dir,"licenses","node-LICENSE.txt"),"utf8")).includes("Node.js is licensed for use as follows"),
    "Node's own licence text is bundled for public distribution");

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
  assert.deepEqual(models.models.map(m=>m.id).sort(),["flux1-schnell","gpt-oss-120b","gpt-oss-20b","llama-3.1-8b","llama-3.3-70b","phi-4","phi-4-mini","qwen3-14b","qwen3-30b-a3b",
    "qwen3-30b-a3b-instruct-2507","qwen3-32b","qwen3-4b","qwen3-8b","qwen3-asr-0.6b","qwen3-coder-30b-a3b","qwen3-embedding-0.6b","sd-turbo"]);
  assert.deepEqual(Object.fromEntries(models.models.filter(m=>m.kind!=="text").map(m=>[m.id,m.kind])),{"qwen3-embedding-0.6b":"embedding","qwen3-asr-0.6b":"transcription","sd-turbo":"image","flux1-schnell":"image"});
  // Models that fit this computer are listed first, and the summary lists agree with each model's own fit.
  const fitting=models.models.map(m=>m.fits!=="no");
  assert.deepEqual(fitting,[...fitting].sort((a,b)=>Number(b)-Number(a)));
  assert.deepEqual([models.fitsThisComputer,models.tooLargeForThisComputer],[models.models.filter(m=>m.fits!=="no").map(m=>m.id),models.models.filter(m=>m.fits==="no").map(m=>m.id)]);
  const flux=models.models.find(m=>m.id==="flux1-schnell");
  assert.deepEqual([flux.gpuOnly,flux.cpu.fits],[true,false],"FLUX is flagged GPU-only and never fits the CPU");
  assert.deepEqual([models.models.find(m=>m.id==="gpt-oss-120b").reasoning,models.models.find(m=>m.id==="gpt-oss-120b").cpu.needsMemoryMb],[true,61952]);
  assert.ok(Array.isArray(guide.models.fitsThisComputer)&&guide.steps[2].note.includes("excess-worker import qwen3-4b"));
  assert.notEqual(run("use","flux1-schnell","--cpu").status,0,"a GPU-only model cannot be chosen for the CPU");
  assert.match(JSON.parse(run("use","sd-turbo").stdout).next,/price per image/);
  assert.equal(JSON.parse(run("model-plan").stdout).runtime,"stable-diffusion.cpp");
  assert.equal(JSON.parse(run("guide").stdout).kind,"image");
  assert.deepEqual(models.active,{model:"qwen3-4b",backend:"cpu"});
  const chosen=run("use","qwen3-8b","--gpu");
  assert.notEqual(chosen.status,0,"the packaged Windows profile does not admit unverified Qwen3 8B CUDA execution");
  assert.match(chosen.stderr,/Windows CUDA is available only for the verified Qwen3 4B profile/);
  assert.deepEqual(JSON.parse(run("models").stdout).active,{model:"sd-turbo",backend:"cpu"},"refused GPU selection leaves the configured model unchanged");
  assert.equal(JSON.parse(run("model-plan").stdout).backend,"cpu","the plan follows the unchanged CPU policy");
  assert.notEqual(run("use","not-a-model").status,0);
  assert.equal(run("use","qwen3-4b").status,0);
  assert.match(guide.disclosure,/see their prompts and outputs/);
  assert.deepEqual(JSON.parse(run("offer").stdout).offers,[]);
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
    let timedOut=false,spawnError;
    const timer=setTimeout(()=>{timedOut=true;child.kill();},60000);
    child.on("error",error=>{spawnError=error;});
    child.on("close",status=>{
      clearTimeout(timer);
      if(timedOut)reject(Error("worker command timed out"));
      else if(spawnError)reject(spawnError);
      else resolve({status,stdout,stderr});
    });
  });
  const priced=await runAsync("offer","TEST","3");
  assert.equal(priced.status,0,priced.stderr);
  assert.deepEqual(JSON.parse(priced.stdout).offer,{assetId,netUnits:"3"},"3 TEST per million tokens is 3 base units per token at 6 decimals");
  // Below one base unit per token (migration 0042): 2.5 TEST per million tokens is 2.5 base units per token.
  const fractional=await runAsync("offer","TEST","2.5");
  assert.equal(fractional.status,0,fractional.stderr);
  assert.deepEqual(JSON.parse(fractional.stdout).offer,{assetId,netUnits:"2.5"});
  const tooFine=await runAsync("offer","TEST","0.0000001");
  assert.notEqual(tooFine.status,0);assert.match(tooFine.stderr,/more decimal places than the asset supports/);
  guide=JSON.parse(run("guide").stdout);
  assert.deepEqual([guide.next,guide.steps.map(s=>s.done)],["install-model",[true,true,false,true,false]]);
  // A revoked device is paired again after unpair, which the guide names; unpair keeps the old identity in retired/.
  await writeFile(join(workerHome,"status.json"),JSON.stringify({version:1,state:"revoked",reason:"device_revoked_or_unauthorized",deviceId:"PAIRED-FIXTURE",
    activeAttemptId:null,capabilityDigest:null,updatedAt:new Date().toISOString()}));
  guide=JSON.parse(run("guide").stdout);
  assert.deepEqual([guide.next,guide.steps[0].done,guide.steps[0].command],["pair",false,'excess-worker unpair, then excess-worker pair <exchange address> "<device name>"']);
  const unpaired=run("unpair");
  assert.equal(unpaired.status,0,unpaired.stderr);
  assert.equal(JSON.parse(unpaired.stdout).deviceId,"PAIRED-FIXTURE");
  await assert.rejects(readFile(join(workerHome,"identity.json")),{code:"ENOENT"});
  assert.equal((await readdir(join(workerHome,"retired"))).length,1);
});
