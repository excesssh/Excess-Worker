import {createTextAdapter,capabilityDigest,type TextAdapter} from "@excess/adapters";
import {acquireRuntimeLock,readWorkerControl,setWorkerControl,writeWorkerStatus} from "./control.js";
import {readWorkerPolicy,parseWorkerPolicy,policyDecision,type ResourceObservation,type WorkerPolicy} from "./policy.js";
import {observeLocalResources} from "./telemetry.js";

/** Explicit diagnostic; same local ownership, idle and stop controls as a worker. */
export async function runLocalProbe(options:{stateDir:string;installDir:string;policy?:WorkerPolicy;telemetry?:()=>Promise<ResourceObservation>;signal?:AbortSignal;adapter?:TextAdapter}) {
  const release=await acquireRuntimeLock(options.stateDir),controller=new AbortController();
  let adapter:TextAdapter|undefined,timer:NodeJS.Timeout|undefined,checking=false,refresh:Promise<void>|undefined;
  let succeeded=false,reason="probe_failed",observedAt=0,observation:ResourceObservation={freeMemoryMb:null,idleSeconds:null};
  const abort=(why:string)=>{reason=why;controller.abort();void adapter?.stop().catch(()=>{});};
  const external=()=>abort("stopped_locally");options.signal?.addEventListener("abort",external,{once:true});
  try {
    const policy=parseWorkerPolicy(options.policy??await readWorkerPolicy(options.stateDir));
    const observe=options.telemetry??observeLocalResources;
    observation=await observe();observedAt=Date.now();
    const allowed=policyDecision(policy,observation);
    if(!allowed.allowed){reason=allowed.reason;throw Error("Probe blocked: "+reason);}
    if(options.signal?.aborted)throw Error("Probe stopped");
    adapter=options.adapter??createTextAdapter(options.installDir,{threads:policy.threads,maxMemoryMb:policy.maxMemoryMb,timeoutMs:policy.runSeconds*1000});
    await setWorkerControl(options.stateDir,"run");
    await writeWorkerStatus(options.stateDir,{state:"starting",reason:"probing_installed_model",activeAttemptId:null});
    timer=setInterval(()=>{
      if(checking)return;checking=true;
      void (async()=>{
        if(await readWorkerControl(options.stateDir)!=="run")return abort("stopped_locally");
        if(!refresh&&Date.now()-observedAt>=1000) {
          refresh=observe().then(value=>{observation=value;observedAt=Date.now();},()=>{observation={freeMemoryMb:null,idleSeconds:null};observedAt=Date.now();}).finally(()=>{refresh=undefined;});
        }
        const current=policyDecision(policy,Date.now()-observedAt>5000?{freeMemoryMb:null,idleSeconds:null}:observation,true);
        if(!current.allowed)abort(current.reason);
      })().catch(()=>abort("local_control_unavailable")).finally(()=>{checking=false;});
    },100);
    const proof=await adapter.probe();
    if(controller.signal.aborted||proof.ok!==true||proof.capabilityDigest!==capabilityDigest)throw Error("Probe stopped or invalid");
    succeeded=true;reason="probe_completed";return proof;
  } finally {
    clearInterval(timer);options.signal?.removeEventListener("abort",external);
    try {await adapter?.stop();await refresh;await setWorkerControl(options.stateDir,"stop");
      await writeWorkerStatus(options.stateDir,{state:succeeded?"stopped":"error",reason,activeAttemptId:null,capabilityDigest:succeeded?capabilityDigest:null});}
    finally {await release();}
  }
}
