import { execFile,fork,type ChildProcess,type ForkOptions } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { AdapterError } from "./manifest.js";
export { processRss } from "./native-process.js";
export interface ManagedProcess {child:ChildProcess;closed:Promise<void>;alive():boolean;error():AdapterError|null;peakRssBytes():number;nativePid():number|undefined;stop():Promise<void>}
const execFileAsync=promisify(execFile);
// The private guardian owns the native process. Parent IPC loss is a shutdown,
// including when a worker is killed without executing its own finally handlers.
export function startSupervisedProcess(executable:string,args:readonly string[],options:{cwd:string;env:NodeJS.ProcessEnv;maxMemoryBytes:number}):ManagedProcess {
  const systemRoot=process.env.SystemRoot??"C:\\Windows";
  const forkOptions:ForkOptions&{windowsHide:boolean}={execArgv:[],windowsHide:true,
    detached:process.platform!=="win32",env:{SystemRoot:systemRoot,WINDIR:systemRoot,PATH:join(systemRoot,"System32")},stdio:["ignore","ignore","ignore","ipc"]};
  const child=fork(fileURLToPath(new URL("./process-helper.js",import.meta.url)),[],forkOptions);
  let ended=false,fault:AdapterError|null=null,peak=0,pid:number|undefined,stopping:Promise<void>|undefined;
  let resolveClosed!:()=>void;const closed=new Promise<void>(resolve=>{resolveClosed=resolve;});
  child.once("error",()=>{fault=new AdapterError("RUNTIME_GUARDIAN_FAILED");});
  child.once("close",()=>{ended=true;resolveClosed();});
  child.on("message",(message:unknown)=>{
    if(!message||typeof message!=="object")return;
    const data=message as {type?:string;pid?:number;peakRssBytes?:number;error?:string};
    if(data.type==="started"&&Number.isSafeInteger(data.pid)&&data.pid!>0)pid=data.pid;
    if(data.type==="status"){
      if(typeof data.peakRssBytes==="number"&&Number.isFinite(data.peakRssBytes))peak=Math.max(peak,data.peakRssBytes);
      if(data.error&&/^[A-Z_]{1,64}$/.test(data.error))fault=new AdapterError(data.error);
    }
  });
  child.send({type:"start",executable,args:[...args],options},error=>{if(error)fault=new AdapterError("RUNTIME_GUARDIAN_FAILED");});
  const stop=():Promise<void>=>stopping??=(async()=>{
    if(ended)return;
    if(child.connected)child.send({type:"stop"},()=>{});
    let timeout:NodeJS.Timeout|undefined;
    const graceful=await Promise.race([closed.then(()=>true),new Promise<false>(resolve=>{timeout=setTimeout(()=>resolve(false),6000);})]);clearTimeout(timeout);
    if(graceful)return;
    // Kill the still-live guardian tree, not a previously observed/reusable native PID.
    if(child.pid&&process.platform==="win32")await execFileAsync(join(systemRoot,"System32","taskkill.exe"),["/PID",String(child.pid),"/T","/F"],{windowsHide:true,timeout:5000,maxBuffer:4096}).catch(()=>{});
    else if(child.pid){try{process.kill(-child.pid,"SIGKILL");}catch{/* Already exited. */}}
    try{await Promise.race([closed,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new AdapterError("RUNTIME_STOP_TIMEOUT")),5000);})]);}finally{clearTimeout(timeout);}
  })();
  return {child,closed,alive:()=>!ended&&child.exitCode===null&&child.signalCode===null,error:()=>fault,peakRssBytes:()=>peak,nativePid:()=>pid,stop};
}
