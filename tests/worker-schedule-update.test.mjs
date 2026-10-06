import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {join,resolve} from "node:path";
import {DEFAULT_WORKER_POLICY,describeSchedule,parseScheduleSpec,parseWorkerPolicy,policyDecision,withinSchedule} from "../apps/worker/dist/policy.js";
import {linuxOnBattery} from "../apps/worker/dist/telemetry.js";
import {__testCheckForUpdate,currentRelease} from "../apps/worker/dist/update.js";

// 18 September 2026 was a Friday; months are zero-based.
const at=(day,hour,minute=0)=>new Date(2026,8,day,hour,minute);
const ready={freeMemoryMb:65536,idleSeconds:3600,onBattery:false};

function signedFixture(manifest) {
  const keyPair=generateKeyPairSync("ed25519"), keyId=Buffer.from("0123456789abcdef","hex"), publicRaw=keyPair.publicKey.export({format:"der",type:"spki"}).subarray(-32);
  const publicKey=`untrusted comment: fixture key\n${Buffer.concat([Buffer.from("Ed"),keyId,publicRaw]).toString("base64")}\n`;
  const bytes=Buffer.from(JSON.stringify(manifest)), signature=sign(null,createHash("blake2b512").update(bytes).digest(),keyPair.privateKey), trusted="fixture release sequence:"+manifest.sequence;
  const signatureText=`untrusted comment: fixture signature\n${Buffer.concat([Buffer.from("ED"),keyId,signature]).toString("base64")}\ntrusted comment: ${trusted}\n${sign(null,Buffer.concat([signature,Buffer.from(trusted)]),keyPair.privateKey).toString("base64")}\n`;
  return {bytes,signatureText,publicKey};
}

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

test("update checks verify signed release metadata and only packaged workers report an update",async()=>{
  const platform=process.platform==="win32"?"win32-x64":"linux-x64", commit="b".repeat(40), suffix=platform==="win32-x64"?"win-x64.zip":"linux-x64.tar.gz";
  const manifest={format:1,product:"Excess Worker",version:"0.1.1",sequence:2,sourceCommit:commit,repository:"https://github.com/excesssh/Excess-Worker",releasedAt:"2026-10-05T12:00:00Z",
    files:[{platform,file:`excess-worker-0.1.1-${commit.slice(0,12)}-${suffix}`,bytes:100,sha256:"d".repeat(64),reproducible:true},
      {platform:platform==="win32-x64"?"linux-x64":"win32-x64",file:`excess-worker-0.1.1-${commit.slice(0,12)}-${platform==="win32-x64"?"linux-x64.tar.gz":"win-x64.zip"}`,bytes:101,sha256:"e".repeat(64),reproducible:true}],
    isolation:{"win32-x64":"fixture-profile-v1","linux-x64":"fixture-profile-v1"},permissions:{filesystem:"fixture filesystem",network:"fixture network",credentials:"fixture credential"}};
  const fixture=signedFixture(manifest), requested=[], fetcher=async url=>{requested.push(url);return new Response(url.endsWith(".minisig")?fixture.signatureText:fixture.bytes);};
  const stateDir=await mkdtemp(resolve(".cache/release-check-"));
  try {
    const options={origin:"https://excess.example",fetcher,publicKey:fixture.publicKey,platform,stateDir,current:{sequence:1,version:"0.1.0",sourceCommit:"a".repeat(40)}};
    assert.deepEqual((({checkedAt,...rest})=>rest)(await __testCheckForUpdate(options)),{current:`0.1.0-${"a".repeat(12)}`,latest:`0.1.1-${commit.slice(0,12)}`,available:true});
    assert.deepEqual(requested,["https://excess.example/downloads/release.json","https://excess.example/downloads/release.json.minisig"]);
    const controller=new AbortController();let signatureSignal,enteredResolve;
    const entered=new Promise(resolve=>{enteredResolve=resolve;});
    const pending=__testCheckForUpdate({...options,signal:controller.signal,fetcher:async(url,init)=>{
      if(url.endsWith(".minisig")){signatureSignal=init.signal;enteredResolve();return new Promise((_,reject)=>init.signal.addEventListener("abort",()=>reject(Error("aborted")),{once:true}));}
      return new Response(fixture.bytes);
    }});
    await entered;controller.abort();assert.equal(signatureSignal.aborted,true);await assert.rejects(pending,/aborted/);
    await assert.rejects(__testCheckForUpdate({...options,origin:"http://excess.example"}),/HTTPS exchange/);
    await assert.rejects(__testCheckForUpdate({...options,fetcher:async()=>new Response("",{status:404})}),/download failed/);
    await assert.rejects(__testCheckForUpdate({...options,current:{sequence:2,version:"0.1.1",sourceCommit:"c".repeat(40)}}),/equivocation/);
  } finally {await rm(stateDir,{recursive:true,force:true});}

  const pkg=await mkdtemp(resolve(".cache/worker-package-"));
  try{
    await mkdir(join(pkg,"app","worker","dist"),{recursive:true});
    const entry=join(pkg,"app","worker","dist","main.js");
    assert.equal(await currentRelease(entry),null,"no manifest");
    await writeFile(join(pkg,"manifest.json"),JSON.stringify({product:"EXCESS",package:"worker",publicDistributionReady:true,releaseSequence:1,version:"0.1.0",sourceCommit:"0123456789ab"+"0".repeat(28)}));
    assert.equal(await currentRelease(entry),"0.1.0-0123456789ab");
    await writeFile(join(pkg,"manifest.json"),JSON.stringify({product:"EXCESS",package:"worker",publicDistributionReady:false,releaseSequence:1,version:"0.1.0",sourceCommit:"0123456789ab"+"0".repeat(28)}));
    assert.equal(await currentRelease(entry),null,"unreleased candidates cannot self-update");
  }finally{await rm(pkg,{recursive:true,force:true});}
});
