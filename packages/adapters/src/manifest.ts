import { requestDigest,textRequestSchema,textResultSchema,type MediaKind } from "@excess/protocol";
import { z } from "zod";

export interface Artifact { readonly name:string; readonly bytes:number; readonly sha256:string; readonly url:string }
const artifact=(value:Artifact):Artifact=>Object.freeze({...value});
const RELEASE="https://github.com/ggml-org/llama.cpp/releases/download/b10809/";
const RUNTIME_LICENCE=artifact({ name:"licences/llama.cpp-MIT.txt", bytes:1078, sha256:"94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d", url:"https://raw.githubusercontent.com/ggml-org/llama.cpp/5266f24da75dc449bd56cbed7addb9c8e4a6a73e/LICENSE" });

/** Pinned llama.cpp b10809 builds. Every platform and backend runs the same release, so a model's capability is
 * platform- and backend-independent. Windows GPUs use CUDA; Linux GPUs use Vulkan (llama.cpp publishes no Linux CUDA build). */
export type Platform="win32-x64"|"linux-x64";
export type Backend="cpu"|"cuda"|"vulkan";
export const PLATFORM_BACKENDS:Readonly<Record<Platform,readonly Backend[]>>=Object.freeze({"win32-x64":Object.freeze(["cpu","cuda"] as Backend[]),"linux-x64":Object.freeze(["cpu","vulkan"] as Backend[])});
export const GPU_BACKEND:Readonly<Record<Platform,Backend>>=Object.freeze({"win32-x64":"cuda","linux-x64":"vulkan"});
export function currentPlatform():Platform|null {
  if(process.arch!=="x64")return null;
  return process.platform==="win32"?"win32-x64":process.platform==="linux"?"linux-x64":null;
}
export const serverExecutable=(platform:Platform):string=>platform==="win32-x64"?"llama-server.exe":"llama-server";
/** Microsoft Visual C++ runtime files (14.51.36247.0) that llama.cpp needs and a clean Windows Server lacks
 * (it ships 14.0 without vcruntime140_1.dll). The worker package bundles them; the installer copies only these exact files beside the server. */
export interface RedistFile { readonly name:string; readonly bytes:number; readonly sha256:string }
export const RUNTIME_REDIST:readonly RedistFile[]=Object.freeze([
  Object.freeze({name:"vcruntime140.dll",bytes:178616,sha256:"d1f4225df2cd877dbf130d5668a021dce3f94118455ff5ec952061c30afc9ce7"}),
  Object.freeze({name:"vcruntime140_1.dll",bytes:50112,sha256:"a7146c08f89fe5b04541ab507cdb59ff7b44534d4ba3c668a426c6450a03434e"}),
  Object.freeze({name:"msvcp140.dll",bytes:643512,sha256:"7c26614e1d733892c2deac7e245ce115504b1d80592dd0a01b08e3e5a55f89ca"}),
]);
export const BACKENDS:readonly Backend[]=Object.freeze(["cpu","cuda","vulkan"]);
/** The Windows runtimes, kept under their original name for existing callers. */
export const RUNTIME_ARTIFACTS:Readonly<Record<"cpu"|"cuda",readonly Artifact[]>>=Object.freeze({
  cpu:Object.freeze([
    artifact({ name:"runtime.zip", bytes:18407457, sha256:"9df3158ed228a641a4b127942d7f459f24c9e13f04682659d05c00c80099b6b5", url:RELEASE+"llama-b10809-bin-win-cpu-x64.zip" }),
    RUNTIME_LICENCE]),
  // CUDA 12.4 runs on drivers that report CUDA 12.4 or newer (verified with driver 596.49, CUDA 13.2).
  cuda:Object.freeze([
    artifact({ name:"runtime.zip", bytes:253938543, sha256:"c77bfcd9ed8d91e8721a2d6a290b907fddd4fa5412a47b21c6fa1709116b85f9", url:RELEASE+"llama-b10809-bin-win-cuda-12.4-x64.zip" }),
    artifact({ name:"cudart.zip", bytes:391443627, sha256:"8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6", url:RELEASE+"cudart-llama-bin-win-cuda-12.4-x64.zip" }),
    RUNTIME_LICENCE]),
});
/** Ubuntu x64 builds of the same release, checked on 15 September 2026. Their archives hold one top-level folder. */
const LINUX_RUNTIME_ARTIFACTS:Readonly<Partial<Record<Backend,readonly Artifact[]>>>=Object.freeze({
  cpu:Object.freeze([
    artifact({ name:"runtime.tar.gz", bytes:16734586, sha256:"5e34434ddc6d03cd1584f403201aff0d4bd1a5793a72ff7e286532dfd1e4b941", url:RELEASE+"llama-b10809-bin-ubuntu-x64.tar.gz" }),
    RUNTIME_LICENCE]),
  // Vulkan runs on NVIDIA, AMD and Intel GPUs with a Vulkan driver and the system Vulkan loader (libvulkan1).
  vulkan:Object.freeze([
    artifact({ name:"runtime.tar.gz", bytes:33799345, sha256:"07f029cef440c82c3cff5310641eb6347e5cbcd865a5d88990215058aa049e93", url:RELEASE+"llama-b10809-bin-ubuntu-vulkan-x64.tar.gz" }),
    RUNTIME_LICENCE]),
});
/** The pinned runtime files for a backend on a platform (the current machine's by default). */
export function runtimeArtifacts(backend:Backend,platform:Platform=currentPlatform()??"win32-x64"):readonly Artifact[] {
  const artifacts=platform==="win32-x64"?(RUNTIME_ARTIFACTS as Partial<Record<Backend,readonly Artifact[]>>)[backend]:LINUX_RUNTIME_ARTIFACTS[backend];
  if(!artifacts)throw new AdapterError("BACKEND_UNSUPPORTED_ON_PLATFORM");
  return artifacts;
}

