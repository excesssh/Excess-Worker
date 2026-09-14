import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ResourceObservation } from "./policy.js";
const execute=promisify(execFile);
// Session-local elapsed input time only. No key, mouse, window, process or
// screen contents are collected. Unsupported/session-zero observations fail closed.
const idleScript=`Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ExcessIdle {
  [StructLayout(LayoutKind.Sequential)] struct LastInput { public uint size; public uint tick; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput value);
  [DllImport("kernel32.dll")] static extern uint GetTickCount();
  public static double Seconds() {
    if (!Environment.UserInteractive) return -1;
    LastInput value = new LastInput(); value.size = (uint)Marshal.SizeOf(value);
    if (!GetLastInputInfo(ref value)) return -1;
    uint elapsed = unchecked(GetTickCount() - value.tick);
    if (elapsed > 86400000) return -1;
    return elapsed / 1000.0;
  }
}
'@
[Console]::Write([ExcessIdle]::Seconds().ToString([Globalization.CultureInfo]::InvariantCulture))`;
export async function observeLocalResources():Promise<ResourceObservation> {
  let idleSeconds:number|null=null;
  if(process.platform==="win32") {
    try {
      const {stdout}=await execute("powershell.exe",["-NoProfile","-NonInteractive","-Command",idleScript],
        {windowsHide:true,timeout:3000,maxBuffer:4096});
      const value=Number(stdout.trim());
      if(stdout.trim() && Number.isFinite(value) && value>=0 && value<=86400) idleSeconds=value;
    } catch { /* Unknown idle time never implies permission to execute. */ }
  }
  return {freeMemoryMb:Math.floor(os.freemem()/1048576),idleSeconds};
}
