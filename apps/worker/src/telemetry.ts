import os from "node:os";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
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
  [StructLayout(LayoutKind.Sequential)] struct PowerStatus { public byte acLine; public byte flag; public byte percent; public byte reserved; public int lifeTime; public int fullLifeTime; }
  [DllImport("kernel32.dll")] static extern bool GetSystemPowerStatus(out PowerStatus value);
  // 0 on battery, 1 on AC power, 255 unknown or no battery.
  public static int AcLine() { PowerStatus value; return GetSystemPowerStatus(out value) ? value.acLine : 255; }
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
[Console]::Write([ExcessIdle]::Seconds().ToString([Globalization.CultureInfo]::InvariantCulture) + " " + [ExcessIdle]::AcLine())`;
/** Linux: on battery when a battery exists and no mains supply reports online; null on machines without a battery. */
export async function linuxOnBattery(root = "/sys/class/power_supply"): Promise<boolean | null> {
  let names: string[];
  try { names = await readdir(root); } catch { return null; }
  let battery = false, mains = false;
  for (const name of names.slice(0, 32)) {
    const read = (file: string) => readFile(join(root, name, file), "utf8").then(text => text.trim(), () => "");
    const type = await read("type");
    if (type === "Battery" && (await read("present")) !== "0") battery = true;
    if (type === "Mains" && (await read("online")) === "1") mains = true;
  }
  return battery ? !mains : null;
}
let batteryCache: { at: number; value: boolean | null } = { at: 0, value: null };
export async function observeLocalResources():Promise<ResourceObservation> {
  let idleSeconds:number|null=null,onBattery:boolean|null=null;
  if(process.platform==="win32") {
    try {
      const {stdout}=await execute("powershell.exe",["-NoProfile","-NonInteractive","-Command",idleScript],
        {windowsHide:true,timeout:3000,maxBuffer:4096});
      const [idle="",ac=""]=stdout.trim().split(" "),value=Number(idle);
      if(idle && Number.isFinite(value) && value>=0 && value<=86400) idleSeconds=value;
      onBattery=ac==="0"?true:ac==="1"?false:null;
    } catch { /* Unknown idle time never implies permission to execute. */ }
  } else if(process.platform==="linux") {
    // Power state changes rarely; read it at most every 30 seconds.
    if(Date.now()-batteryCache.at>30000)batteryCache={at:Date.now(),value:await linuxOnBattery()};
    onBattery=batteryCache.value;
  }
  return {freeMemoryMb:Math.floor(os.freemem()/1048576),idleSeconds,onBattery};
}
