import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {join,resolve} from "node:path";
import {DEFAULT_WORKER_POLICY,describeSchedule,parseScheduleSpec,parseWorkerPolicy,policyDecision,withinSchedule} from "../apps/worker/dist/policy.js";
import {linuxOnBattery} from "../apps/worker/dist/telemetry.js";
import {checkForUpdate,currentRelease,parsePointer} from "../apps/worker/dist/update.js";

// 18 September 2026 was a Friday; months are zero-based.
const at=(day,hour,minute=0)=>new Date(2026,8,day,hour,minute);
const ready={freeMemoryMb:65536,idleSeconds:3600,onBattery:false};

test("schedule specs parse to weekly windows, including ranges that wrap the week and windows past midnight",()=>{
  assert.deepEqual(parseScheduleSpec(["mon-fri 22:00-07:00"]),[{days:[1,2,3,4,5],from:"22:00",to:"07:00"}]);
  assert.deepEqual(parseScheduleSpec(["22:00-07:00"]),[{days:[0,1,2,3,4,5,6],from:"22:00",to:"07:00"}]);
  assert.deepEqual(parseScheduleSpec(["sat,sun 00:00-24:00"]),[{days:[0,6],from:"00:00",to:"24:00"}]);
  assert.deepEqual(parseScheduleSpec(["fri-mon 09:00-17:00"])[0].days,[0,1,5,6]);
  assert.deepEqual(parseScheduleSpec(["Monday,wednesday 08:00-09:30"])[0].days,[1,3]);
  for(const bad of ["mon-fri","weekdays 22:00-07:00","22-07","mon 2200-0700"])assert.throws(()=>parseScheduleSpec([bad]),/Invalid schedule/);
  assert.equal(describeSchedule([]),"any time");
  assert.equal(describeSchedule(parseScheduleSpec(["mon-fri 22:00-07:00","sat,sun 00:00-24:00"])),"mon,tue,wed,thu,fri 22:00-07:00; sun,sat 00:00-24:00");
});

test("a window past midnight belongs to the day it starts on",()=>{
  const nights=parseScheduleSpec(["mon-fri 22:00-07:00"]);
  assert.equal(withinSchedule(nights,at(18,23)),true,"Friday 23:00");
  assert.equal(withinSchedule(nights,at(19,6,59)),true,"Saturday 06:59 is still Friday night");
  assert.equal(withinSchedule(nights,at(19,7)),false,"Saturday 07:00");
  assert.equal(withinSchedule(nights,at(19,23)),false,"Saturday night is not in mon-fri");
  assert.equal(withinSchedule(nights,at(21,6)),false,"Monday 06:00 follows Sunday, which is not in mon-fri");
  assert.equal(withinSchedule(nights,at(21,22)),true,"Monday 22:00");
  assert.equal(withinSchedule(parseScheduleSpec(["sat,sun 00:00-24:00"]),at(20,23,59)),true,"24:00 includes the last minute");
  assert.equal(withinSchedule([],at(18,12)),true,"no schedule means any time");
});

test("policy defaults, validation of new settings, and the schedule and battery decisions",()=>{
  assert.deepEqual([DEFAULT_WORKER_POLICY.schedule,DEFAULT_WORKER_POLICY.pauseOnBattery,DEFAULT_WORKER_POLICY.autoUpdate],[[],true,false]);
  const policy=parseWorkerPolicy({schedule:parseScheduleSpec(["mon-fri 22:00-07:00"])});
  for(const [input,message] of [[{schedule:[{days:[7],from:"22:00",to:"07:00"}]},/schedule days/],[{schedule:[{days:[1,1],from:"22:00",to:"07:00"}]},/schedule days/],
    [{schedule:[{days:[1],from:"25:00",to:"07:00"}]},/schedule times/],[{schedule:[{days:[1],from:"07:00",to:"07:00"}]},/schedule times/],
    [{schedule:[{days:[1],from:"24:00",to:"07:00"}]},/schedule times/],[{schedule:[{days:[1],from:"07:00",to:"08:00",extra:1}]},/days, from and to/],
    [{schedule:"nightly"},/list of at most 14/],[{pauseOnBattery:"yes"},/pauseOnBattery/],[{autoUpdate:1},/autoUpdate/]])
    assert.throws(()=>parseWorkerPolicy(input),message);
  assert.deepEqual(policyDecision(policy,ready,false,0,at(18,12)),{allowed:false,reason:"outside_schedule",detail:"runs mon,tue,wed,thu,fri 22:00-07:00 (local time)"});
  assert.equal(policyDecision(policy,ready,false,0,at(18,23)).allowed,true);
  assert.equal(policyDecision(policy,ready,true,0,at(18,12)).allowed,true,"a running job is not stopped when its window closes");
  const any=parseWorkerPolicy({});
  assert.equal(policyDecision(any,{...ready,onBattery:true}).reason,"on_battery");
  assert.equal(policyDecision(any,{...ready,onBattery:true},true).allowed,true,"a running job finishes on battery");
  assert.equal(policyDecision(any,{...ready,onBattery:null}).allowed,true,"no battery or unknown state is not a reason to stop");
  assert.equal(policyDecision(parseWorkerPolicy({pauseOnBattery:false}),{...ready,onBattery:true}).allowed,true);
});