const QWEN_LICENCE={bytes:11544,sha256:"5de36594c10839788a8c589443a8ef9d8b8d17c65a1b5807206ae037fc36c6bd"};
export interface ModelEntry {
  readonly id:string; readonly displayName:string; readonly parameters:string; readonly quantization:string;
  /** Resident memory the model needs on CPU, and GPU memory to offload every layer, with an 8,192-token context. */
  readonly minMemoryMb:number; readonly minVramMb:number;
  readonly artifacts:readonly Artifact[];
  readonly capability:Readonly<Record<string,unknown>> & {readonly model:string;readonly runtime:string;readonly contextTokens:number;readonly maxOutputTokens:number};
  readonly capabilityDigest:string;
}
function qwen3(id:string,displayName:string,parameters:string,repository:string,revision:string,file:string,bytes:number,sha256:string,minMemoryMb:number,minVramMb:number):ModelEntry {
  const model=artifact({name:"model.gguf",bytes,sha256,url:`https://huggingface.co/Qwen/${repository}/resolve/${revision}/${file}`});
  const capability=Object.freeze({
    // Version 3 drops the platform field: Windows and Linux suppliers run the same pinned release and model file.
    version:3,adapterId:"excess.llama-text",adapterVersion:"0.4.0",
    runtime:"llama.cpp-b10809",runtimeCommit:"5266f24da75dc449bd56cbed7addb9c8e4a6a73e",
    modelId:id,model:file.replace(/\.gguf$/,""),modelRevision:revision,modelSha256:sha256,
    runtimeLicence:"MIT",modelLicence:"Apache-2.0",meteringUnit:"output_token",trustClass:"supplier_visible",
    contextTokens:8192,maxPromptBytes:16384,maxOutputBytes:65536,maxOutputTokens:2048,slots:1,
    promptFormat:"qwen3-chatml-no-thinking-v1",temperature:"0.7",topP:"0.8",topK:20,presencePenalty:"1.5",
  });
  return Object.freeze({id,displayName,parameters,quantization:"Q4_K_M",minMemoryMb,minVramMb,
    artifacts:Object.freeze([model,artifact({name:"licences/Qwen3-Apache-2.0.txt",...QWEN_LICENCE,url:`https://huggingface.co/Qwen/${repository}/raw/${revision}/LICENSE`})]),
    capability,capabilityDigest:requestDigest(capability)});
}

