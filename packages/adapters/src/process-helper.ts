import { z } from "zod";
import { startNativeProcess,type ManagedProcess } from "./native-process.js";
import { runtimeRequestSchema,runtimeControlSchema } from "./runtime-rpc.js";

const startSchema=z.strictObject({type:z.literal("start"),executable:z.string().min(1).max(4096),args:z.array(z.string().max(8192)).max(64),
  options:z.strictObject({cwd:z.string().min(1).max(4096),env:z.record(z.string(),z.string().optional()),maxMemoryBytes:z.number().int().positive(),
    supervision:z.strictObject({protocol:z.literal("windows-appcontainer-v1"),input:z.string().min(1).max(65536)}).optional()})});
let native:ManagedProcess|undefined,started=false,closing=false,reporter:NodeJS.Timeout|undefined;
function report(){if(process.connected&&native)process.send?.({type:"status",pid:native.nativePid(),peakRssBytes:native.peakRssBytes(),error:native.error()?.code},undefined,undefined,()=>{});}
async function shutdown() {
  if(closing)return;closing=true;clearInterval(reporter);
  let shutdownError:string|undefined;
  try{await native?.stop();}catch(error){shutdownError=(error as {code?:string})?.code??"RUNTIME_STOP_FAILED";}finally{
    if(process.connected&&native)await new Promise<void>(resolve=>{process.send?.({type:"status",pid:native!.nativePid(),peakRssBytes:native!.peakRssBytes(),error:shutdownError??native!.error()?.code},undefined,undefined,()=>resolve());});
    process.exit(shutdownError?1:0);
  }
}
// No stdin, HTTP or arbitrary command input. Only the spawning parent's IPC pipe.
if(!process.send||!process.connected)process.exit(1);
process.on("disconnect",()=>{void shutdown();});
process.on("SIGTERM",()=>{void shutdown();});
process.on("SIGINT",()=>{void shutdown();});
process.on("message",(input:unknown)=>{
  if(closing)return;
  if(input&&typeof input==="object"&&(input as {type?:string}).type==="stop"){void shutdown();return;}
  if(started&&native){
    const parsed=runtimeRequestSchema.safeParse(input),control=runtimeControlSchema.safeParse(input);
    if(parsed.success||control.success){
      try{native.sendRuntime(parsed.success?parsed.data:control.data!);}catch{void shutdown();}
      return;
    }
  }
  if(started){void shutdown();return;}
  const parsed=startSchema.safeParse(input);if(!parsed.success){void shutdown();return;}
  started=true;
  native=startNativeProcess(parsed.data.executable,parsed.data.args,parsed.data.options);
  native.onRuntimeFrame(frame=>{if(process.connected)process.send?.(frame,undefined,undefined,()=>{});});
  if(process.connected)process.send?.({type:"started",pid:native.nativePid()},undefined,undefined,()=>{});
  reporter=setInterval(report,200);
  void native.closed.then(()=>shutdown());
});
