import { spawn,execFile,type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { AdapterError } from "./manifest.js";
import { MAX_RUNTIME_BODY_BYTES,runtimeResponseSchema,type RuntimeRequest,type RuntimeControl,type RuntimeResponse } from "./runtime-rpc.js";

const execFileAsync=promisify(execFile);
export async function processRss(pid:number):Promise<number> {
  if(!Number.isSafeInteger(pid)||pid<=0)throw new AdapterError("PROCESS_MONITOR_FAILED");
  if(process.platform==="win32") {
    const powershell=join(process.env.SystemRoot??"C:\\Windows","System32","WindowsPowerShell","v1.0","powershell.exe");
    const result=await execFileAsync(powershell,["-NoLogo","-NoProfile","-NonInteractive","-Command",`[Console]::Write([Diagnostics.Process]::GetProcessById(${pid}).WorkingSet64)`],{windowsHide:true,timeout:3000,maxBuffer:4096});
    if(!/^[0-9]+$/.test(result.stdout.trim()))throw new AdapterError("PROCESS_MONITOR_FAILED");
    return Number(result.stdout.trim());
  }
  const match=(await readFile(`/proc/${pid}/status`,"utf8")).match(/^VmRSS:\s+(\d+)\s+kB$/m);
  if(!match)throw new AdapterError("PROCESS_MONITOR_FAILED");return Number(match[1])*1024;
}
export interface RuntimeSupervision {protocol:"windows-appcontainer-v1";input:string}
export interface ManagedProcess {child:ChildProcess;closed:Promise<void>;alive():boolean;error():AdapterError|null;peakRssBytes():number;nativePid():number|undefined;stop():Promise<void>;
  sendRuntime(message:RuntimeRequest|RuntimeControl):void;onRuntimeFrame(listener:(frame:RuntimeResponse)=>void):void}
// Internal process boundary. The exported adapter supplies only verified fixed paths/args.
export function startNativeProcess(executable:string,args:readonly string[],options:{cwd:string;env:NodeJS.ProcessEnv;maxMemoryBytes:number;supervision?:RuntimeSupervision|undefined}):ManagedProcess {
  const supervised=options.supervision!==undefined;
  if(supervised&&(options.supervision!.protocol!=="windows-appcontainer-v1"||Buffer.byteLength(options.supervision!.input)>65536||/[\r\n]/.test(options.supervision!.input)))throw new AdapterError("RUNTIME_ISOLATION_UNAVAILABLE");
  const child=spawn(executable,[...args],{cwd:options.cwd,env:options.env,windowsHide:true,stdio:[supervised?"pipe":"ignore","pipe","pipe"]});
  let ended=false,fault:AdapterError|null=null,peak=0,sampling=false,monitorFailures=0,stopping:Promise<void>|undefined,monitorTask:Promise<void>|undefined;
  let nativePid=supervised?undefined:child.pid,cleanupOk=false,statusPending="";
  let runtimeFrameListener:((frame:RuntimeResponse)=>void)|undefined;
  let resolveClosed!:()=>void;
  const closed=new Promise<void>(resolve=>{resolveClosed=resolve;});
  // Drain without retaining prompts, model output, paths or bearer credentials.
  child.stderr?.resume();
  if(supervised){
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data",(chunk:string)=>{
      const lines=(statusPending+chunk).split(/\r?\n/);statusPending=lines.pop()??"";
      if(statusPending.length>131072){statusPending="";fault=new AdapterError("RUNTIME_CONTROL_INVALID");void stop().catch(()=>{});return;}
      for(const line of lines){
        if(line.length>131072){fault=new AdapterError("RUNTIME_CONTROL_INVALID");void stop().catch(()=>{});break;}
        try{
          const data=JSON.parse(line) as {type?:unknown;pid?:unknown;peakWorkingSetBytes?:unknown;ok?:unknown;error?:unknown};
          if(data.type==="response"||data.type==="data"||data.type==="end"||data.type==="error"){
            const frame=runtimeResponseSchema.safeParse(data);
            if(!frame.success)throw Error();
            runtimeFrameListener?.(frame.data);continue;
          }
          if(data.type==="started"&&Number.isSafeInteger(data.pid)&&Number(data.pid)>0)nativePid=Number(data.pid);
          else if(data.type==="status"&&typeof data.peakWorkingSetBytes==="number"&&Number.isSafeInteger(data.peakWorkingSetBytes)&&data.peakWorkingSetBytes>=0)peak=Math.max(peak,data.peakWorkingSetBytes);
          else if(data.type==="cleanup"&&data.ok===true)cleanupOk=true;
          if(typeof data.error==="string"&&/^[A-Z_]{1,64}$/.test(data.error))fault=new AdapterError(data.error);
        }catch{fault=new AdapterError("RUNTIME_CONTROL_INVALID");void stop().catch(()=>{});}
      }
    });
    child.stdin?.on("error",()=>{if(!ended&&!stopping)fault=new AdapterError("RUNTIME_CONTROL_FAILED");});
    child.stdin?.write(options.supervision!.input+"\n");
  }else child.stdout?.resume();
  child.once("error",()=>{fault=new AdapterError("RUNTIME_START_FAILED");});
  let killSampler=()=>{};
  child.once("close",code=>{ended=true;clearInterval(timer);killSampler();if(supervised&&!cleanupOk)fault=new AdapterError("RUNTIME_CLEANUP_FAILED");
    else if(supervised&&code!==0&&!fault)fault=new AdapterError(code===124?"RUNTIME_TIMEOUT":"RUNTIME_EXITED");resolveClosed();});
  const stop=():Promise<void>=>stopping??=(async()=>{
    clearInterval(timer);if(ended){killSampler();await monitorTask;if(supervised&&!cleanupOk)throw new AdapterError("RUNTIME_CLEANUP_FAILED");return;}
    if(supervised){
      // EOF is a private parent-death/stop signal. The native helper must reap the
      // job and restore its temporary grants before it reports cleanup and exits.
      child.stdin?.end('{"type":"stop"}\n');
    }else if(child.pid&&process.platform==="win32") {
      const taskkill=join(process.env.SystemRoot??"C:\\Windows","System32","taskkill.exe");
      await execFileAsync(taskkill,["/PID",String(child.pid),"/T","/F"],{windowsHide:true,timeout:5000,maxBuffer:4096}).catch(()=>{child.kill("SIGKILL");});
    } else child.kill("SIGKILL");
    let timeout:NodeJS.Timeout|undefined;
    try {await Promise.race([closed,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new AdapterError("RUNTIME_STOP_TIMEOUT")),5000);})]);}
    finally {clearTimeout(timeout);}
    if(supervised&&!cleanupOk)throw new AdapterError("RUNTIME_CLEANUP_FAILED");
    // Do not orphan the bounded OS-metrics helper during parent-death cleanup.
    killSampler();await monitorTask;
  })();
  const record=(bytes:number)=>{
    peak=Math.max(peak,bytes);
    if(bytes>options.maxMemoryBytes&&!fault){fault=new AdapterError("RUNTIME_MEMORY_LIMIT");void stop().catch(()=>{});}
  };
  const monitorFailed=()=>{if(!ended&&!fault){fault=new AdapterError("PROCESS_MONITOR_FAILED");void stop().catch(()=>{});}};
  let timer:NodeJS.Timeout;
  if(supervised){
    // Job Object limits are enforced by the native helper. Its measured working
    // set is telemetry; job commit counters are not resident-memory evidence.
    timer=setInterval(()=>{},1000);timer.unref();
  }else if(process.platform==="win32"&&child.pid) {
    // One long-lived sampler. Starting PowerShell twice a second took over three seconds per sample on a
    // four-core server that was loading the model, which failed the monitor and killed healthy runtimes.
    const powershell=join(process.env.SystemRoot??"C:\\Windows","System32","WindowsPowerShell","v1.0","powershell.exe");
    const sampler=spawn(powershell,["-NoLogo","-NoProfile","-NonInteractive","-Command",
      // Direct framework calls avoid module discovery in the guardian's minimal environment.
      `$p=[Diagnostics.Process]::GetProcessById(${child.pid}); while(-not $p.HasExited){$p.Refresh();[Console]::Out.WriteLine($p.WorkingSet64);[Threading.Thread]::Sleep(500)}`],
      {windowsHide:true,stdio:["ignore","pipe","ignore"]});
    const startedAt=Date.now();let lastSampleAt=0,pending="";
    sampler.stdout?.setEncoding("utf8");
    sampler.stdout?.on("data",(chunk:string)=>{
      const lines=(pending+chunk).split(/\r?\n/);pending=(lines.pop()??"").slice(-64);
      for(const line of lines)if(/^[0-9]{1,20}$/.test(line.trim())){lastSampleAt=Date.now();record(Number(line.trim()));}
    });
    const samplerClosed=new Promise<void>(resolve=>{sampler.once("close",()=>resolve());sampler.once("error",()=>resolve());});
    killSampler=()=>{if(sampler.exitCode===null&&sampler.signalCode===null)sampler.kill();};
    monitorTask=Promise.race([samplerClosed,new Promise<void>(resolve=>setTimeout(resolve,5000).unref())]);
    // No sample for 15 seconds, or none within 30 seconds of start, fails closed: the memory cap cannot be enforced blind.
    timer=setInterval(()=>{
      if(ended)return;
      const now=Date.now();
      if(lastSampleAt?now-lastSampleAt>15000:now-startedAt>30000)monitorFailed();
    },1000);
  } else timer=setInterval(()=>{
    if(sampling||ended||!child.pid)return;
    sampling=true;
    monitorTask=processRss(child.pid).then(bytes=>{monitorFailures=0;record(bytes);})
      .catch(()=>{if(++monitorFailures>=3)monitorFailed();}).finally(()=>{sampling=false;});
  },500);
  const sendRuntime=(message:RuntimeRequest|RuntimeControl)=>{
    if(!supervised||ended||stopping||!child.stdin?.writable)throw new AdapterError("RUNTIME_CONTROL_FAILED");
    if(message.type==="request"&&Buffer.byteLength(message.body??"")>MAX_RUNTIME_BODY_BYTES)throw new AdapterError("RUNTIME_REQUEST_TOO_LARGE");
    const frame=JSON.stringify(message)+"\n";
    if(Buffer.byteLength(frame)>32*1024*1024)throw new AdapterError("RUNTIME_REQUEST_TOO_LARGE");
    child.stdin.write(frame);
  };
  return {child,closed,alive:()=>!ended&&child.exitCode===null&&child.signalCode===null,error:()=>fault,peakRssBytes:()=>peak,nativePid:()=>nativePid,stop,
    sendRuntime,onRuntimeFrame:listener=>{runtimeFrameListener=listener;}};
}
