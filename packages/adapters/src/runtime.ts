import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { availableParallelism,totalmem } from "node:os";
import { dirname,join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { AdapterError,TEXT_CAPABILITY,capabilityDigest,parseTextRequest,parseTextResult,type TextRequest,type TextResult } from "./manifest.js";
import { verifyInstallation } from "./install.js";
import { startSupervisedProcess,type ManagedProcess } from "./process.js";
import { readLlamaStream,type ChunkCallback } from "./stream.js";

export interface AdapterOptions {threads:number;maxMemoryMb:number;timeoutMs:number}
export interface AdapterProbe {ok:true;capabilityDigest:string;backend:"cpu";model:string;runtime:string;threads:number;maxMemoryMb:number;probedAt:string;generatedTokens:number;peakRssMb:number;nativePid?:number;guardianPid?:number}
export interface TextAdapter {readonly supportsStreaming?:true;probe():Promise<AdapterProbe>;execute(request:unknown,options?:{signal?:AbortSignal;onChunk?:ChunkCallback}):Promise<TextResult>;stop():Promise<void>}
const optionsSchema=z.strictObject({threads:z.number().int().min(1).max(16),maxMemoryMb:z.number().int().min(1024).max(8192),timeoutMs:z.number().int().min(1000).max(300000)});
async function port():Promise<number> {
  return new Promise((resolve,reject)=>{const server=createServer();server.once("error",reject);server.listen(0,"127.0.0.1",()=>{const address=server.address();if(!address||typeof address==="string")return server.close(()=>reject(new AdapterError("RUNTIME_PORT_FAILED")));server.close(error=>error?reject(error):resolve(address.port));});});
}
export async function boundedJson(response:Response,maxBytes=65536):Promise<unknown> {
  if(!response.ok||!response.body){await response.body?.cancel();throw new AdapterError("RUNTIME_RESPONSE_FAILED");}
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
  try {for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>maxBytes)throw new AdapterError("RUNTIME_RESPONSE_TOO_LARGE");chunks.push(next.value);}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}
  finally {reader.releaseLock();}
  try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw new AdapterError("RUNTIME_RESPONSE_INVALID");}
}
export function createTextAdapter(installDir:string,inputOptions:AdapterOptions):TextAdapter {
  const parsed=optionsSchema.safeParse(inputOptions);
  if(!parsed.success)throw new AdapterError("INVALID_ADAPTER_POLICY");
  const options=parsed.data;
  if(options.threads>availableParallelism()||options.maxMemoryMb*1048576>totalmem())throw new AdapterError("ADAPTER_POLICY_EXCEEDS_MACHINE");
  let runtime:ManagedProcess|undefined,origin="",secret="",busy=false,stopping=new AbortController();
  async function stop():Promise<void> {stopping.abort();const old=runtime;runtime=undefined;await old?.stop();}
  async function ensure(signal:AbortSignal) {
    if(runtime?.alive())return;
    if(process.platform!=="win32"||process.arch!=="x64")throw new AdapterError("UNSUPPORTED_ADAPTER_PLATFORM");
    const installed=await verifyInstallation(installDir);signal.throwIfAborted();
    const selectedPort=await port();signal.throwIfAborted();secret=randomBytes(32).toString("base64url");origin=`http://127.0.0.1:${selectedPort}`;
    const systemRoot=process.env.SystemRoot??"C:\\Windows";
    const env:NodeJS.ProcessEnv={SystemRoot:systemRoot,WINDIR:systemRoot,PATH:join(systemRoot,"System32"),LLAMA_API_KEY:secret,OMP_NUM_THREADS:String(options.threads)};
    for(const key of ["TEMP","TMP"])if(process.env[key])env[key]=process.env[key];
    runtime=startSupervisedProcess(installed.serverPath,["--model",installed.modelPath,"--host","127.0.0.1","--port",String(selectedPort),
      "--threads",String(options.threads),"--threads-batch",String(options.threads),"--threads-http","2","--ctx-size",String(TEXT_CAPABILITY.contextTokens),
      "--parallel","1","--n-gpu-layers","0","--no-mmap","--no-webui","--no-jinja","--no-cache-prompt","--no-context-shift"],
      {cwd:dirname(installed.serverPath),env,maxMemoryBytes:options.maxMemoryMb*1048576});
    for(;;) {
      signal.throwIfAborted();if(!runtime.alive())throw runtime.error()??new AdapterError("RUNTIME_EXITED");
      try {const response=await fetch(origin+"/health",{signal:AbortSignal.any([signal,AbortSignal.timeout(1000)]),redirect:"error"});if(response.ok){await boundedJson(response,4096);return;}await response.body?.cancel();}
      catch(error){if(signal.aborted)throw error;}
      await delay(200,undefined,{signal});
    }
  }
  async function completion(request:TextRequest,signal:AbortSignal,onChunk?:ChunkCallback):Promise<TextResult> {
    const prompt=`<|im_start|>user\n${request.prompt} /no_think<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n`;
    const tokens=await boundedJson(await fetch(origin+"/tokenize",{method:"POST",redirect:"error",signal,headers:{"Content-Type":"application/json",Authorization:"Bearer "+secret},body:JSON.stringify({content:prompt,add_special:true,parse_special:true})}));
    const tokenized=z.object({tokens:z.array(z.number().int().nonnegative()).max(8192)}).safeParse(tokens);
    if(!tokenized.success||tokenized.data.tokens.length+request.maxTokens>TEXT_CAPABILITY.contextTokens)throw new AdapterError("PROMPT_EXCEEDS_CONTEXT");
    const response=await fetch(origin+"/completion",{method:"POST",redirect:"error",signal,headers:{"Content-Type":"application/json",Authorization:"Bearer "+secret},body:JSON.stringify({
      prompt,n_predict:request.maxTokens,seed:request.seed,temperature:0.7,top_p:0.8,top_k:20,min_p:0,presence_penalty:1.5,
      stream:!!onChunk,cache_prompt:false,return_tokens:true,stop:["<|im_end|>","<|endoftext|>"],
      response_fields:["content","tokens","stop_type","truncated",...(onChunk?["stop","tokens_predicted"]:[])],
    })});
    if(onChunk)return readLlamaStream(response,request.maxTokens,onChunk,signal);
    const result=z.object({content:z.string(),tokens:z.array(z.number().int()).max(128),stop_type:z.enum(["eos","limit","word"]),truncated:z.boolean()}).safeParse(await boundedJson(response));
    if(!result.success||result.data.truncated||result.data.tokens.length>request.maxTokens)throw new AdapterError("INVALID_RUNTIME_RESULT");
    return parseTextResult({text:result.data.content,generatedTokens:result.data.tokens.length,finishReason:result.data.stop_type==="limit"?"length":"stop"});
  }
  async function run(request:TextRequest,external?:AbortSignal,onChunk?:ChunkCallback):Promise<TextResult> {
    if(busy)throw new AdapterError("ADAPTER_BUSY");busy=true;
    if(stopping.signal.aborted)stopping=new AbortController();
    const signal=AbortSignal.any([stopping.signal,AbortSignal.timeout(options.timeoutMs),...(external?[external]:[])]);
    try {signal.throwIfAborted();await ensure(signal);return await completion(request,signal,onChunk);}
    catch(error) {const fault=runtime?.error();await stop();if(fault)throw fault;if(error instanceof AdapterError)throw error;throw new AdapterError(signal.aborted?"ADAPTER_ABORTED_OR_TIMED_OUT":"RUNTIME_EXECUTION_FAILED");}
    finally {busy=false;}
  }
  return {
    supportsStreaming:true,execute:(request,execution={})=>run(parseTextRequest(request),execution.signal,execution.onChunk),stop,
    async probe(){
      const result=await run({prompt:"Reply with the word ready.",maxTokens:8,seed:42});
      const nativePid=runtime?.nativePid(),guardianPid=runtime?.child.pid;
      if(!runtime?.alive()||typeof nativePid!=="number"||!Number.isSafeInteger(nativePid)||nativePid<=0||
        typeof guardianPid!=="number"||!Number.isSafeInteger(guardianPid)||guardianPid<=0){await stop();throw new AdapterError("RUNTIME_DIAGNOSTICS_UNAVAILABLE");}
      return {ok:true,capabilityDigest,backend:"cpu",model:TEXT_CAPABILITY.model,runtime:TEXT_CAPABILITY.runtime,threads:options.threads,maxMemoryMb:options.maxMemoryMb,
        probedAt:new Date().toISOString(),generatedTokens:result.generatedTokens,peakRssMb:Math.ceil(runtime.peakRssBytes()/1048576),nativePid,guardianPid};
    },
  };
}
