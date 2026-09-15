import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { availableParallelism,totalmem } from "node:os";
import { dirname,join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { TEXT_LIMITS } from "@excess/protocol";
import { AdapterError,DEFAULT_MODEL_ID,catalogEntry,currentPlatform,parseTextRequest,parseTextResult,type Backend,type TextRequest,type TextResult } from "./manifest.js";
import { verifyInstallation } from "./install.js";
import { startSupervisedProcess,type ManagedProcess } from "./process.js";
import { readLlamaStream,type ChunkCallback } from "./stream.js";

export interface AdapterOptions {threads:number;maxMemoryMb:number;timeoutMs:number;modelId?:string;backend?:Backend}
export interface AdapterProbe {ok:true;capabilityDigest:string;backend:Backend;modelId?:string;model:string;runtime:string;threads:number;maxMemoryMb:number;probedAt:string;generatedTokens:number;peakRssMb:number;nativePid?:number;guardianPid?:number}
export interface TextAdapter {readonly supportsStreaming?:true;probe():Promise<AdapterProbe>;execute(request:unknown,options?:{signal?:AbortSignal;onChunk?:ChunkCallback}):Promise<TextResult>;stop():Promise<void>}
const optionsSchema=z.strictObject({threads:z.number().int().min(1).max(64),maxMemoryMb:z.number().int().min(1024).max(262144),timeoutMs:z.number().int().min(1000).max(TEXT_LIMITS.maxRunSeconds*1000),
  modelId:z.string().min(1).max(64).optional(),backend:z.enum(["cpu","cuda","vulkan"]).optional()});
// Internal supervisor state (not re-exported by the adapter package entry point).
// A failed reap retains both its process and rejected barrier: replacement must
// fail closed instead of forgetting a possibly live native process.
export class AdapterProcessState {
  private current:ManagedProcess|undefined;
  private reaping:Promise<void>|undefined;
  get process():ManagedProcess|undefined{return this.current;}
  async ready():Promise<void>{await this.reaping;}
  attach(process:ManagedProcess):void{
    if(this.current||this.reaping)throw new AdapterError("RUNTIME_REPLACEMENT_BLOCKED");
    this.current=process;
  }
  stop():Promise<void>{
    if(this.reaping)return this.reaping;
    const old=this.current;if(!old)return Promise.resolve();
    this.reaping=Promise.resolve().then(()=>old.stop()).then(()=>{
      this.current=undefined;this.reaping=undefined;
    },error=>{throw error instanceof AdapterError?error:new AdapterError("RUNTIME_STOP_FAILED");});
    return this.reaping;
  }
}
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
  const options=parsed.data,entry=catalogEntry(options.modelId??DEFAULT_MODEL_ID),backend:Backend=options.backend??"cpu";
  if(options.threads>availableParallelism()||options.maxMemoryMb*1048576>totalmem())throw new AdapterError("ADAPTER_POLICY_EXCEEDS_MACHINE");
  const processes=new AdapterProcessState();
  let origin="",secret="",busy=false,stopping=new AbortController();
  async function stop():Promise<void> {stopping.abort();await processes.stop();}
  async function ensure(signal:AbortSignal) {
    if(processes.process?.alive())return;
    await processes.stop();signal.throwIfAborted();
    const platform=currentPlatform();
    if(!platform)throw new AdapterError("UNSUPPORTED_ADAPTER_PLATFORM");
    const installed=await verifyInstallation(installDir,entry.id,backend);signal.throwIfAborted();
    // On CPU the whole model lives in system memory; refuse before starting a runtime the memory cap would kill.
    if(backend==="cpu"&&options.maxMemoryMb<entry.minMemoryMb)throw new AdapterError("ADAPTER_MEMORY_BELOW_MODEL_REQUIREMENT");
    const selectedPort=await port();signal.throwIfAborted();secret=randomBytes(32).toString("base64url");origin=`http://127.0.0.1:${selectedPort}`;
    let env:NodeJS.ProcessEnv;
    if(platform==="win32-x64") {
      const systemRoot=process.env.SystemRoot??"C:\\Windows";
      env={SystemRoot:systemRoot,WINDIR:systemRoot,PATH:join(systemRoot,"System32"),LLAMA_API_KEY:secret,OMP_NUM_THREADS:String(options.threads)};
      for(const key of ["TEMP","TMP"])if(process.env[key])env[key]=process.env[key];
    } else {
      // The Linux build loads its shared libraries from the server's own folder.
      env={PATH:"/usr/bin:/bin",LD_LIBRARY_PATH:dirname(installed.serverPath),LLAMA_API_KEY:secret,OMP_NUM_THREADS:String(options.threads)};
      for(const key of ["HOME","TMPDIR"])if(process.env[key])env[key]=process.env[key];
    }
    processes.attach(startSupervisedProcess(installed.serverPath,["--model",installed.modelPath,"--host","127.0.0.1","--port",String(selectedPort),
      "--threads",String(options.threads),"--threads-batch",String(options.threads),"--threads-http","2","--ctx-size",String(entry.capability.contextTokens),
      // GPU builds (CUDA, Vulkan) offload every layer; the CPU build keeps them all on the processor.
      "--parallel","1","--n-gpu-layers",backend==="cpu"?"0":"999","--no-mmap","--no-webui","--no-jinja","--no-cache-prompt","--no-context-shift"],
      {cwd:dirname(installed.serverPath),env,maxMemoryBytes:options.maxMemoryMb*1048576}));
    for(;;) {
      signal.throwIfAborted();if(!processes.process?.alive())throw processes.process?.error()??new AdapterError("RUNTIME_EXITED");
      try {const response=await fetch(origin+"/health",{signal:AbortSignal.any([signal,AbortSignal.timeout(1000)]),redirect:"error"});if(response.ok){await boundedJson(response,4096);return;}await response.body?.cancel();}
      catch(error){if(signal.aborted)throw error;}
      await delay(200,undefined,{signal});
    }
  }
  async function completion(request:TextRequest,signal:AbortSignal,onChunk?:ChunkCallback):Promise<TextResult> {
    const prompt=`<|im_start|>user\n${request.prompt} /no_think<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n`;
    // A maximal prompt tokenizes to at most about one token per byte plus the template.
    const tokens=await boundedJson(await fetch(origin+"/tokenize",{method:"POST",redirect:"error",signal,headers:{"Content-Type":"application/json",Authorization:"Bearer "+secret},body:JSON.stringify({content:prompt,add_special:true,parse_special:true})}),32*TEXT_LIMITS.maxPromptBytes);
    const tokenized=z.object({tokens:z.array(z.number().int().nonnegative()).max(2*TEXT_LIMITS.maxPromptBytes)}).safeParse(tokens);
    if(!tokenized.success||tokenized.data.tokens.length+request.maxTokens>entry.capability.contextTokens)throw new AdapterError("PROMPT_EXCEEDS_CONTEXT");
    const response=await fetch(origin+"/completion",{method:"POST",redirect:"error",signal,headers:{"Content-Type":"application/json",Authorization:"Bearer "+secret},body:JSON.stringify({
      prompt,n_predict:request.maxTokens,seed:request.seed,temperature:0.7,top_p:0.8,top_k:20,min_p:0,presence_penalty:1.5,
      stream:!!onChunk,cache_prompt:false,return_tokens:true,stop:["<|im_end|>","<|endoftext|>"],
      response_fields:["content","tokens","stop_type","truncated",...(onChunk?["stop","tokens_predicted"]:[])],
    })});
    if(onChunk)return readLlamaStream(response,request.maxTokens,onChunk,signal);
    const result=z.object({content:z.string(),tokens:z.array(z.number().int()).max(TEXT_LIMITS.maxOutputTokens),stop_type:z.enum(["eos","limit","word"]),truncated:z.boolean()}).safeParse(await boundedJson(response,16*TEXT_LIMITS.maxOutputBytes));
    if(!result.success||result.data.truncated||result.data.tokens.length>request.maxTokens)throw new AdapterError("INVALID_RUNTIME_RESULT");
    return parseTextResult({text:result.data.content,generatedTokens:result.data.tokens.length,finishReason:result.data.stop_type==="limit"?"length":"stop"});
  }
  async function run(request:TextRequest,external?:AbortSignal,onChunk?:ChunkCallback):Promise<TextResult> {
    if(busy)throw new AdapterError("ADAPTER_BUSY");busy=true;
    if(stopping.signal.aborted)stopping=new AbortController();
    const signal=AbortSignal.any([stopping.signal,AbortSignal.timeout(options.timeoutMs),...(external?[external]:[])]);
    try {
      await processes.ready();
      signal.throwIfAborted();await ensure(signal);return await completion(request,signal,onChunk);
    }
    catch(error) {const fault=processes.process?.error();await stop();if(fault)throw fault;if(error instanceof AdapterError)throw error;throw new AdapterError(signal?.aborted?"ADAPTER_ABORTED_OR_TIMED_OUT":"RUNTIME_EXECUTION_FAILED");}
    finally {busy=false;}
  }
  return {
    supportsStreaming:true,execute:(request,execution={})=>run(parseTextRequest(request),execution.signal,execution.onChunk),stop,
    async probe(){
      const result=await run({prompt:"Reply with the word ready.",maxTokens:8,seed:42});
      const runtime=processes.process;
      const nativePid=runtime?.nativePid(),guardianPid=runtime?.child.pid;
      if(!runtime?.alive()||typeof nativePid!=="number"||!Number.isSafeInteger(nativePid)||nativePid<=0||
        typeof guardianPid!=="number"||!Number.isSafeInteger(guardianPid)||guardianPid<=0){await stop();throw new AdapterError("RUNTIME_DIAGNOSTICS_UNAVAILABLE");}
      return {ok:true,capabilityDigest:entry.capabilityDigest,backend,modelId:entry.id,model:entry.capability.model,runtime:entry.capability.runtime,threads:options.threads,maxMemoryMb:options.maxMemoryMb,
        probedAt:new Date().toISOString(),generatedTokens:result.generatedTokens,peakRssMb:Math.ceil(runtime.peakRssBytes()/1048576),nativePid,guardianPid};
    },
  };
}
