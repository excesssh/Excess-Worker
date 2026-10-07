import { createHash,randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { AdapterError } from "./manifest.js";
import type { VerifiedRuntimeInputs } from "./install.js";
import { noLinks } from "./install.js";
import type { RuntimeSupervision } from "./native-process.js";

export interface WindowsRuntimeIsolation {
  executable:string;args:string[];scratch:string;profile:string;supervision:RuntimeSupervision;cleanup():Promise<void>;
}

const execute = promisify(execFile);
async function scratchParent():Promise<string> {
  if(!process.env.LOCALAPPDATA||!process.env.SystemRoot)throw new AdapterError("RUNTIME_ISOLATION_UNAVAILABLE");
  const directory=join(resolve(process.env.LOCALAPPDATA),"EXCESS","runtime-scratch");
  await noLinks(directory);await mkdir(directory,{recursive:true});await noLinks(directory);
  // Protect only the app-owned parent. The helper grants its unique empty session child.
  const command="& { $ErrorActionPreference='Stop'; $p=$env:EXCESS_SCRATCH_DIRECTORY; " +
    "$u=[Security.Principal.WindowsIdentity]::GetCurrent().User; " +
    "$old=[IO.Directory]::GetAccessControl($p); if($old.GetOwner([Security.Principal.SecurityIdentifier]) -ne $u){throw 'SCRATCH_OWNER_DENIED'}; " +
    "$acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); $acl.SetOwner($u); " +
    "foreach($sid in @($u.Value,'S-1-5-18','S-1-5-32-544')) { $id=New-Object Security.Principal.SecurityIdentifier($sid); " +
    "$r=New-Object Security.AccessControl.FileSystemAccessRule($id,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($r) }; " +
    "[IO.Directory]::SetAccessControl($p,$acl) }";
  try {
    await execute(join(process.env.SystemRoot,"System32","WindowsPowerShell","v1.0","powershell.exe"),
      ["-NoProfile","-NonInteractive","-Command",command],{windowsHide:true,timeout:15000,maxBuffer:4096,
        env:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.SystemRoot,EXCESS_SCRATCH_DIRECTORY:directory}});
    await noLinks(directory);return await realpath(directory);
  }catch{throw new AdapterError("RUNTIME_ISOLATION_UNAVAILABLE");}
}

/** The native helper checks and holds every pinned file before granting its unique container access. */
export async function isolateWindowsRuntime(executable:string,args:readonly string[],options:VerifiedRuntimeInputs&{
  maxMemoryBytes:number;maxGpuMemoryBytes?:number;timeoutMs:number;backend:string;port:number;
}):Promise<WindowsRuntimeIsolation> {
  if(process.platform!=="win32"||process.arch!=="x64")throw new AdapterError("RUNTIME_ISOLATION_UNAVAILABLE");
  const gpu=options.backend==="cuda";
  if(options.backend!=="cpu"&&!gpu)throw new AdapterError("GPU_ISOLATION_UNVERIFIED");
  if(gpu&&(!Number.isSafeInteger(options.maxGpuMemoryBytes)||options.maxGpuMemoryBytes!<1024*1024*1024||options.maxGpuMemoryBytes!>32*1024*1024*1024))
    throw new AdapterError("GPU_MEMORY_POLICY_REQUIRED");
  const base=fileURLToPath(new URL("../native/",import.meta.url)),helper=join(base,"ExcessSandbox.exe");
  let helperHash:string;
  try{
    const pin=JSON.parse(await readFile(join(base,"integrity-win32.json"),"utf8")) as {profile?:unknown;sha256?:unknown};
    const hash=createHash("sha256").update(await readFile(helper)).digest("hex");
    if(pin.profile!=="windows-appcontainer-v1"||typeof pin.sha256!=="string"||!/^[0-9a-f]{64}$/.test(pin.sha256)||hash!==pin.sha256)throw Error();
    helperHash=hash;
  }catch{throw new AdapterError("RUNTIME_ISOLATION_UNAVAILABLE");}
  const parent=await scratchParent(),scratch=join(parent,"excess-runtime-"+randomBytes(16).toString("hex"));
  try{await mkdir(scratch);}catch{throw new AdapterError("RUNTIME_ISOLATION_UNAVAILABLE");}
  const cleanup=async()=>{
    if(dirname(resolve(scratch))!==parent||!scratch.startsWith(parent+sep+"excess-runtime-"))throw new AdapterError("RUNTIME_CLEANUP_FAILED");
    await rm(scratch,{recursive:true,force:true});
  };
  try{
    const files=async(items:VerifiedRuntimeInputs["runtimeFiles"])=>Promise.all(items.map(async file=>{
      if(!/^[0-9a-f]{64}$/.test(file.sha256))throw new AdapterError("RUNTIME_ISOLATION_UNAVAILABLE");
      return {path:await realpath(file.path),sha256:file.sha256};
    }));
    const config={executable:await realpath(executable),runtimeRoot:await realpath(options.runtimeRoot),scratchDirectory:scratch,
      runtimeFiles:await files(options.runtimeFiles),modelFiles:await files(options.modelFiles),arguments:[...args],
      relayFile:{path:await realpath(helper),sha256:helperHash},runtimePort:options.port,
      memoryLimitBytes:options.maxMemoryBytes,processLimit:2,timeoutMilliseconds:Math.min(600000,options.timeoutMs+5000),
      ...(gpu?{gpuProfile:"windows-cuda-budget-v1",gpuMemoryLimitBytes:options.maxGpuMemoryBytes}:{})};
    const input=JSON.stringify(config);
    if(Buffer.byteLength(input)>65536)throw new AdapterError("RUNTIME_ISOLATION_UNAVAILABLE");
    return {executable:helper,args:[],scratch,profile:"windows-appcontainer-v1",
      supervision:{protocol:"windows-appcontainer-v1",input},cleanup};
  }catch(error){await cleanup();throw error instanceof AdapterError?error:new AdapterError("RUNTIME_ISOLATION_UNAVAILABLE");}
}
