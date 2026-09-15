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
  let killSampler=()=>{};
  child.once("close",()=>{ended=true;clearInterval(timer);killSampler();resolveClosed();});
  const stop=():Promise<void>=>stopping??=(async()=>{
    clearInterval(timer);if(ended){killSampler();await monitorTask;return;}
    if(child.pid&&process.platform==="win32") {
      const taskkill=join(process.env.SystemRoot??"C:\\Windows","System32","taskkill.exe");
      await execFileAsync(taskkill,["/PID",String(child.pid),"/T","/F"],{windowsHide:true,timeout:5000,maxBuffer:4096}).catch(()=>{child.kill("SIGKILL");});
    } else child.kill("SIGKILL");
    let timeout:NodeJS.Timeout|undefined;
    try {await Promise.race([closed,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new AdapterError("RUNTIME_STOP_TIMEOUT")),5000);})]);}
    finally {clearTimeout(timeout);}
    // Do not orphan the bounded OS-metrics helper during parent-death cleanup.
    killSampler();await monitorTask;
  })();
  const record=(bytes:number)=>{
    peak=Math.max(peak,bytes);
    if(bytes>options.maxMemoryBytes&&!fault){fault=new AdapterError("RUNTIME_MEMORY_LIMIT");void stop().catch(()=>{});}
  };
  const monitorFailed=()=>{if(!ended&&!fault){fault=new AdapterError("PROCESS_MONITOR_FAILED");void stop().catch(()=>{});}};
  let timer:NodeJS.Timeout;
  if(process.platform==="win32"&&child.pid) {
    // One long-lived sampler. Starting PowerShell twice a second took over three seconds per sample on a
    // four-core server that was loading the model, which failed the monitor and killed healthy runtimes.
    const powershell=join(process.env.SystemRoot??"C:\\Windows","System32","WindowsPowerShell","v1.0","powershell.exe");
    const sampler=spawn(powershell,["-NoLogo","-NoProfile","-NonInteractive","-Command",
      `$p=Get-Process -Id ${child.pid} -ErrorAction Stop; while(-not $p.HasExited){$p.Refresh();[Console]::Out.WriteLine($p.WorkingSet64);Start-Sleep -Milliseconds 500}`],
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
  return {child,closed,alive:()=>!ended&&child.exitCode===null&&child.signalCode===null,error:()=>fault,peakRssBytes:()=>peak,stop};
}
