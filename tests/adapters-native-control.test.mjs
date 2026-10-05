import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startSupervisedProcess } from "../packages/adapters/dist/process.js";

// This fixture exercises the guardian protocol, not Windows kernel isolation.
const fixture=`
import {createInterface} from 'node:readline';
import {spawn} from 'node:child_process';
const lines=createInterface({input:process.stdin});
let native,closing=false;
function emit(value){process.stdout.write(JSON.stringify(value)+'\\n');}
function stop(){
 if(closing)return;closing=true;
 if(!native)return process.exit(1);
 native.once('close',()=>{if(process.env.FIXTURE_CLEANUP==='yes')emit({type:'cleanup',ok:true});process.stdout.end(()=>process.exit(0));});
 native.kill();
}
lines.on('line',line=>{
 if(!native){JSON.parse(line);native=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 emit({type:'started',pid:native.pid});emit({type:'status',peakWorkingSetBytes:123456,peakJobCommitBytes:987654});}
 else if(line==='{"type":"stop"}')stop();else process.exit(2);
});
lines.on('close',stop);
`;

for(const cleanup of [true,false])test(`native control fixture ${cleanup?"reaps before successful cleanup":"fails closed without cleanup acknowledgement"}`,async()=>{
 const runtime=startSupervisedProcess(process.execPath,["--input-type=module","-e",fixture],{
   cwd:resolve("."),env:{...process.env,FIXTURE_CLEANUP:cleanup?"yes":"no"},maxMemoryBytes:1073741824,
   supervision:{protocol:"windows-appcontainer-v1",input:JSON.stringify({fixture:true})},
 });
 try{
  const deadline=Date.now()+10000;
  while((!runtime.nativePid()||runtime.peakRssBytes()!==123456)&&Date.now()<deadline)await delay(25);
  assert.ok(runtime.nativePid()&&runtime.nativePid()!==runtime.child.pid,"reports native child rather than guardian PID");
  assert.equal(runtime.peakRssBytes(),123456,"commit accounting is not reported as working set");
  const pid=runtime.nativePid();
  if(cleanup)await runtime.stop();else await assert.rejects(runtime.stop(),/RUNTIME_CLEANUP_FAILED/);
  assert.equal(runtime.alive(),false);
  assert.throws(()=>process.kill(pid,0),"native fixture has been reaped");
 }finally{await runtime.stop().catch(()=>{});}
});