/** The curated model catalog. Suppliers choose which entries to install and run; each entry is pinned to an exact
 * repository revision and file hash, so buyers get exactly the model they pay for. Sizes and hashes were checked
 * against Hugging Face on 15 September 2026. */
export const MODEL_CATALOG:readonly ModelEntry[]=Object.freeze([
  qwen3("qwen3-4b","Qwen3 4B","4B","Qwen3-4B-GGUF","bc640142c66e1fdd12af0bd68f40445458f3869b","Qwen3-4B-Q4_K_M.gguf",2497280256,"7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5",4096,4096),
  qwen3("qwen3-8b","Qwen3 8B","8B","Qwen3-8B-GGUF","7c41481f57cb95916b40956ab2f0b139b296d974","Qwen3-8B-Q4_K_M.gguf",5027783488,"d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785",7168,6656),
  qwen3("qwen3-14b","Qwen3 14B","14B","Qwen3-14B-GGUF","530227a7d994db8eca5ab5ced2fb692b614357fd","Qwen3-14B-Q4_K_M.gguf",9001752960,"500a8806e85ee9c83f3ae08420295592451379b4f8cf2d0f41c15dffeb6b81f0",11264,10752),
  qwen3("qwen3-30b-a3b","Qwen3 30B-A3B (fast mixture-of-experts)","30B (3B active)","Qwen3-30B-A3B-GGUF","e4d4bafdfb96a411a163846265362aceb0b9c63a","Qwen3-30B-A3B-Q4_K_M.gguf",18556685824,"0d003f6662faee786ed5da3e31b29c978de5ae5d275c8794c606a7f3c01aa8f5",20480,19968),
]);
export const DEFAULT_MODEL_ID="qwen3-4b";
export function catalogEntry(id:string):ModelEntry {
  const entry=MODEL_CATALOG.find(item=>item.id===id);
  if(!entry)throw new AdapterError("UNKNOWN_MODEL");
  return entry;
}
export const catalogEntryByDigest=(digest:string):ModelEntry|undefined=>MODEL_CATALOG.find(item=>item.capabilityDigest===digest);
export const isCatalogCapability=(digest:unknown):boolean=>typeof digest==="string"&&catalogEntryByDigest(digest)!==undefined;

// The default entry, for callers that predate the catalog.
export const TEXT_CAPABILITY=MODEL_CATALOG[0]!.capability;
export const capabilityDigest=MODEL_CATALOG[0]!.capabilityDigest;
export const ARTIFACTS=Object.freeze({runtime:RUNTIME_ARTIFACTS.cpu[0]!,model:MODEL_CATALOG[0]!.artifacts[0]!,runtimeLicense:RUNTIME_LICENCE,modelLicense:MODEL_CATALOG[0]!.artifacts[1]!});

// ---------- Buffered media models (ADR 0007) ----------

