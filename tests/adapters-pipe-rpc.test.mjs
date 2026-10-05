import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startSupervisedProcess } from "../packages/adapters/dist/process.js";
import { readLlamaStream } from "../packages/adapters/dist/stream.js";

// Synthetic pipe endpoint: verifies codecs/backpressure, never hardware evidence.
const fixture=`
import {createInterface} from 'node:readline';
const lines=createInterface({input:process.stdin});let configured=false,active,part=0;
const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const event=value=>'data: '+JSON.stringify(value)+'\\n\\n';
const chunks=[event({content:'one',tokens:[7,8,9,10,11,12,13,14],stop:false,tokens_predicted:8}),event({content:' two',tokens:[15,16,17,18,19,20,21,22],stop:false,tokens_predicted:16}),
event({content:'',tokens:[],stop:true,tokens_predicted:16,stop_type:'eos',truncated:false})];
lines.on('line',line=>{
 const message=JSON.parse(line);
 if(!configured){configured=true;emit({type:'started',pid:process.pid});return;}
 if(message.type==='stop'){emit({type:'cleanup',ok:true});process.stdout.end(()=>process.exit(0));return;}
 if(message.type==='request'){
  if(active)return emit({type:'error',id:message.id,error:'RUNTIME_BUSY'});
  active=message;part=0;
  emit({type:'response',id:active.id,status:200,headers:{'content-type':active.path==='/completion'?'text/event-stream':'application/json'}});
 }else if(message.type==='cancel'){
  if(active?.id===message.id){active=undefined;setTimeout(()=>emit({type:'error',id:message.id,error:'RUNTIME_REQUEST_ABORTED'}),100);}
 }else if(message.type==='next'&&active?.id===message.id){
  if(process.env.RPC_FIXTURE_MODE==='bad-base64'){emit({type:'data',id:active.id,data:'***'});return;}
  const bodies=active.path==='/completion'?chunks:['{"status":"ok"}'];
  if(part<bodies.length){emit({type:'status',peakWorkingSetBytes:++part});emit({type:'data',id:active.id,data:Buffer.from(bodies[part-1]).toString('base64')});}
  else{emit({type:'end',id:active.id});active=undefined;}
 }
});
lines.on('close',()=>{emit({type:'cleanup',ok:true});process.stdout.end(()=>process.exit(0));});
`;
async function withRuntime(run,mode="valid"){
 const runtime=startSupervisedProcess(process.execPath,["--input-type=module","-e",fixture],{cwd:resolve("."),env:{...process.env,RPC_FIXTURE_MODE:mode},
   maxMemoryBytes:1073741824,supervision:{protocol:"windows-appcontainer-v1",input:'{"fixture":true}'}});
 try{await run(runtime);}finally{await runtime.stop();}
}

test("pipe RPC retains streaming tokens and applies caller acknowledgement backpressure",async()=>withRuntime(async runtime=>{
 const response=await runtime.request("/completion",{method:"POST",body:"{}"});
 let release,entered;const started=new Promise(resolve=>{entered=resolve;}),hold=new Promise(resolve=>{release=resolve;});
 const received=[];
 const result=readLlamaStream(response,16,async chunk=>{received.push(chunk.delta);if(received.length===1){entered();await hold;}});
 await started;await delay(300);
 assert.equal(runtime.peakRssBytes(),1,"relay reads no later chunk while caller acknowledgement is pending");
 release();
 assert.deepEqual(await result,{text:"one two",generatedTokens:16,finishReason:"stop"});
 assert.deepEqual(received,["one"," two"]);
}));

test("pipe RPC abort waits for the native terminal frame before admitting another request",async()=>withRuntime(async runtime=>{
 const controller=new AbortController(),response=await runtime.request("/health",{signal:controller.signal});
 controller.abort();
 await assert.rejects(response.text(),/RUNTIME_REQUEST_ABORTED/);
 await assert.rejects(runtime.request("/health"),/RUNTIME_BUSY/);
 await delay(200);
 const next=await runtime.request("/health");assert.deepEqual(await next.json(),{status:"ok"});
}));

test("pipe RPC rejects malformed encoded body bytes",async()=>withRuntime(async runtime=>{
 const response=await runtime.request("/health");await assert.rejects(response.text(),/RUNTIME_CONTROL_INVALID/);
},"bad-base64"));

test("pipe RPC refuses routes, methods and oversized requests before sending native input",async()=>withRuntime(async runtime=>{
 await assert.rejects(runtime.request("http://example.invalid/"),/RUNTIME_REQUEST_INVALID/);
 await assert.rejects(runtime.request("/health",{method:"DELETE"}),/RUNTIME_REQUEST_INVALID/);
 await assert.rejects(runtime.request("/completion",{method:"POST",body:"x".repeat(16*1024*1024+1)}),/RUNTIME_REQUEST_TOO_LARGE/);
 assert.deepEqual(await (await runtime.request("/health")).json(),{status:"ok"});
}));
