import {acquireRuntimeLock,readWorkerControl,setWorkerControl,writeWorkerStatus,WorkerShutdownError} from "./control.js";
import {readWorkerPolicy,parseWorkerPolicy,policyDecision,type ResourceObservation,type WorkerPolicy} from "./policy.js";
import {observeLocalResources} from "./telemetry.js";
import {createServedAdapter,servedModel,type ServedAdapter} from "./served.js";

/** Explicit diagnostic; same local ownership, idle and stop controls as a worker. Text and media models probe alike. */
export async function runLocalProbe(options:{stateDir:string;installDir:string;policy?:WorkerPolicy;telemetry?:()=>Promise<ResourceObservation>;signal?:AbortSignal;adapter?:ServedAdapter}) {
  const release=await acquireRuntimeLock(options.stateDir),controller=new AbortController();
  let adapter:ServedAdapter|undefined,timer:NodeJS.Timeout|undefined,checking=false,refresh:Promise<void>|undefined,digest:string|null=null;
  let succeeded=false,reason="probe_failed",observedAt=0,observation:ResourceObservation={freeMemoryMb:null,idleSeconds:null};
  const abort=(why:string)=>{reason=why;controller.abort();void adapter?.stop().catch(()=>{});};
  const external=()=>abort("stopped_locally");options.signal?.addEventListener("abort",external,{once:true});
  try {
    const policy=parseWorkerPolicy(options.policy??await readWorkerPolicy(options.stateDir));
    digest=servedModel(policy.model).capabilityDigest;
    const observe=options.telemetry??observeLocalResources;
    observation=await observe();observedAt=Date.now();
    const allowed=policyDecision(policy,observation);
    if(!allowed.allowed){reason=allowed.reason;throw Error("Probe blocked: "+reason+(allowed.detail?" ("+allowed.detail+")":""));}
    if(options.signal?.aborted)throw Error("Probe stopped");
    adapter=options.adapter??createServedAdapter(options.installDir,policy);
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
    if(controller.signal.aborted||proof.ok!==true||proof.capabilityDigest!==digest||proof.backend!==policy.backend)throw Error("Probe stopped or invalid");
    succeeded=true;reason="probe_completed";return proof;
  } finally {
    clearInterval(timer);options.signal?.removeEventListener("abort",external);
    let shutdownFailed=false,shutdownError:unknown;
    try {await adapter?.stop();}
    catch(error){shutdownFailed=true;shutdownError=error;succeeded=false;reason="adapter_stop_failed";await release.markShutdownUnverified().catch(()=>{});}
    try {await refresh;await setWorkerControl(options.stateDir,"stop");
      await writeWorkerStatus(options.stateDir,{state:succeeded?"stopped":"error",reason,activeAttemptId:null,capabilityDigest:succeeded?digest:null});}
    finally {if(!shutdownFailed)await release();}
    if(shutdownFailed)throw new WorkerShutdownError(shutdownError);
  }
}
