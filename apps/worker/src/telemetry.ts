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
/** Sensor readings outside 1-150 C come from absent or broken sensors and are ignored. */
const plausibleCelsius = (value: number) => Number.isFinite(value) && value >= 1 && value <= 150;
/** The hottest reading in degrees Celsius among sensors whose names match, from a sysfs hwmon tree. */
async function hwmonMaximum(root: string, names: ReadonlySet<string>): Promise<number | null> {
  let devices: string[];
  try { devices = await readdir(root); } catch { return null; }
  let hottest: number | null = null;
  for (const device of devices.slice(0, 64)) {
    const name = await readFile(join(root, device, "name"), "utf8").then(text => text.trim(), () => "");
    if (!names.has(name)) continue;
    let files: string[];
    try { files = (await readdir(join(root, device))).filter(file => /^temp[0-9]{1,2}_input$/.test(file)).slice(0, 64); } catch { continue; }
    for (const file of files) {
      const value = Number((await readFile(join(root, device, file), "utf8").catch(() => "")).trim()) / 1000;
      if (plausibleCelsius(value)) hottest = Math.max(hottest ?? value, value);
    }
  }
  return hottest;
}
/** Linux CPU and GPU temperatures from hwmon: Intel coretemp, AMD k10temp/zenpower, ARM cpu_thermal and AMD GPUs; the CPU
 * falls back to the thermal zones the kernel labels as the CPU package, then to the ACPI zone. */
export async function linuxTemperatures(hwmon = "/sys/class/hwmon", thermal = "/sys/class/thermal"): Promise<{ cpuTempC: number | null; gpuTempC: number | null }> {
  let cpuTempC = await hwmonMaximum(hwmon, new Set(["coretemp", "k10temp", "zenpower", "cpu_thermal", "cpu-thermal", "soc_thermal"]));
  const gpuTempC = await hwmonMaximum(hwmon, new Set(["amdgpu", "radeon", "nouveau"]));
  if (cpuTempC === null) {
    let zones: string[] = [];
    try { zones = (await readdir(thermal)).filter(zone => zone.startsWith("thermal_zone")).slice(0, 64); } catch { /* No thermal zones. */ }
    const readings: { type: string; value: number }[] = [];
    for (const zone of zones) {
      const type = await readFile(join(thermal, zone, "type"), "utf8").then(text => text.trim(), () => "");
      const value = Number((await readFile(join(thermal, zone, "temp"), "utf8").catch(() => "")).trim()) / 1000;
      if (plausibleCelsius(value)) readings.push({ type, value });
    }
    const hottest = (match: (type: string) => boolean) => readings.filter(item => match(item.type)).reduce<number | null>((max, item) => Math.max(max ?? item.value, item.value), null);
    cpuTempC = hottest(type => /^(x86_pkg_temp|cpu[-_]thermal|soc[-_]thermal|cpu|tcpu)$/i.test(type)) ?? hottest(type => type === "acpitz");
  }
  return { cpuTempC, gpuTempC };
}
/** The hottest NVIDIA GPU in degrees Celsius, or null without the NVIDIA driver's utility. */
export async function nvidiaTemperature(run: typeof execute = execute): Promise<number | null> {
  try {
    const { stdout } = await run("nvidia-smi", ["--query-gpu=temperature.gpu", "--format=csv,noheader,nounits"], { windowsHide: true, timeout: 5000, maxBuffer: 4096 });
    const values = String(stdout).split(/\r?\n/).map(line => Number(line.trim())).filter(plausibleCelsius);
    return values.length ? Math.max(...values) : null;
  } catch { return null; }
}
// Windows exposes CPU temperature to ordinary users only through the ACPI thermal-zone performance counters, which many
// desktops lack; the value is in tenths of a kelvin.
const windowsThermalScript = `$v = Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_ThermalZoneInformation -ErrorAction SilentlyContinue |
  ForEach-Object { $_.HighPrecisionTemperature / 10 - 273.15 } | Measure-Object -Maximum
if ($v.Count) { [Console]::Write($v.Maximum.ToString([Globalization.CultureInfo]::InvariantCulture)) }`;
async function windowsCpuTemperature(): Promise<number | null> {
  try {
    const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsThermalScript], { windowsHide: true, timeout: 5000, maxBuffer: 4096 });
    const value = Number(stdout.trim());
    return stdout.trim() && plausibleCelsius(value) ? value : null;
  } catch { return null; }
}
/** Sensors are read at most every 10 seconds, in the background after the first reading so a slow utility never delays
 * the resource loop. A source that answered nothing (no NVIDIA utility, no Windows thermal zone) is not asked again for
 * 10 minutes, since each Windows and NVIDIA reading starts a process. */
let thermal: { at: number; cpuTempC: number | null; gpuTempC: number | null } = { at: 0, cpuTempC: null, gpuTempC: null };
let refreshing: Promise<void> | null = null;
const missingUntil = { nvidia: 0, windows: 0 };
async function refreshTemperatures(): Promise<void> {
  const now = Date.now();
  let local: { cpuTempC: number | null; gpuTempC: number | null } = { cpuTempC: null, gpuTempC: null };
  if (process.platform === "linux") local = await linuxTemperatures();
  else if (process.platform === "win32" && now >= missingUntil.windows) {
    local.cpuTempC = await windowsCpuTemperature();
    if (local.cpuTempC === null) missingUntil.windows = now + 600000;
  }
  let nvidia: number | null = null;
  if (now >= missingUntil.nvidia) {
    nvidia = await nvidiaTemperature();
    if (nvidia === null) missingUntil.nvidia = now + 600000;
  }
  const gpuTempC = local.gpuTempC === null ? nvidia : nvidia === null ? local.gpuTempC : Math.max(local.gpuTempC, nvidia);
  thermal = { at: Date.now(), cpuTempC: local.cpuTempC, gpuTempC };
}
export async function observeTemperatures(): Promise<{ cpuTempC: number | null; gpuTempC: number | null }> {
  if (Date.now() - thermal.at >= 10000 && !refreshing) refreshing = refreshTemperatures().catch(() => {}).finally(() => { refreshing = null; });
  if (thermal.at === 0 && refreshing) await refreshing;
  return { cpuTempC: thermal.cpuTempC, gpuTempC: thermal.gpuTempC };
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
  return {freeMemoryMb:Math.floor(os.freemem()/1048576),idleSeconds,onBattery,...await observeTemperatures()};
}
