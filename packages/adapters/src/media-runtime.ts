import { randomBytes } from "node:crypto";
import { availableParallelism,totalmem } from "node:os";
import { dirname,join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { MEDIA_LIMITS,TEXT_LIMITS,embeddingRequestSchema,embeddingResultSchema,imageRequestSchema,imageResultSchema,transcriptionRequestSchema,transcriptionResultSchema,
  type ArtifactRef,type MediaKind,type MediaRequest,type MediaResult } from "@excess/protocol";
import { AdapterError,currentPlatform,mediaCatalogEntry,type Backend } from "./manifest.js";
import { verifyMediaInstallation } from "./media-install.js";
import { AdapterProcessState,boundedJson,port } from "./runtime.js";
import { startSupervisedProcess } from "./process.js";
import { artifactRef,parsePng,parseWav,sha256,strictBase64,toneWav } from "./media-format.js";

export interface MediaAdapterOptions {threads:number;maxMemoryMb:number;timeoutMs:number;modelId:string;backend?:Backend}
export interface MediaArtifact {ref:ArtifactRef;data:Buffer}
/** A media result and the bytes of every artifact it references. */
export interface MediaOutput {result:MediaResult;artifacts:MediaArtifact[]}
export interface MediaProbe {ok:true;kind:MediaKind;capabilityDigest:string;backend:Backend;modelId:string;model:string;runtime:string;threads:number;maxMemoryMb:number;
  probedAt:string;generatedTokens:0;elapsedMs:number;peakRssMb:number;nativePid?:number;guardianPid?:number}
export interface MediaAdapter {
  readonly kind:MediaKind;
  /** Validates a request against the model's own limits before a job is started. */
  check(request:unknown):MediaRequest;
  probe():Promise<MediaProbe>;
  execute(request:unknown,options?:{signal?:AbortSignal;inputs?:ReadonlyMap<string,Buffer>}):Promise<MediaOutput>;
  stop():Promise<void>;
}
/** Internal seam: where the verified server and model files are. Tests substitute a fixture server; the package entry point
 * exposes only createMediaAdapter, which always re-verifies the pinned installation. */
export interface MediaLaunch {resolve():Promise<{serverPath:string;files:Readonly<Record<string,string>>}>;executable?:string;prefixArgs?:readonly string[]}

const optionsSchema=z.strictObject({threads:z.number().int().min(1).max(64),maxMemoryMb:z.number().int().min(1024).max(262144),timeoutMs:z.number().int().min(1000).max(TEXT_LIMITS.maxRunSeconds*1000),
  modelId:z.string().min(1).max(64),backend:z.enum(["cpu","cuda","vulkan"]).optional()});
// One embedding input is at most 8,192 UTF-8 bytes, so at most 8,192 tokens plus special tokens; last-token pooling
// needs the whole input in one physical batch.
const EMBEDDING_BATCH_TOKENS=8448;
// 300 seconds of audio plus the prompt and transcript fit this context; the transcript is capped below it.
const TRANSCRIPTION_CONTEXT=8192,TRANSCRIPT_MAX_TOKENS=4096;
// The ASR prompt llama.cpp's own /v1/audio/transcriptions route builds for Qwen3-ASR (common_chat_get_asr_prompt at
// 5266f24): the user text, an optional language hint, then the audio.
const ASR_PROMPT="Transcribe audio to text";
const MiB=1048576;

/** Qwen3-ASR answers "language <name><asr_text><transcript>"; only the transcript is returned. */
export function cleanTranscript(content:string):string {
  let text=content.replace(/<think>[\s\S]*?<\/think>/g,"");
  const marker=text.indexOf("<asr_text>");
  if(marker>=0)text=text.slice(marker+"<asr_text>".length);
  return text.replace(/<\/asr_text>\s*$/,"").trim();
}
export function createMediaAdapter(installDir:string,options:MediaAdapterOptions):MediaAdapter {
  return createMediaAdapterWith(options,{resolve:async()=>{const installed=await verifyMediaInstallation(installDir,options?.modelId,options?.backend??"cpu");return {serverPath:installed.serverPath,files:installed.files};}});
}
export function createMediaAdapterWith(inputOptions:MediaAdapterOptions,launch:MediaLaunch):MediaAdapter {
  const parsed=optionsSchema.safeParse(inputOptions);
  if(!parsed.success)throw new AdapterError("INVALID_ADAPTER_POLICY");
  const options=parsed.data,entry=mediaCatalogEntry(options.modelId),backend:Backend=options.backend??"cpu",llama=entry.runtime==="llama.cpp";
  if(entry.gpuOnly&&backend==="cpu")throw new AdapterError("MODEL_REQUIRES_GPU");
  if(options.threads>availableParallelism()||options.maxMemoryMb*MiB>totalmem())throw new AdapterError("ADAPTER_POLICY_EXCEEDS_MACHINE");
  const limits=entry.capability.limits as {sizes?:number[];maxSteps?:number;maxImages?:number};
  const processes=new AdapterProcessState();
  let origin="",secret="",busy=false,stopping=new AbortController();
  async function stop():Promise<void> {stopping.abort();await processes.stop();}
  const headers=(json:boolean)=>({...(json?{"Content-Type":"application/json"}:{}),...(secret?{Authorization:"Bearer "+secret}:{})});
  function serverArgs(files:Readonly<Record<string,string>>,selectedPort:number):string[] {
    const file=(name:string)=>{const path=files[name];if(!path)throw new AdapterError("ADAPTER_NOT_INSTALLED_OR_CORRUPT");return path;};
    const threads=String(options.threads),gpuLayers=backend==="cpu"?"0":"999";
    const llamaCommon=["--host","127.0.0.1","--port",String(selectedPort),"--threads",threads,"--threads-batch",threads,"--threads-http","2","--parallel","1","--n-gpu-layers",gpuLayers,"--no-mmap","--no-webui","--no-cache-prompt"];
    if(entry.kind==="embedding")return ["--model",file("model.gguf"),...llamaCommon,"--ctx-size",String(EMBEDDING_BATCH_TOKENS),"--batch-size",String(EMBEDDING_BATCH_TOKENS),"--ubatch-size",String(EMBEDDING_BATCH_TOKENS),"--embeddings","--pooling","last"];
    if(entry.kind==="transcription")return ["--model",file("model.gguf"),"--mmproj",file("mmproj.gguf"),...llamaCommon,"--ctx-size",String(TRANSCRIPTION_CONTEXT),
      "--no-context-shift","--jinja","--reasoning-format","none",...(backend==="cpu"?["--no-mmproj-offload"]:[])];
    // sd-server has no API key option; it listens on loopback only, on a fresh random port. Generation metadata (which would
    // copy the prompt into the PNG) is disabled.
    const sdCommon=["--listen-ip","127.0.0.1","--listen-port",String(selectedPort),"--threads",threads,"--cfg-scale","1.0","--disable-image-metadata"];
    return entry.id==="flux1-schnell"
      ?["--diffusion-model",file("diffusion.gguf"),"--t5xxl",file("t5xxl.gguf"),"--clip_l",file("clip_l.gguf"),"--vae",file("ae.gguf"),...sdCommon]
      :["--model",file("model.gguf"),...sdCommon];
  }
  async function ensure(signal:AbortSignal) {
    if(processes.process?.alive())return;
    await processes.stop();signal.throwIfAborted();
    const platform=currentPlatform();
    if(!platform)throw new AdapterError("UNSUPPORTED_ADAPTER_PLATFORM");
    const installed=await launch.resolve();signal.throwIfAborted();
    if(backend==="cpu"&&options.maxMemoryMb<entry.minMemoryMb)throw new AdapterError("ADAPTER_MEMORY_BELOW_MODEL_REQUIREMENT");
    const selectedPort=await port();signal.throwIfAborted();
    secret=llama?randomBytes(32).toString("base64url"):"";origin=`http://127.0.0.1:${selectedPort}`;
    let env:NodeJS.ProcessEnv;
    if(platform==="win32-x64") {
      const systemRoot=process.env.SystemRoot??"C:\\Windows";
      env={SystemRoot:systemRoot,WINDIR:systemRoot,PATH:join(systemRoot,"System32"),OMP_NUM_THREADS:String(options.threads)};
      for(const key of ["TEMP","TMP"])if(process.env[key])env[key]=process.env[key];
    } else {
      env={PATH:"/usr/bin:/bin",LD_LIBRARY_PATH:dirname(installed.serverPath),OMP_NUM_THREADS:String(options.threads)};
      for(const key of ["HOME","TMPDIR"])if(process.env[key])env[key]=process.env[key];
    }
    if(secret)env.LLAMA_API_KEY=secret;
    processes.attach(startSupervisedProcess(launch.executable??installed.serverPath,[...(launch.prefixArgs??[]),...serverArgs(installed.files,selectedPort)],
      {cwd:dirname(installed.serverPath),env,maxMemoryBytes:options.maxMemoryMb*MiB}));
    // sd-server only listens once its model is loaded; llama-server reports readiness on /health.
    const readiness=llama?"/health":"/v1/models";
    for(;;) {
      signal.throwIfAborted();if(!processes.process?.alive())throw processes.process?.error()??new AdapterError("RUNTIME_EXITED");
      try {const response=await fetch(origin+readiness,{signal:AbortSignal.any([signal,AbortSignal.timeout(1000)]),redirect:"error",headers:headers(false)});if(response.ok){await boundedJson(response,4096);return;}await response.body?.cancel();}
      catch(error){if(signal.aborted)throw error;}
      await delay(200,undefined,{signal});
    }
  }
  const post=(path:string,body:unknown,signal:AbortSignal)=>fetch(origin+path,{method:"POST",redirect:"error",signal,headers:headers(true),body:JSON.stringify(body)});
  const invalid=():never=>{throw new AdapterError("INVALID_RUNTIME_RESULT");};

  async function embed(request:z.infer<typeof embeddingRequestSchema>,signal:AbortSignal):Promise<MediaOutput> {
    const count=request.inputs.length,dimensions=MEDIA_LIMITS.embedding.dimensions,vectorBytes=dimensions*4;
    const response=await post("/v1/embeddings",{input:request.inputs,encoding_format:"base64"},signal);
    const body=z.object({data:z.array(z.object({index:z.number().int().min(0).max(count-1),embedding:z.string()})).length(count),usage:z.object({prompt_tokens:z.number().int().min(0).max(1048576)})})
      .safeParse(await boundedJson(response,count*(Math.ceil(vectorBytes/3)*4+256)+65536));
    if(!body.success)return invalid();
    const vectors=Buffer.alloc(count*vectorBytes),seen=new Set<number>();
    for(const item of body.data.data) {
      const raw=strictBase64(item.embedding,vectorBytes);
      if(seen.has(item.index)||!raw||raw.length!==vectorBytes)return invalid();
      for(let offset=0;offset<vectorBytes;offset+=4)if(!Number.isFinite(raw.readFloatLE(offset)))return invalid();
      seen.add(item.index);raw.copy(vectors,item.index*vectorBytes);
    }
    // The supplier-reported token count is bounded: at least one per input and at most the protocol maximum.
    const inputTokens=Math.min(MEDIA_LIMITS.embedding.maxInputTokens,Math.max(count,body.data.usage.prompt_tokens));
    const vectorsRef=artifactRef(vectors,"application/vnd.excess.float32le");
    const result=embeddingResultSchema.safeParse({kind:"embedding",dimensions,count,inputTokens,vectors:vectorsRef});
    if(!result.success)return invalid();
    return {result:result.data,artifacts:[{ref:vectorsRef,data:vectors}]};
  }
  async function transcribe(request:z.infer<typeof transcriptionRequestSchema>,inputs:ReadonlyMap<string,Buffer>|undefined,signal:AbortSignal):Promise<MediaOutput> {
    const audio=inputs?.get(request.audio.digest);
    if(!audio||audio.length!==request.audio.bytes||sha256(audio)!==request.audio.digest)throw new AdapterError("MEDIA_INPUT_MISSING");
    if(Math.abs(parseWav(audio).durationMs-request.durationMs)>=1)throw new AdapterError("AUDIO_DURATION_MISMATCH");
    const text=ASR_PROMPT+(request.language?` (language: ${request.language})`:"");
    const response=await post("/v1/chat/completions",{
      messages:[{role:"user",content:[{type:"text",text},{type:"input_audio",input_audio:{data:audio.toString("base64"),format:"wav"}}]}],
      max_tokens:TRANSCRIPT_MAX_TOKENS,temperature:0,seed:0,stream:false,cache_prompt:false,
    },signal);
    const body=z.object({choices:z.array(z.object({finish_reason:z.string().nullable(),message:z.object({content:z.string().nullable()})})).length(1)})
      .safeParse(await boundedJson(response,8*MEDIA_LIMITS.transcription.maxTranscriptBytes+65536));
    if(!body.success)return invalid();
    if(body.data.choices[0]!.finish_reason!=="stop")throw new AdapterError("TRANSCRIPT_TRUNCATED");
    const result=transcriptionResultSchema.safeParse({kind:"transcription",text:cleanTranscript(body.data.choices[0]!.message.content??""),audioSeconds:Math.ceil(request.durationMs/1000)});
    if(!result.success)return invalid();
    return {result:result.data,artifacts:[]};
  }
  async function image(request:z.infer<typeof imageRequestSchema>,signal:AbortSignal):Promise<MediaOutput> {
    // Native controls travel in sd-server's own prompt extension (routes_openai.cpp at 07a85c7); the buyer prompt can never
    // carry one, because check() refuses any prompt that mentions the tag.
    const extra=JSON.stringify({seed:request.seed,sample_params:{sample_steps:request.steps,guidance:{txt_cfg:1.0}}});
    const response=await post("/v1/images/generations",{prompt:`${request.prompt}<sd_cpp_extra_args>${extra}</sd_cpp_extra_args>`,n:request.count,size:`${request.width}x${request.height}`,output_format:"png"},signal);
    const maxImage=MEDIA_LIMITS.image.maxImageBytes;
    const body=z.object({data:z.array(z.object({b64_json:z.string()})).length(request.count)}).safeParse(await boundedJson(response,request.count*(Math.ceil(maxImage/3)*4+256)+65536));
    if(!body.success)return invalid();
    const artifacts:MediaArtifact[]=[];
    for(const item of body.data.data) {
      const data=strictBase64(item.b64_json,maxImage);
      if(!data)return invalid();
      const size=parsePng(data);
      if(size.width!==request.width||size.height!==request.height)return invalid();
      artifacts.push({ref:artifactRef(data,"image/png"),data});
    }
    const result=imageResultSchema.safeParse({kind:"image",width:request.width,height:request.height,images:artifacts.map(item=>item.ref)});
    if(!result.success)return invalid();
    return {result:result.data,artifacts};
  }
  function check(input:unknown):MediaRequest {
    const schema=entry.kind==="embedding"?embeddingRequestSchema:entry.kind==="transcription"?transcriptionRequestSchema:imageRequestSchema;
    const parsed=schema.safeParse(input);
    if(!parsed.success)throw new AdapterError("INVALID_MEDIA_REQUEST");
    const request=parsed.data as MediaRequest;
    if(request.kind==="image"&&(!limits.sizes?.includes(request.width)||request.steps>(limits.maxSteps??0)||request.count>(limits.maxImages??0)||request.prompt.includes("sd_cpp_extra_args")))
      throw new AdapterError("MEDIA_REQUEST_EXCEEDS_MODEL_LIMITS");
    return request;
  }
  async function run(request:MediaRequest,external?:AbortSignal,inputs?:ReadonlyMap<string,Buffer>):Promise<MediaOutput> {
    if(busy)throw new AdapterError("ADAPTER_BUSY");busy=true;
    if(stopping.signal.aborted)stopping=new AbortController();
    const signal=AbortSignal.any([stopping.signal,AbortSignal.timeout(options.timeoutMs),...(external?[external]:[])]);
    try {
      await processes.ready();
      signal.throwIfAborted();await ensure(signal);
      return request.kind==="embedding"?await embed(request,signal):request.kind==="transcription"?await transcribe(request,inputs,signal):await image(request,signal);
    }
    catch(error) {
      // Read the abort state before stop(), which aborts this run's own signal.
      const fault=processes.process?.error(),aborted=signal.aborted;await stop();
      if(fault)throw fault;if(error instanceof AdapterError)throw error;throw new AdapterError(aborted?"ADAPTER_ABORTED_OR_TIMED_OUT":"RUNTIME_EXECUTION_FAILED");
    }
    finally {busy=false;}
  }
  return {
    kind:entry.kind,check,stop,
    // Async so an invalid request rejects like every other execution failure instead of throwing synchronously.
    execute:async(request,execution={})=>run(check(request),execution.signal,execution.inputs),
    async probe(){
      const startedAt=Date.now();
      // Probe inputs: one short text, a generated 1.5-second tone (any transcript, even empty, passes) or one 1-step 512×512 image.
      if(entry.kind==="embedding")await run({kind:"embedding",inputs:["ready"]});
      else if(entry.kind==="transcription"){const wav=toneWav(1500);await run({kind:"transcription",audio:artifactRef(wav,"audio/wav"),durationMs:1500},undefined,new Map([[sha256(wav),wav]]));}
      else await run({kind:"image",prompt:"a red circle on a white background",width:512,height:512,steps:1,count:1,seed:42});
      const runtime=processes.process;
      const nativePid=runtime?.nativePid(),guardianPid=runtime?.child.pid;
      if(!runtime?.alive()||typeof nativePid!=="number"||!Number.isSafeInteger(nativePid)||nativePid<=0||
        typeof guardianPid!=="number"||!Number.isSafeInteger(guardianPid)||guardianPid<=0){await stop();throw new AdapterError("RUNTIME_DIAGNOSTICS_UNAVAILABLE");}
      return {ok:true,kind:entry.kind,capabilityDigest:entry.capabilityDigest,backend,modelId:entry.id,model:entry.capability.model,runtime:entry.capability.runtime,
        threads:options.threads,maxMemoryMb:options.maxMemoryMb,probedAt:new Date().toISOString(),generatedTokens:0,elapsedMs:Date.now()-startedAt,
        peakRssMb:Math.ceil(runtime.peakRssBytes()/MiB),nativePid,guardianPid};
    },
  };
}
