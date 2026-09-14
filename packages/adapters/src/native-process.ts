import { spawn,execFile,type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { AdapterError } from "./manifest.js";

const execFileAsync=promisify(execFile);
export async function processRss(pid:number):Promise<number> {
  if(!Number.isSafeInteger(pid)||pid<=0)throw new AdapterError("PROCESS_MONITOR_FAILED");
  if(process.platform==="win32") {
    const powershell=join(process.env.SystemRoot??"C:\\Windows","System32","WindowsPowerShell","v1.0","powershell.exe");
    const result=await execFileAsync(powershell,["-NoLogo","-NoProfile","-NonInteractive","-Command",`[Console]::Write((Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64)`],{windowsHide:true,timeout:3000,maxBuffer:4096});
    if(!/^[0-9]+$/.test(result.stdout.trim()))throw new AdapterError("PROCESS_MONITOR_FAILED");
    return Number(result.stdout.trim());
  }
  const match=(await readFile(`/proc/${pid}/status`,"utf8")).match(/^VmRSS:\s+(\d+)\s+kB$/m);
  if(!match)throw new AdapterError("PROCESS_MONITOR_FAILED");return Number(match[1])*1024;
}
export interface ManagedProcess {child:ChildProcess;closed:Promise<void>;alive():boolean;error():AdapterError|null;peakRssBytes():number;stop():Promise<void>}
// Internal process boundary. The exported adapter supplies only verified fixed paths/args.
export function startNativeProcess(executable:string,args:readonly string[],options:{cwd:string;env:NodeJS.ProcessEnv;maxMemoryBytes:number}):ManagedProcess {
  const child=spawn(executable,[...args],{cwd:options.cwd,env:options.env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let ended=false,fault:AdapterError|null=null,peak=0,sampling=false,monitorFailures=0,stopping:Promise<void>|undefined,monitorTask:Promise<void>|undefined;
  let resolveClosed!:()=>void;
  const closed=new Promise<void>(resolve=>{resolveClosed=resolve;});
  // Drain without retaining prompts, model output, paths or bearer credentials.
  child.stdout?.resume();child.stderr?.resume();
  child.once("error",()=>{fault=new AdapterError("RUNTIME_START_FAILED");});
  child.once("close",()=>{ended=true;clearInterval(timer);resolveClosed();});
  const stop=():Promise<void>=>stopping??=(async()=>{
    clearInterval(timer);if(ended){await monitorTask;return;}
    if(child.pid&&process.platform==="win32") {
      const taskkill=join(process.env.SystemRoot??"C:\\Windows","System32","taskkill.exe");
      await execFileAsync(taskkill,["/PID",String(child.pid),"/T","/F"],{windowsHide:true,timeout:5000,maxBuffer:4096}).catch(()=>{child.kill("SIGKILL");});
    } else child.kill("SIGKILL");
    let timeout:NodeJS.Timeout|undefined;
    try {await Promise.race([closed,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new AdapterError("RUNTIME_STOP_TIMEOUT")),5000);})]);}
    finally {clearTimeout(timeout);}
    // Do not orphan the bounded OS-metrics helper during parent-death cleanup.
    await monitorTask;
  })();
  const timer=setInterval(()=>{
    if(sampling||ended||!child.pid)return;
    sampling=true;
    monitorTask=processRss(child.pid).then(bytes=>{
      monitorFailures=0;peak=Math.max(peak,bytes);
      if(bytes>options.maxMemoryBytes){fault=new AdapterError("RUNTIME_MEMORY_LIMIT");void stop().catch(()=>{});}
    }).catch(()=>{
      if(!ended&&++monitorFailures>=3){fault=new AdapterError("PROCESS_MONITOR_FAILED");void stop().catch(()=>{});}
    }).finally(()=>{sampling=false;});
  },500);
  return {child,closed,alive:()=>!ended&&child.exitCode===null&&child.signalCode===null,error:()=>fault,peakRssBytes:()=>peak,stop};
}
