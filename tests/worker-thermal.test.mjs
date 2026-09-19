import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {join,resolve} from "node:path";
import {DEFAULT_WORKER_POLICY,THERMAL_STOP_MARGIN_C,parseWorkerPolicy,policyDecision} from "../apps/worker/dist/policy.js";
import {linuxTemperatures,nvidiaTemperature} from "../apps/worker/dist/telemetry.js";

const ready={freeMemoryMb:65536,idleSeconds:3600,onBattery:false};
const cli=(home,...args)=>spawnSync(process.execPath,[resolve("apps/worker/dist/main.js"),...args],{encoding:"utf8",timeout:60000,env:{...process.env,EXCESS_WORKER_HOME:home}});

test("thermal limits: defaults, validation, no new job at the limit, a running job stopped only past the margin, and no sensor never blocks",()=>{
  assert.deepEqual([DEFAULT_WORKER_POLICY.maxCpuTempC,DEFAULT_WORKER_POLICY.maxGpuTempC,THERMAL_STOP_MARGIN_C],[95,85,5]);
  for(const bad of [{maxCpuTempC:49},{maxCpuTempC:101},{maxGpuTempC:80.5},{maxGpuTempC:"85"}])
    assert.throws(()=>parseWorkerPolicy(bad),/must be null \(off\) or a whole number of degrees Celsius from 50 to 100/,JSON.stringify(bad));
  assert.equal(parseWorkerPolicy({maxCpuTempC:null}).maxCpuTempC,null);
  const cpu=parseWorkerPolicy({idleOnly:false}),gpu=parseWorkerPolicy({idleOnly:false,backend:"cuda"});
  assert.deepEqual(policyDecision(cpu,{...ready,cpuTempC:94.6}),{allowed:true,reason:"policy_allows"});
  assert.deepEqual(policyDecision(cpu,{...ready,cpuTempC:95}),{allowed:false,reason:"too_hot",detail:"CPU at 95 C; new jobs wait until it is below 95 C (maxCpuTempC)"});
  assert.equal(policyDecision(cpu,{...ready,cpuTempC:99.9},true).allowed,true,"a running job finishes between the limit and the margin");
  assert.deepEqual(policyDecision(cpu,{...ready,cpuTempC:100},true),{allowed:false,reason:"overheating",
    detail:"CPU at 100 C, 5 C or more over the 95 C limit (maxCpuTempC); the running job was stopped"});
  assert.equal(policyDecision(cpu,{...ready,gpuTempC:99}).allowed,true,"a worker on the CPU backend ignores the GPU");
  assert.deepEqual(policyDecision(gpu,{...ready,cpuTempC:60,gpuTempC:85.2}).reason,"too_hot");
  assert.match(policyDecision(gpu,{...ready,gpuTempC:85.2}).detail,/^GPU at 85 C; new jobs wait until it is below 85 C \(maxGpuTempC\)$/);
  assert.equal(policyDecision(gpu,{...ready,gpuTempC:90},true).reason,"overheating");
  assert.equal(policyDecision(gpu,{...ready,cpuTempC:null,gpuTempC:null}).allowed,true,"no sensor is not a reason to stop");
  assert.equal(policyDecision(gpu,{...ready}).allowed,true,"an observation without temperatures (an older telemetry source) is allowed");
  assert.equal(policyDecision(parseWorkerPolicy({idleOnly:false,backend:"cuda",maxGpuTempC:null}),{...ready,gpuTempC:120}).allowed,true,"a limit turned off");
  assert.equal(policyDecision(cpu,{...ready,cpuTempC:Number.NaN}).allowed,true);
  // Heat is checked after memory, so a machine short of memory still reports that first.
  assert.equal(policyDecision(cpu,{...ready,freeMemoryMb:10,cpuTempC:99}).reason,"memory_headroom");
});

test("Linux sensors: hwmon CPU and AMD GPU readings, the CPU package zone, then the ACPI zone, and broken readings ignored",async()=>{
  await mkdir(".cache",{recursive:true});
  const root=await mkdtemp(resolve(".cache/thermal-"));
  try{
    const hwmon=join(root,"hwmon"),zones=join(root,"thermal");
    const sensor=async(dir,files)=>{await mkdir(dir,{recursive:true});for(const [file,value] of Object.entries(files))await writeFile(join(dir,file),value+"\n");};
    assert.deepEqual(await linuxTemperatures(join(root,"missing"),join(root,"missing")),{cpuTempC:null,gpuTempC:null},"a virtual machine without sensors");
    await sensor(join(zones,"thermal_zone0"),{type:"acpitz",temp:"41000"});
    assert.deepEqual(await linuxTemperatures(hwmon,zones),{cpuTempC:41,gpuTempC:null},"only the ACPI zone");
    await sensor(join(zones,"thermal_zone1"),{type:"x86_pkg_temp",temp:"67500"});
    await sensor(join(zones,"thermal_zone2"),{type:"iwlwifi_1",temp:"90000"});
    assert.deepEqual(await linuxTemperatures(hwmon,zones),{cpuTempC:67.5,gpuTempC:null},"the package zone wins over ACPI; the Wi-Fi card is not the CPU");
    await sensor(join(hwmon,"hwmon0"),{name:"nvme",temp1_input:"99000"});
    await sensor(join(hwmon,"hwmon1"),{name:"coretemp",temp1_input:"72000",temp2_input:"78000",temp3_input:"-273000"});
    await sensor(join(hwmon,"hwmon2"),{name:"amdgpu",temp1_input:"64000",temp2_input:"garbage"});
    assert.deepEqual(await linuxTemperatures(hwmon,zones),{cpuTempC:78,gpuTempC:64},"the hottest core; the disk and broken readings are ignored");
  }finally{await rm(root,{recursive:true,force:true});}
});

test("NVIDIA temperature: the hottest GPU, and null without the utility or with nonsense output",async()=>{
  const reply=stdout=>async()=>({stdout,stderr:""});
  assert.equal(await nvidiaTemperature(reply("47\r\n81\n")),81);
  assert.equal(await nvidiaTemperature(reply("[N/A]\n")),null);
  assert.equal(await nvidiaTemperature(async()=>{throw Object.assign(Error("spawn nvidia-smi ENOENT"),{code:"ENOENT"});}),null);
});

test("excess-worker thermal shows and sets the limits and refuses nonsense",async()=>{
  await mkdir(".cache",{recursive:true});
  const home=await mkdtemp(resolve(".cache/thermal-cli-"));
  try{
    const show=cli(home,"thermal");
    assert.equal(show.status,0,show.stderr);
    const shown=JSON.parse(show.stdout);
    assert.deepEqual([shown.maxCpuTempC,shown.maxGpuTempC,shown.gpuChecked],[95,85,false]);
    assert.ok("cpuTempC" in shown.readings&&"gpuTempC" in shown.readings);
    const set=cli(home,"thermal","cpu","88","gpu","off");
    assert.equal(set.status,0,set.stderr);
    assert.deepEqual([JSON.parse(set.stdout).maxCpuTempC,JSON.parse(set.stdout).maxGpuTempC],[88,null]);
    assert.equal(JSON.parse(cli(home,"policy").stdout).policy.maxCpuTempC,88,"stored in the policy");
    for(const bad of [["cpu"],["fan","80"],["cpu","hot"],["cpu","120"]])assert.notEqual(cli(home,"thermal",...bad).status,0,bad.join(" "));
    assert.equal(JSON.parse(cli(home,"thermal").stdout).maxCpuTempC,88,"a refused change keeps the previous limit");
  }finally{await rm(home,{recursive:true,force:true});}
});
