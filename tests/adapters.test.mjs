import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn,execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp,mkdir,writeFile,rm,readdir,readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve,join,dirname,basename } from "node:path";
import { requestDigest } from "../packages/protocol/dist/index.js";
import { ARTIFACTS,TEXT_CAPABILITY,capabilityDigest,parseTextRequest,parseTextResult,textInstallationPlan,installTextAdapter,installRuntimeRedist,RUNTIME_REDIST,verifyInstallation,createTextAdapter } from "../packages/adapters/dist/index.js";
import { readSafeZip } from "../packages/adapters/dist/zip.js";
import { boundedJson } from "../packages/adapters/dist/runtime.js";
import { startSupervisedProcess } from "../packages/adapters/dist/process.js";

// These deliberately tiny ZIP/process fixtures are not runtime or hardware evidence.
function fixtureZip(files) {
  const locals=[],central=[];let offset=0;
  for(const [name,content,mode=0x8000] of files) {
    const path=Buffer.from(name),body=Buffer.from(content),local=Buffer.alloc(30),entry=Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(body.length,18);local.writeUInt32LE(body.length,22);local.writeUInt16LE(path.length,26);
    entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt32LE(body.length,20);entry.writeUInt32LE(body.length,24);entry.writeUInt16LE(path.length,28);entry.writeUInt32LE((mode*65536)>>>0,38);entry.writeUInt32LE(offset,42);
    locals.push(local,path,body);central.push(entry,path);offset+=local.length+path.length+body.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,directory,end]);
}
async function temporary(run) {
  const parent=resolve(".cache");await mkdir(parent,{recursive:true});const dir=await mkdtemp(join(parent,"adapter-test-"));
  try{return await run(dir);}finally{assert.equal(dirname(dir),parent);assert.ok(basename(dir).startsWith("adapter-test-"));await rm(dir,{recursive:true,force:true});}
}
test("adapter manifest is immutable, exact and import-only; requests and outputs reject extra control fields",()=>{
  assert.equal(capabilityDigest,requestDigest(TEXT_CAPABILITY));
  assert.equal(TEXT_CAPABILITY.trustClass,"supplier_visible");
  assert.equal(textInstallationPlan(".local/models/qwen3-4b-cpu-v1").downloadBytes,2515700335);
  assert.equal(TEXT_CAPABILITY.model,"Qwen3-4B-Q4_K_M");
  for(const artifact of Object.values(ARTIFACTS)) {
    assert.equal(Object.isFrozen(artifact),true);
    assert.throws(()=>{artifact.url="https://example.com/arbitrary.exe";},TypeError);
    assert.throws(()=>{artifact.sha256="0".repeat(64);},TypeError);
    assert.throws(()=>{artifact.bytes=1;},TypeError);
  }
  assert.deepEqual(parseTextRequest({prompt:"hello",maxTokens:8,seed:42}),{prompt:"hello",maxTokens:8,seed:42});
  assert.equal(parseTextRequest({prompt:"p".repeat(16384),maxTokens:2048,seed:1}).maxTokens,2048);
  for(const input of [{prompt:"hello",maxTokens:2049,seed:1},{prompt:"💡".repeat(4097),maxTokens:8,seed:1},{prompt:"hello",maxTokens:8,seed:1,command:"calc.exe"},{prompt:"hello",maxTokens:8,seed:2147483648}])assert.throws(()=>parseTextRequest(input),/INVALID_TEXT_REQUEST/);
  assert.deepEqual(parseTextResult({text:"ready",generatedTokens:1,finishReason:"stop"}),{text:"ready",generatedTokens:1,finishReason:"stop"});
  assert.equal(parseTextResult({text:"x".repeat(65536),generatedTokens:2048,finishReason:"length"}).generatedTokens,2048);
  for(const input of [{text:"",generatedTokens:0,finishReason:"stop"},{text:"x",generatedTokens:2049,finishReason:"stop"},{text:"x".repeat(65537),generatedTokens:1,finishReason:"stop"},{text:"x",generatedTokens:1,finishReason:"unknown"},{text:"x",generatedTokens:1,finishReason:"stop",url:"file:///secret"}])assert.throws(()=>parseTextResult(input),/INVALID_TEXT_RESULT/);
});
test("reviewed ZIP reader rejects traversal, Windows aliases, links, duplicate names and oversized expansion",()=>{
  const valid=readSafeZip(fixtureZip([["llama-server.exe","FAKE FIXTURE"],["lib/ggml.dll","FAKE DLL FIXTURE"]]));
  assert.deepEqual(valid.map(e=>e.name),["llama-server.exe","lib/ggml.dll"]);
  for(const name of ["../outside.exe","/absolute.exe","C:/absolute.exe","foo\\bar.dll","foo/../bar.dll","CON.dll","foo./bar.dll","foo:stream"])assert.throws(()=>readSafeZip(fixtureZip([[name,"x"]])),/UNSAFE_RUNTIME_ARCHIVE/);
  assert.throws(()=>readSafeZip(fixtureZip([["a.dll","x"],["A.dll","y"]])),/UNSAFE_RUNTIME_ARCHIVE/);
  assert.throws(()=>readSafeZip(fixtureZip([["link.dll","target",0xa000]])),/UNSAFE_RUNTIME_ARCHIVE/);
  const huge=fixtureZip([["file.dll","x"]]);const central=huge.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));huge.writeUInt32LE(129*1024*1024,central+24);
  assert.throws(()=>readSafeZip(huge),/UNSAFE_RUNTIME_ARCHIVE/);
  assert.throws(()=>readSafeZip(Buffer.from("not a zip")),/UNSAFE_RUNTIME_ARCHIVE/);
});
test("installer fails before download without consent and rejects corrupt local artifacts",async()=>temporary(async dir=>{
  await assert.rejects(installTextAdapter(join(dir,"absent"),{consent:false}),/MODEL_INSTALL_CONSENT_REQUIRED/);
  await assert.rejects(verifyInstallation(join(dir,"absent")),/ADAPTER_NOT_INSTALLED_OR_CORRUPT/);
  await mkdir(join(dir,"runtimes","cpu"),{recursive:true});
  await writeFile(join(dir,"runtimes","cpu","runtime.zip"),"FAKE CORRUPT ARCHIVE");
  await assert.rejects(verifyInstallation(dir),/INSTALLED_ARTIFACT_MISMATCH/);
  const adapter=createTextAdapter(dir,{threads:1,maxMemoryMb:1024,timeoutMs:2000});
  await assert.rejects(adapter.probe(),/INSTALLED_ARTIFACT_MISMATCH|UNSUPPORTED_ADAPTER_PLATFORM/);
  await adapter.stop();await adapter.stop();
}));
test("Visual C++ runtime files are copied beside the server only with their pinned bytes",async t=>temporary(async dir=>{
  const system32=join(process.env.SystemRoot??"C:\\Windows","System32");
  const runtime=join(dir,"runtimes","cpu","runtime");await mkdir(runtime,{recursive:true});
  // A source with the wrong bytes is refused and leaves nothing in the runtime folder.
  const forged=join(dir,"forged");await mkdir(forged);
  for(const file of RUNTIME_REDIST)await writeFile(join(forged,file.name),"NOT THE PINNED DLL");
  await assert.rejects(installRuntimeRedist(dir,"cpu",forged),/REDIST_FILE_MISMATCH/);
  await assert.rejects(installRuntimeRedist(dir,"cpu",join(dir,"absent")),/REDIST_FILE_MISMATCH/);
  assert.deepEqual(await readdir(runtime),[]);
  const pinned=await Promise.all(RUNTIME_REDIST.map(async file=>{try{return createHash("sha256").update(await readFile(join(system32,file.name))).digest("hex")===file.sha256;}catch{return false;}}));
  if(pinned.includes(false)){t.diagnostic("this machine lacks the pinned Visual C++ runtime; copy path not exercised");return;}
  assert.deepEqual(await installRuntimeRedist(dir,"cpu",system32),RUNTIME_REDIST.map(file=>file.name));
  assert.deepEqual((await readdir(runtime)).sort(),RUNTIME_REDIST.map(file=>file.name).sort());
  assert.deepEqual(await installRuntimeRedist(dir,"cpu",forged),[],"files already pinned are kept without reading the source");
}));
test("runtime response reader rejects overlong, malformed and invalid UTF-8 responses",async()=>{
  assert.deepEqual(await boundedJson(new Response('{"ok":true}')),{ok:true});
  await assert.rejects(boundedJson(new Response("x".repeat(100)),32),/RUNTIME_RESPONSE_TOO_LARGE/);
  await assert.rejects(boundedJson(new Response("not json")),/RUNTIME_RESPONSE_INVALID/);
  await assert.rejects(boundedJson(new Response(Uint8Array.from([0xff,0xfe]))),/RUNTIME_RESPONSE_INVALID/);
  await assert.rejects(boundedJson(new Response("{}",{status:500})),/RUNTIME_RESPONSE_FAILED/);
});
test("fake process supervision reaps its process on explicit stop and observed RSS overflow",async()=>{
  for(const budget of [1024*1024*1024,1]) {
    const processFixture=startSupervisedProcess(process.execPath,["-e","setInterval(()=>{},1000)"],{cwd:resolve("."),env:process.env,maxMemoryBytes:budget});
    try {
      await once(processFixture.child,"spawn");
      if(budget>1) {assert.equal(processFixture.alive(),true);await processFixture.stop();}
      else {
        let timeout;try{await Promise.race([processFixture.closed,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error("FAKE PROCESS MEMORY MONITOR TIMEOUT")),12000);})]);}finally{clearTimeout(timeout);}
        assert.equal(processFixture.error()?.code,"RUNTIME_MEMORY_LIMIT");assert.ok(processFixture.peakRssBytes()>1);
      }
      assert.equal(processFixture.alive(),false);await processFixture.stop();
    } finally {await processFixture.stop();}
  }
});
test("hard-killing a fake adapter parent closes its guardian IPC and reaps the fake native process",async()=>temporary(async dir=>{
  const script=join(dir,"fake-adapter-parent.mjs");
  const moduleUrl=pathToFileURL(resolve("packages/adapters/dist/process.js")).href;
  await writeFile(script,`import {startSupervisedProcess} from ${JSON.stringify(moduleUrl)};
const runtime=startSupervisedProcess(process.execPath,["-e","setInterval(()=>{},1000)"],{cwd:process.cwd(),env:process.env,maxMemoryBytes:1073741824});
runtime.child.on("message",message=>{if(message.type==="started")process.send({nativePid:message.pid,guardianPid:runtime.child.pid});});
setInterval(()=>{},1000);
`);
  const parent=spawn(process.execPath,[script],{cwd:resolve("."),windowsHide:true,stdio:["ignore","ignore","ignore","ipc"]});
  let pids;
  const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==="ESRCH")return false;throw error;}};
  try {
    let timer;try{[pids]=await Promise.race([once(parent,"message"),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("FAKE ADAPTER PARENT START TIMEOUT")),10000);})]);}finally{clearTimeout(timer);}
    assert.ok(Number.isSafeInteger(pids.nativePid)&&pids.nativePid>0);assert.ok(alive(pids.nativePid));assert.ok(alive(pids.guardianPid));
    const exited=once(parent,"exit");parent.kill("SIGKILL");await exited;
    for(let i=0;i<100&&(alive(pids.nativePid)||alive(pids.guardianPid));i++)await delay(100);
    assert.equal(alive(pids.nativePid),false,"fake native process must not outlive killed parent");
    assert.equal(alive(pids.guardianPid),false,"guardian must exit after reaping native process");
  } finally {
    if(parent.exitCode===null&&parent.signalCode===null)parent.kill("SIGKILL");
    if(pids&&alive(pids.guardianPid)) {
      if(process.platform==="win32")await promisify(execFile)(join(process.env.SystemRoot??"C:\\Windows","System32","taskkill.exe"),["/PID",String(pids.guardianPid),"/T","/F"],{windowsHide:true,timeout:5000,maxBuffer:4096}).catch(()=>{});
      else {try{process.kill(-pids.guardianPid,"SIGKILL");}catch{}}
    }
  }
}));