test("Linux battery state: on battery only when a battery is present and no mains supply is online",async()=>{
  await mkdir(".cache",{recursive:true});
  const root=await mkdtemp(resolve(".cache/power-supply-"));
  try{
    const supply=async(name,files)=>{await mkdir(join(root,name));for(const [file,value] of Object.entries(files))await writeFile(join(root,name,file),value+"\n");};
    assert.equal(await linuxOnBattery(join(root,"missing")),null,"a server without power_supply");
    await supply("AC",{type:"Mains",online:"1"});
    assert.equal(await linuxOnBattery(root),null,"mains only: no battery");
    await supply("BAT0",{type:"Battery",present:"1"});
    assert.equal(await linuxOnBattery(root),false,"laptop on mains");
    await writeFile(join(root,"AC","online"),"0\n");
    assert.equal(await linuxOnBattery(root),true,"laptop on battery");
  }finally{await rm(root,{recursive:true,force:true});}
});

test("update pointers are checked like the installers check them, and only a packaged worker reports an update",async()=>{
  const line=`excess-worker-0.1.0-0123456789ab-linux-x64.tar.gz ${"c".repeat(64)} 43385019 0.1.0-0123456789ab excess-worker-0.1.0-linux-x64\n`;
  assert.deepEqual(parsePointer(line,"linux-x64"),{archive:"excess-worker-0.1.0-0123456789ab-linux-x64.tar.gz",sha256:"c".repeat(64),bytes:43385019,version:"0.1.0-0123456789ab",folder:"excess-worker-0.1.0-linux-x64"});
  for(const bad of [line.replace("linux-x64.tar.gz","linux-x64.zip"),line.replace("c".repeat(64),"xyz"),line.trim()+" extra","../../x "+"c".repeat(64)+" 1 v f"])
    assert.throws(()=>parsePointer(bad,"linux-x64"),/not valid/);
  assert.equal(parsePointer(line.replaceAll("linux-x64.tar.gz","win-x64.zip").replace("linux-x64\n","win-x64\n"),"win-x64").version,"0.1.0-0123456789ab");

  const suffix=process.platform==="win32"?"win-x64":"linux-x64",ext=process.platform==="win32"?".zip":".tar.gz";
  const pointer=`excess-worker-0.1.0-bbbbbbbbbbbb-${suffix}${ext} ${"d".repeat(64)} 100 0.1.0-bbbbbbbbbbbb excess-worker-0.1.0-${suffix}`;
  const requested=[],fetcher=async url=>{requested.push(url);return new Response(pointer);};
  assert.deepEqual((({checkedAt,...rest})=>rest)(await checkForUpdate("https://excess.example",`0.1.0-aaaaaaaaaaaa`,fetcher)),{current:"0.1.0-aaaaaaaaaaaa",latest:"0.1.0-bbbbbbbbbbbb",available:true});
  assert.deepEqual(requested,[`https://excess.example/downloads/latest-${suffix}.txt`]);
  assert.equal((await checkForUpdate("https://excess.example","0.1.0-bbbbbbbbbbbb",fetcher)).available,false);
  assert.equal((await checkForUpdate("https://excess.example",null,fetcher)).available,false,"a repository build never updates itself");
  await assert.rejects(checkForUpdate("http://excess.example","x",fetcher),/https exchange/);
  await assert.rejects(checkForUpdate("https://excess.example","x",async()=>new Response("",{status:404})),/no published worker/);

  const pkg=await mkdtemp(resolve(".cache/worker-package-"));
  try{
    await mkdir(join(pkg,"app","worker","dist"),{recursive:true});
    const entry=join(pkg,"app","worker","dist","main.js");
    assert.equal(await currentRelease(entry),null,"no manifest");
    await writeFile(join(pkg,"manifest.json"),JSON.stringify({version:"0.1.0",sourceCommit:"0123456789ab"+"0".repeat(28)}));
    assert.equal(await currentRelease(entry),"0.1.0-0123456789ab");
  }finally{await rm(pkg,{recursive:true,force:true});}
});
