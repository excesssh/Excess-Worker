import { execFile,fork,type ChildProcess,type ForkOptions } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { AdapterError } from "./manifest.js";
import type { RuntimeSupervision } from "./native-process.js";
import { MAX_RUNTIME_BODY_BYTES,MAX_RUNTIME_CHUNK_BYTES,MAX_RUNTIME_RESPONSE_BYTES,RUNTIME_PATHS,runtimeResponseSchema,type RuntimeRequest } from "./runtime-rpc.js";
export { processRss } from "./native-process.js";
export interface ManagedProcess {child:ChildProcess;closed:Promise<void>;alive():boolean;error():AdapterError|null;peakRssBytes():number;peakGpuMemoryBytes():number;peakDedicatedGpuMemoryBytes():number;gpuOffloadedLayers():number;nativePid():number|undefined;stop():Promise<void>;request?(path:string,options?:RequestInit):Promise<Response>}
const execFileAsync=promisify(execFile);
// The private guardian owns the native process. Parent IPC loss is a shutdown,
// including when a worker is killed without executing its own finally handlers.
export function startSupervisedProcess(executable:string,args:readonly string[],options:{cwd:string;env:NodeJS.ProcessEnv;maxMemoryBytes:number;supervision?:RuntimeSupervision|undefined}):ManagedProcess {
  const systemRoot=process.env.SystemRoot??"C:\\Windows";
  const forkOptions:ForkOptions&{windowsHide:boolean}={execArgv:[],windowsHide:true,
    detached:process.platform!=="win32",env:{SystemRoot:systemRoot,WINDIR:systemRoot,PATH:join(systemRoot,"System32")},stdio:["ignore","ignore","ignore","ipc"]};
  const child=fork(fileURLToPath(new URL("./process-helper.js",import.meta.url)),[],forkOptions);
  let ended=false,fault:AdapterError|null=null,peak=0,gpuPeak=0,gpuLocalPeak=0,gpuLayers=0,pid:number|undefined,stopping:Promise<void>|undefined;
  let requestId=0;
  type PendingRequest={resolve:(response:Response)=>void;reject:(error:Error)=>void;controller?:ReadableStreamDefaultController<Uint8Array>;bytes:number;
    awaitingChunk:boolean;completePull?:()=>void;removeAbort:()=>void;started:boolean;aborted:boolean};
  const pending=new Map<number,PendingRequest>();
  const finishRequest=(id:number,error?:Error)=>{
    const state=pending.get(id);if(!state)return;
    pending.delete(id);state.removeAbort();
    if(!state.aborted){if(error){state.reject(error);state.controller?.error(error);}else state.controller?.close();}
    state.completePull?.();
  };
  const sendControl=(type:"next"|"cancel",id:number)=>{if(child.connected)child.send({type,id},()=>{});};
  let resolveClosed!:()=>void;const closed=new Promise<void>(resolve=>{resolveClosed=resolve;});
  child.once("error",()=>{fault=new AdapterError("RUNTIME_GUARDIAN_FAILED");});
  child.once("close",()=>{ended=true;for(const id of pending.keys())finishRequest(id,new AdapterError("RUNTIME_EXITED"));resolveClosed();});
  child.on("message",(message:unknown)=>{
    if(!message||typeof message!=="object")return;
    const data=message as {type?:string;pid?:number;peakRssBytes?:number;peakGpuMemoryBytes?:number;peakDedicatedGpuMemoryBytes?:number;gpuOffloadedLayers?:number;error?:string};
    if(data.type==="response"||data.type==="data"||data.type==="end"||data.type==="error"){
      const parsed=runtimeResponseSchema.safeParse(message);
      if(!parsed.success){fault=new AdapterError("RUNTIME_CONTROL_INVALID");void stop().catch(()=>{});return;}
      const frame=parsed.data,state=pending.get(frame.id);
      if(!state)return;
      if(state.aborted){if(frame.type==="end"||frame.type==="error")finishRequest(frame.id);return;}
      try{
        if(frame.type==="response"){
          if(state.started)throw new AdapterError("RUNTIME_CONTROL_INVALID");
          const headers=new Headers();
          for(const [key,value] of Object.entries(frame.headers??{})){
            if(key.toLowerCase()!=="content-type")throw new AdapterError("RUNTIME_CONTROL_INVALID");
            headers.set(key,value);
          }
          const stream=new ReadableStream<Uint8Array>({
            start(controller){state.controller=controller;},
            pull(){
              if(!pending.has(frame.id))return;
              if(state.awaitingChunk)throw new AdapterError("RUNTIME_CONTROL_INVALID");
              state.awaitingChunk=true;
              return new Promise<void>(resolve=>{state.completePull=resolve;sendControl("next",frame.id);});
            },
            cancel(){state.aborted=true;sendControl("cancel",frame.id);state.removeAbort();state.completePull?.();},
          },{highWaterMark:0});
          state.started=true;
          state.resolve(new Response(stream,{status:frame.status,headers}));
        }else if(frame.type==="data"){
          if(!state.started||!state.awaitingChunk||!state.controller)throw new AdapterError("RUNTIME_CONTROL_INVALID");
          const bytes=Buffer.from(frame.data,"base64");
          if(!bytes.length||bytes.length>MAX_RUNTIME_CHUNK_BYTES||bytes.toString("base64")!==frame.data)throw new AdapterError("RUNTIME_CONTROL_INVALID");
          state.bytes+=bytes.length;if(state.bytes>MAX_RUNTIME_RESPONSE_BYTES)throw new AdapterError("RUNTIME_RESPONSE_TOO_LARGE");
          state.awaitingChunk=false;state.controller.enqueue(bytes);state.completePull?.();delete state.completePull;
        }else if(frame.type==="end"){
          if(!state.started)throw new AdapterError("RUNTIME_CONTROL_INVALID");finishRequest(frame.id);
        }else finishRequest(frame.id,new AdapterError(frame.error));
      }catch(error){
        const failure=error instanceof AdapterError?error:new AdapterError("RUNTIME_CONTROL_INVALID");
        sendControl("cancel",frame.id);finishRequest(frame.id,failure);fault=failure;void stop().catch(()=>{});
      }
      return;
    }
    if(data.type==="started"&&Number.isSafeInteger(data.pid)&&data.pid!>0)pid=data.pid;
    if(data.type==="status"){
      if(Number.isSafeInteger(data.pid)&&data.pid!>0)pid=data.pid;
      if(typeof data.peakRssBytes==="number"&&Number.isFinite(data.peakRssBytes))peak=Math.max(peak,data.peakRssBytes);
      if(typeof data.peakGpuMemoryBytes==="number"&&Number.isSafeInteger(data.peakGpuMemoryBytes)&&data.peakGpuMemoryBytes>=0)gpuPeak=Math.max(gpuPeak,data.peakGpuMemoryBytes);
      if(typeof data.peakDedicatedGpuMemoryBytes==="number"&&Number.isSafeInteger(data.peakDedicatedGpuMemoryBytes)&&data.peakDedicatedGpuMemoryBytes>=0)gpuLocalPeak=Math.max(gpuLocalPeak,data.peakDedicatedGpuMemoryBytes);
      if(Number.isSafeInteger(data.gpuOffloadedLayers)&&data.gpuOffloadedLayers!>=0&&data.gpuOffloadedLayers!<=128)gpuLayers=data.gpuOffloadedLayers!;
      if(data.error&&/^[A-Z_]{1,64}$/.test(data.error))fault=new AdapterError(data.error);
    }
  });
  const request=async(path:string,init:RequestInit={}):Promise<Response>=>{
    if(!options.supervision||ended||stopping||!child.connected)throw new AdapterError("RUNTIME_CONTROL_FAILED");
    if(fault)throw fault;
    if(pending.size!==0)throw new AdapterError("RUNTIME_BUSY");
    if(!RUNTIME_PATHS.includes(path as typeof RUNTIME_PATHS[number])||!["GET","POST"].includes(init.method??"GET")||
      (init.body!==undefined&&typeof init.body!=="string"))throw new AdapterError("RUNTIME_REQUEST_INVALID");
    const get=path==="/health"||path==="/v1/models";
    if((init.method??"GET")!==(get?"GET":"POST")||(get&&init.body!==undefined))throw new AdapterError("RUNTIME_REQUEST_INVALID");
    if(Buffer.byteLength(String(init.body??""))>MAX_RUNTIME_BODY_BYTES)throw new AdapterError("RUNTIME_REQUEST_TOO_LARGE");
    init.signal?.throwIfAborted();
    const id=++requestId;if(id>2147483647)throw new AdapterError("RUNTIME_REQUEST_LIMIT");
    return new Promise<Response>((resolve,reject)=>{
      const abort=()=>{
        state.aborted=true;sendControl("cancel",id);state.removeAbort();
        const error=new AdapterError("RUNTIME_REQUEST_ABORTED");state.reject(error);state.controller?.error(error);state.completePull?.();
      };
      const state:PendingRequest={resolve,reject,bytes:0,awaitingChunk:false,started:false,aborted:false,removeAbort:()=>init.signal?.removeEventListener("abort",abort)};
      pending.set(id,state);init.signal?.addEventListener("abort",abort,{once:true});
      const message:RuntimeRequest={type:"request",id,method:(init.method??"GET") as "GET"|"POST",path:path as RuntimeRequest["path"],
        ...(typeof init.body==="string"?{body:init.body}:{})};
      child.send(message,error=>{if(error)finishRequest(id,new AdapterError("RUNTIME_CONTROL_FAILED"));});
    });
  };
  child.send({type:"start",executable,args:[...args],options},error=>{if(error)fault=new AdapterError("RUNTIME_GUARDIAN_FAILED");});
  const stop=():Promise<void>=>stopping??=(async()=>{
    if(ended)return;
    if(child.connected)child.send({type:"stop"},()=>{});
    let timeout:NodeJS.Timeout|undefined;
    const graceful=await Promise.race([closed.then(()=>true),new Promise<false>(resolve=>{timeout=setTimeout(()=>resolve(false),6000);})]);clearTimeout(timeout);
    if(graceful){if(options.supervision&&fault&&["RUNTIME_CLEANUP_FAILED","RUNTIME_STOP_FAILED","RUNTIME_STOP_TIMEOUT"].includes(fault.code))throw fault;return;}
    // Kill the still-live guardian tree, not a previously observed/reusable native PID.
    if(child.pid&&process.platform==="win32")await execFileAsync(join(systemRoot,"System32","taskkill.exe"),["/PID",String(child.pid),"/T","/F"],{windowsHide:true,timeout:5000,maxBuffer:4096}).catch(()=>{});
    else if(child.pid){try{process.kill(-child.pid,"SIGKILL");}catch{/* Already exited. */}}
    try{await Promise.race([closed,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new AdapterError("RUNTIME_STOP_TIMEOUT")),5000);})]);}finally{clearTimeout(timeout);}
    if(options.supervision)throw new AdapterError("RUNTIME_STOP_TIMEOUT");
  })();
  return {child,closed,alive:()=>!ended&&child.exitCode===null&&child.signalCode===null,error:()=>fault,peakRssBytes:()=>peak,peakGpuMemoryBytes:()=>gpuPeak,peakDedicatedGpuMemoryBytes:()=>gpuLocalPeak,gpuOffloadedLayers:()=>gpuLayers,nativePid:()=>pid,stop,
    ...(options.supervision?{request}:{})};
}