/** stable-diffusion.cpp master-869 (commit 07a85c74), the image runtime. Hashes are GitHub's published asset digests. */
const SD_RELEASE="https://github.com/leejet/stable-diffusion.cpp/releases/download/master-869-07a85c7/";
const SD_LICENCE=artifact({ name:"licences/stable-diffusion.cpp-MIT.txt", bytes:1062, sha256:"b53fa08f515cb5a6fff7b9fd8fcd0961a4b80df29d74372d25e1f9171aa042ee", url:"https://raw.githubusercontent.com/leejet/stable-diffusion.cpp/07a85c74cb08cda3aa176f688c5d8f522615e2b9/LICENSE" });
const SD_RUNTIMES:Readonly<Record<Platform,Partial<Record<Backend,readonly Artifact[]>>>>=Object.freeze({
  "win32-x64":Object.freeze({
    cpu:Object.freeze([artifact({ name:"runtime.zip", bytes:17114202, sha256:"55157cc96bfa7f37c5db6e91d302a77ba956273a4dd7cc04a643495d3ac097d6", url:SD_RELEASE+"sd-master-07a85c7-bin-win-cpu-x64.zip" }),SD_LICENCE]),
    cuda:Object.freeze([
      artifact({ name:"runtime.zip", bytes:329470677, sha256:"e83e69b6bf75d6e52bdbd524b5d5044e267b9e73a5d4f9a98a1a3a3543eb0273", url:SD_RELEASE+"sd-master-07a85c7-bin-win-cuda12-x64.zip" }),
      artifact({ name:"cudart.zip", bytes:563452046, sha256:"fe20366827d357c00797eebb58244dddab7fd9a348d70090c3871004c320f38d", url:SD_RELEASE+"cudart-sd-bin-win-cu12-x64.zip" }),SD_LICENCE]),
  }),
  "linux-x64":Object.freeze({
    cpu:Object.freeze([artifact({ name:"runtime.zip", bytes:25288890, sha256:"38dfa88068f0beef416763c96154fc3f24ad8284fa1864fe3118280ef28093ce", url:SD_RELEASE+"sd-master-07a85c7-bin-Linux-Ubuntu-24.04-x86_64.zip" }),SD_LICENCE]),
    vulkan:Object.freeze([artifact({ name:"runtime.zip", bytes:38412182, sha256:"550b4b3bb0b0e98c13ba7569e39e2ec90b9f8fa9e3dd641689e835278000555f", url:SD_RELEASE+"sd-master-07a85c7-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip" }),SD_LICENCE]),
  }),
});
export type MediaRuntime="llama.cpp"|"stable-diffusion.cpp";
export const sdServerExecutable=(platform:Platform):string=>platform==="win32-x64"?"sd-server.exe":"sd-server";
/** stable-diffusion.cpp's Windows ggml DLLs also import the OpenMP runtime (VCOMP140.DLL) from the same Visual C++
 * 14.51.36247.0 redistributable, which a clean Windows Server lacks. Checked against the pinned CPU zip's imports. */
export const SD_RUNTIME_REDIST:readonly RedistFile[]=Object.freeze([...RUNTIME_REDIST,
  Object.freeze({name:"vcomp140.dll",bytes:212920,sha256:"95d4ce4a6802d1e18b5e0e1722cc30ea72ca7e033f83828f05c0b7b993fe7cbf"})]);
