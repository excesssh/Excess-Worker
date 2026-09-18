import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir} from "node:fs/promises";
import {resolve} from "node:path";
import {runLocalProbe} from "../apps/worker/dist/probe.js";
import {setWorkerControl,readWorkerStatus} from "../apps/worker/dist/control.js";
import {parseWorkerPolicy} from "../apps/worker/dist/policy.js";

test("explicit probe obeys idle policy and local stop without leaving a fake process running",async()=>{
  await mkdir(".cache",{recursive:true});const dir=await mkdtemp(resolve(".cache/worker-probe-fixture-"));
  // Idle-only is set explicitly: it is the Windows default only, and without it the first probe would never be blocked.
  const policy=parseWorkerPolicy({idleOnly:true});
  let probes=0,stopCalls=0,rejectProbe;
  const adapter={async probe(){probes++;return new Promise((_,reject)=>{rejectProbe=reject;});},async execute(){throw Error("not used");},async stop(){stopCalls++;rejectProbe?.(Error("test-only stopped"));}};
  await assert.rejects(runLocalProbe({stateDir:dir,installDir:"NO_MODEL_INSTALLED",policy,adapter,telemetry:async()=>({freeMemoryMb:8192,idleSeconds:null})}),/blocked/);
  assert.equal(probes,0);
  const controller=new AbortController();
  const pending=runLocalProbe({stateDir:dir,installDir:"NO_MODEL_INSTALLED",policy,adapter,signal:controller.signal,telemetry:async()=>({freeMemoryMb:8192,idleSeconds:120})});
  const rejected=assert.rejects(pending,/stopped/);
  try {
    const deadline=Date.now()+5000;
    while(probes===0){assert.ok(Date.now()<deadline);await new Promise(done=>setTimeout(done,10));}
    await setWorkerControl(dir,"stop");await rejected;
    assert.ok(stopCalls>=1);assert.equal((await readWorkerStatus(dir)).reason,"stopped_locally");
  } finally {controller.abort();await pending.catch(()=>{});}
});
