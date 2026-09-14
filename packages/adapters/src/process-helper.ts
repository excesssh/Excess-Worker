import { z } from "zod";
import { startNativeProcess,type ManagedProcess } from "./native-process.js";

const startSchema=z.strictObject({type:z.literal("start"),executable:z.string().min(1).max(4096),args:z.array(z.string().max(8192)).max(64),
  options:z.strictObject({cwd:z.string().min(1).max(4096),env:z.record(z.string(),z.string().optional()),maxMemoryBytes:z.number().int().positive()})});
let native:ManagedProcess|undefined,started=false,closing=false,reporter:NodeJS.Timeout|undefined;
function report(){if(process.connected&&native)process.send?.({type:"status",peakRssBytes:native.peakRssBytes(),error:native.error()?.code},undefined,undefined,()=>{});}
async function shutdown() {
  if(closing)return;closing=true;clearInterval(reporter);
  try{await native?.stop();}finally{
    if(process.connected&&native)await new Promise<void>(resolve=>{process.send?.({type:"status",peakRssBytes:native!.peakRssBytes(),error:native!.error()?.code},undefined,undefined,()=>resolve());});
    process.exit(0);
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
  if(started){void shutdown();return;}
  const parsed=startSchema.safeParse(input);if(!parsed.success){void shutdown();return;}
  started=true;
  native=startNativeProcess(parsed.data.executable,parsed.data.args,parsed.data.options);
  if(process.connected)process.send?.({type:"started",pid:native.child.pid},undefined,undefined,()=>{});
  reporter=setInterval(report,200);
  void native.closed.then(()=>shutdown());
});