/** The pinned stable-diffusion.cpp files for a backend on a platform (the current machine's by default). */
export function sdRuntimeArtifacts(backend:Backend,platform:Platform=currentPlatform()??"win32-x64"):readonly Artifact[] {
  const artifacts=SD_RUNTIMES[platform][backend];
  if(!artifacts)throw new AdapterError("BACKEND_UNSUPPORTED_ON_PLATFORM");
  return artifacts;
}
export interface MediaModelEntry {
  readonly id:string; readonly kind:MediaKind; readonly displayName:string; readonly parameters:string; readonly quantization:string;
  readonly runtime:MediaRuntime;
  /** Resident memory on CPU and GPU memory for full offload. */
  readonly minMemoryMb:number; readonly minVramMb:number;
  /** Image models too slow for CPU suppliers are GPU-only. */
  readonly gpuOnly:boolean;
  readonly artifacts:readonly Artifact[];
  readonly capability:Readonly<Record<string,unknown>> & {readonly kind:MediaKind;readonly meteringUnit:string;readonly model:string;readonly runtime:string};
  readonly capabilityDigest:string;
}
const HF=(repository:string,revision:string,file:string)=>`https://huggingface.co/${repository}/resolve/${revision}/${file}`;
function media(input:Omit<MediaModelEntry,"capability"|"capabilityDigest"> & {repository:string;revision:string;licence:string;limits:Record<string,unknown>}):MediaModelEntry {
  const {repository,revision,licence,limits,...entry}=input;
  const runtime=entry.runtime==="llama.cpp"
    ?{runtime:"llama.cpp-b10809",runtimeCommit:"5266f24da75dc449bd56cbed7addb9c8e4a6a73e"}
    :{runtime:"stable-diffusion.cpp-master-869",runtimeCommit:"07a85c74cb08cda3aa176f688c5d8f522615e2b9"};
  const meteringUnit=entry.kind==="embedding"?"input_token":entry.kind==="transcription"?"audio_second":"image";
  const capability=Object.freeze({
    version:1,adapterId:"excess.media-"+entry.kind,adapterVersion:"0.1.0",kind:entry.kind,...runtime,
    modelId:entry.id,model:entry.displayName,modelRepository:repository,modelRevision:revision,
    modelFiles:Object.fromEntries(entry.artifacts.map(item=>[item.name,item.sha256])),
    runtimeLicence:"MIT",modelLicence:licence,meteringUnit,trustClass:"supplier_visible",deliveryMode:"buffered",billingPolicy:"delivered_units_v1",
    limits:Object.freeze(limits),slots:1,
  });
  return Object.freeze({...entry,artifacts:Object.freeze([...entry.artifacts]),capability,capabilityDigest:requestDigest(capability)});
}
/** Pinned buffered media models, checked against Hugging Face on 15 September 2026. */
export const MEDIA_CATALOG:readonly MediaModelEntry[]=Object.freeze([
  media({ id:"qwen3-embedding-0.6b", kind:"embedding", displayName:"Qwen3 Embedding 0.6B", parameters:"0.6B", quantization:"Q8_0", runtime:"llama.cpp",
    minMemoryMb:1536, minVramMb:1024, gpuOnly:false, repository:"Qwen/Qwen3-Embedding-0.6B-GGUF", revision:"370f27d7550e0def9b39c1f16d3fbaa13aa67728", licence:"Apache-2.0",
    artifacts:[artifact({ name:"model.gguf", bytes:639150592, sha256:"06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439", url:HF("Qwen/Qwen3-Embedding-0.6B-GGUF","370f27d7550e0def9b39c1f16d3fbaa13aa67728","Qwen3-Embedding-0.6B-Q8_0.gguf") })],
    limits:{maxInputs:64,maxInputBytes:8192,maxTotalBytes:65536,maxInputTokens:32768,dimensions:1024,pooling:"last",normalize:"euclidean"} }),
  media({ id:"qwen3-asr-0.6b", kind:"transcription", displayName:"Qwen3 ASR 0.6B", parameters:"0.6B", quantization:"Q8_0", runtime:"llama.cpp",
    minMemoryMb:2048, minVramMb:1536, gpuOnly:false, repository:"ggml-org/Qwen3-ASR-0.6B-GGUF", revision:"928ab958557df9aa2ef1c93e0e83c7ad0933fae2", licence:"Apache-2.0",
    artifacts:[
      artifact({ name:"model.gguf", bytes:804749248, sha256:"bca259818b50ca7c4c05e9bdb35a5dc04fa039653a6d6f3f0f331f96f6aa1971", url:HF("ggml-org/Qwen3-ASR-0.6B-GGUF","928ab958557df9aa2ef1c93e0e83c7ad0933fae2","Qwen3-ASR-0.6B-Q8_0.gguf") }),
      artifact({ name:"mmproj.gguf", bytes:214392480, sha256:"41a342b5e4c514e968cb756de6cd1b7be39eff43c44c57a2ef5fc6522e36603d", url:HF("ggml-org/Qwen3-ASR-0.6B-GGUF","928ab958557df9aa2ef1c93e0e83c7ad0933fae2","mmproj-Qwen3-ASR-0.6B-Q8_0.gguf") })],
    limits:{audioFormat:"wav-pcm16-mono-16khz",minSeconds:1,maxSeconds:300,maxTranscriptBytes:65536} }),
  media({ id:"sd-turbo", kind:"image", displayName:"SD-Turbo", parameters:"1B", quantization:"Q8_0", runtime:"stable-diffusion.cpp",
    minMemoryMb:4096, minVramMb:3072, gpuOnly:false, repository:"Green-Sky/SD-Turbo-GGUF", revision:"19a31586d02d64a73b4419bc193b3ecfaf38e1f0", licence:"Stability-AI-Community",
    artifacts:[artifact({ name:"model.gguf", bytes:2023745376, sha256:"d50be7655f0a554cf8041c145d88b210bd5f3c545423119dee62ae08cae51580", url:HF("Green-Sky/SD-Turbo-GGUF","19a31586d02d64a73b4419bc193b3ecfaf38e1f0","sd_turbo-f16-q8_0.gguf") })],
    limits:{sizes:[512],maxSteps:4,maxImages:4,maxPromptBytes:2048,cfgScale:"1.0",format:"png"} }),
  media({ id:"flux1-schnell", kind:"image", displayName:"FLUX.1 schnell", parameters:"12B", quantization:"Q4_0", runtime:"stable-diffusion.cpp",
    minMemoryMb:16384, minVramMb:12288, gpuOnly:true, repository:"second-state/FLUX.1-schnell-GGUF", revision:"8c45a2ba25e2d02bd34230989fb54983f39e44ec", licence:"Apache-2.0",
    artifacts:[
      artifact({ name:"diffusion.gguf", bytes:6688845536, sha256:"b338a7ab5c81600a54be46c4cf950edb3761a52ae163e419beafd250976fb566", url:HF("second-state/FLUX.1-schnell-GGUF","8c45a2ba25e2d02bd34230989fb54983f39e44ec","flux1-schnell-Q4_0.gguf") }),
      artifact({ name:"t5xxl.gguf", bytes:2752841312, sha256:"098daa07ac5a926ebf2814a8e02ef1221eee53b8268db0d965ecb608603682de", url:HF("second-state/FLUX.1-schnell-GGUF","8c45a2ba25e2d02bd34230989fb54983f39e44ec","t5xxl-Q4_0.gguf") }),
      artifact({ name:"clip_l.gguf", bytes:130769600, sha256:"59cbe002c3e75d2b89d38787e81d12fb4e512fd76176884c470737ad87a1d309", url:HF("second-state/FLUX.1-schnell-GGUF","8c45a2ba25e2d02bd34230989fb54983f39e44ec","clip_l-Q8_0.gguf") }),
      artifact({ name:"ae.gguf", bytes:167656704, sha256:"1bed7b05318709e46a8cb9accc211168fc7f0b61ab594661860bbfe4d785cc46", url:HF("second-state/FLUX.1-schnell-GGUF","8c45a2ba25e2d02bd34230989fb54983f39e44ec","ae-f16.gguf") })],
    limits:{sizes:[512,768,1024],maxSteps:8,maxImages:4,maxPromptBytes:2048,cfgScale:"1.0",format:"png"} }),
]);
export function mediaCatalogEntry(id:string):MediaModelEntry {
  const entry=MEDIA_CATALOG.find(item=>item.id===id);
  if(!entry)throw new AdapterError("UNKNOWN_MODEL");
  return entry;
}
export const mediaEntryByDigest=(digest:string):MediaModelEntry|undefined=>MEDIA_CATALOG.find(item=>item.capabilityDigest===digest);
export const isMediaCapability=(digest:unknown):boolean=>typeof digest==="string"&&mediaEntryByDigest(digest)!==undefined;

export type TextRequest=z.infer<typeof textRequestSchema>;
export type TextResult=z.infer<typeof textResultSchema>;
export class AdapterError extends Error { constructor(public readonly code:string,options?:{cause?:unknown}){super(code,options);this.name="AdapterError";} }
export function parseTextRequest(input:unknown):TextRequest {const r=textRequestSchema.safeParse(input);if(!r.success)throw new AdapterError("INVALID_TEXT_REQUEST");return r.data;}
export function parseTextResult(input:unknown):TextResult {const r=textResultSchema.safeParse(input);if(!r.success)throw new AdapterError("INVALID_TEXT_RESULT");return r.data;}
