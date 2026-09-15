import { requestDigest,textRequestSchema,textResultSchema,type MediaKind } from "@excess/protocol";
import { z } from "zod";
import type { ModelInfo } from "./model-info.js";
import { PROMPT_FORMATS } from "./prompt-format.js";

export class AdapterError extends Error { constructor(public readonly code:string,options?:{cause?:unknown}){super(code,options);this.name="AdapterError";} }

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

const HF=(repository:string,revision:string,file:string)=>`https://huggingface.co/${repository}/resolve/${revision}/${file}`;
const HF_RAW=(repository:string,revision:string,file:string)=>`https://huggingface.co/${repository}/raw/${revision}/${file}`;
const MiB=1024*1024;
export interface ModelEntry {
  readonly id:string; readonly displayName:string; readonly parameters:string; readonly quantization:string;
  /** Resident memory the model needs on CPU, and GPU memory to offload every layer, with an 8,192-token context. */
  readonly minMemoryMb:number; readonly minVramMb:number;
  /** Model files first (one GGUF, or every split part in order), then the pinned licence texts. */
  readonly artifacts:readonly Artifact[];
  readonly capability:Readonly<Record<string,unknown>> & {readonly model:string;readonly runtime:string;readonly contextTokens:number;readonly maxOutputTokens:number;
    readonly promptFormat:string;readonly minOutputTokens?:number};
  readonly capabilityDigest:string;
  /** Buyer-facing facts; never part of the capability. */
  readonly info:ModelInfo;
}
/** KV cache geometry from a model's config.json. Sliding-window layers keep only their window. */
export interface KvShape {readonly layers:number;readonly kvHeads:number;readonly headDim:number;readonly slidingLayers?:number;readonly slidingWindow?:number}
/** Memory to serve a text model at its served context, in MiB rounded up to 512:
 *   weights    every GGUF part, resident because the runtime starts with --no-mmap;
 *   KV cache   2 (keys and values) × 2 bytes (f16) × KV heads × head dimension per layer and token, over the whole context for
 *              full-attention layers and over the window plus one 512-token batch for sliding-window layers;
 *   minVramMb  = weights + KV cache + 512 MiB of compute buffers;
 *   minMemoryMb = minVramMb + 512 MiB for host-side buffers and the runtime itself.
 * The Qwen3 entries predate the formula and are kept as published: qwen3-8b and qwen3-14b match it exactly, qwen3-4b's CPU
 * figure is 512 MiB lower (its measured peak was 3,031 MB) and both qwen3-30b-a3b figures are 512 MiB higher. */
export function textMemoryEstimate(weightsBytes:number,shape:KvShape,contextTokens=8192):{minMemoryMb:number;minVramMb:number} {
  const sliding=shape.slidingLayers??0,window=Math.min(contextTokens,(shape.slidingWindow??0)+512);
  const kvBytes=4*shape.kvHeads*shape.headDim*((shape.layers-sliding)*contextTokens+sliding*window);
  const minVramMb=Math.ceil(((weightsBytes+kvBytes)/MiB+512)/512)*512;
  return {minMemoryMb:minVramMb+512,minVramMb};
}
interface TextModelSpec {
  id:string; displayName:string; parameters:string; quantization:string;
  repository:string; revision:string;
  /** One GGUF file, or every part of a split model named <prefix>-0000i-of-0000n.gguf, in order. */
  files:readonly {file:string;bytes:number;sha256:string}[];
  licence:string; licenceFiles:readonly Artifact[];
  promptFormat:string; sampling:{temperature:string;topP:string;topK:number;minP:string;presencePenalty:string;repeatPenalty:string};
  memory:KvShape|{minMemoryMb:number;minVramMb:number};
  info:ModelInfo;
  /** The four original Qwen3 entries keep their version 3 capability byte for byte; suppliers and approvals depend on it. */
  legacy?:true;
}
const part=(index:number)=>String(index).padStart(5,"0");
// Split parts install as model-0000i-of-0000n.gguf, so llama.cpp finds every part from the first one by its standard name.
function textModel(spec:TextModelSpec):ModelEntry {
  const format=PROMPT_FORMATS[spec.promptFormat],count=spec.files.length;
  if(!format||count<1||count>99)throw new AdapterError("INVALID_CATALOG_ENTRY");
  if(count>1&&!spec.files.every((item,index)=>item.file.endsWith(`-${part(index+1)}-of-${part(count)}.gguf`)))throw new AdapterError("INVALID_SPLIT_MODEL");
  const models=spec.files.map((item,index)=>artifact({name:count>1?`model-${part(index+1)}-of-${part(count)}.gguf`:"model.gguf",bytes:item.bytes,sha256:item.sha256,url:HF(spec.repository,spec.revision,item.file)}));
  const first=spec.files[0]!,model=first.file.replace(/(-\d{5}-of-\d{5})?\.gguf$/,""),reasoning=format.answerMarker!==undefined;
  const {temperature,topP,topK,minP,presencePenalty,repeatPenalty}=spec.sampling;
  const runtime={runtime:"llama.cpp-b10809",runtimeCommit:"5266f24da75dc449bd56cbed7addb9c8e4a6a73e"};
  const limits={contextTokens:8192,maxPromptBytes:16384,maxOutputBytes:65536,maxOutputTokens:2048,slots:1};
  const capability=spec.legacy
    ?Object.freeze({
      // Version 3 drops the platform field: Windows and Linux suppliers run the same pinned release and model file.
      version:3,adapterId:"excess.llama-text",adapterVersion:"0.4.0",...runtime,
      modelId:spec.id,model,modelRevision:spec.revision,modelSha256:first.sha256,
      runtimeLicence:"MIT",modelLicence:spec.licence,meteringUnit:"output_token",trustClass:"supplier_visible",...limits,
      promptFormat:spec.promptFormat,temperature,topP,topK,presencePenalty,
    })
    :Object.freeze({
      // Version 4 names the repository, pins every model file (split parts included) and the whole sampling set, and says
      // whether reasoning tokens are hidden. Reasoning models refuse output budgets too small to reach an answer.
      version:4,adapterId:"excess.llama-text",adapterVersion:"0.5.0",...runtime,
      modelId:spec.id,model,modelRepository:spec.repository,modelRevision:spec.revision,
      modelFiles:Object.freeze(Object.fromEntries(models.map(item=>[item.name,item.sha256]))),
      runtimeLicence:"MIT",modelLicence:spec.licence,meteringUnit:"output_token",trustClass:"supplier_visible",...limits,
      promptFormat:spec.promptFormat,temperature,topP,topK,minP,presencePenalty,repeatPenalty,
      reasoning:reasoning?"hidden_billed":"none",minOutputTokens:reasoning?REASONING_MIN_OUTPUT_TOKENS:1,
    });
  const memory="layers" in spec.memory?textMemoryEstimate(models.reduce((sum,item)=>sum+item.bytes,0),spec.memory,limits.contextTokens):spec.memory;
  return Object.freeze({id:spec.id,displayName:spec.displayName,parameters:spec.parameters,quantization:spec.quantization,...memory,
    artifacts:Object.freeze([...models,...spec.licenceFiles]),capability,capabilityDigest:requestDigest(capability),info:Object.freeze({...spec.info,modalities:Object.freeze([...spec.info.modalities])})});
}
/** Reasoning models need room for their hidden analysis before the answer; smaller output budgets are refused at quote time. */
export const REASONING_MIN_OUTPUT_TOKENS=256;
/** Output budget of the local probe: eight tokens, or enough for a reasoning model to reach its answer. */
export const textProbeTokens=(entry:ModelEntry):number=>entry.capability.reasoning==="hidden_billed"?REASONING_MIN_OUTPUT_TOKENS:8;
const TEXT_ONLY=Object.freeze(["text"] as const);
const QWEN_SAMPLING={temperature:"0.7",topP:"0.8",topK:20,minP:"0",presencePenalty:"1.5",repeatPenalty:"1"};
const qwen3=(id:string,displayName:string,parameters:string,repository:string,revision:string,file:string,bytes:number,sha256:string,
  memory:{minMemoryMb:number;minVramMb:number},info:Omit<ModelInfo,"publisher"|"family"|"contextTokens"|"licence"|"format"|"modalities"|"reasoning">)=>
  textModel({id,displayName,parameters,quantization:"Q4_K_M",repository:"Qwen/"+repository,revision,files:[{file,bytes,sha256}],licence:"Apache-2.0",
    licenceFiles:[artifact({name:"licences/Qwen3-Apache-2.0.txt",bytes:11544,sha256:"5de36594c10839788a8c589443a8ef9d8b8d17c65a1b5807206ae037fc36c6bd",url:HF_RAW("Qwen/"+repository,revision,"LICENSE")})],
    promptFormat:"qwen3-chatml-no-thinking-v1",sampling:QWEN_SAMPLING,memory,legacy:true,
    info:{publisher:"Alibaba Qwen",family:"Qwen3",contextTokens:8192,licence:"Apache-2.0",format:"GGUF Q4_K_M",modalities:TEXT_ONLY,reasoning:false,...info}});
const gptOssLicences=(repository:string,revision:string,policyBytes:number,policySha256:string)=>[
  artifact({name:"licences/gpt-oss-Apache-2.0.txt",bytes:11357,sha256:"58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd",url:HF_RAW(repository,revision,"LICENSE")}),
  artifact({name:"licences/gpt-oss-USAGE_POLICY.txt",bytes:policyBytes,sha256:policySha256,url:HF_RAW(repository,revision,"USAGE_POLICY")})];
// Meta publishes the Llama licences and use policies in its llama-models repository; the weights come from ungated GGUF conversions.
const LLAMA_MODELS="https://raw.githubusercontent.com/meta-llama/llama-models/0e0b8c519242d5833d8c11bffc1232b77ad7f301/models/";
const llamaLicences=(version:"3.1"|"3.3",licence:[number,string],policy:[number,string])=>[
  artifact({name:`licences/Llama-${version}-Community-License.txt`,bytes:licence[0],sha256:licence[1],url:`${LLAMA_MODELS}llama${version.replace(".","_")}/LICENSE`}),
  artifact({name:`licences/Llama-${version}-Acceptable-Use-Policy.md`,bytes:policy[0],sha256:policy[1],url:`${LLAMA_MODELS}llama${version.replace(".","_")}/USE_POLICY.md`})];

/** The curated model catalog. Suppliers choose which entries to install and run; each entry is pinned to an exact
 * repository revision and file hash, so buyers get exactly the model they pay for. Sizes, hashes and licence files were
 * checked against Hugging Face and GitHub metadata on 15 September 2026; sampling follows each model card. Only ungated
 * repositories whose publisher ships a licence file are used, which is why Gemma 3 and Mistral Small are not listed.
 * Entries are listed from the smallest memory requirement up; qwen3-4b stays first as the default. */
export const MODEL_CATALOG:readonly ModelEntry[]=Object.freeze(([
  qwen3("qwen3-4b","Qwen3 4B","4B","Qwen3-4B-GGUF","bc640142c66e1fdd12af0bd68f40445458f3869b","Qwen3-4B-Q4_K_M.gguf",2497280256,"7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5",{minMemoryMb:4096,minVramMb:4096},
    {summary:"A small, fast general-purpose chat model for everyday questions, writing and translation.",parametersB:4.0,maxContextTokens:32768,sourceUrl:"https://huggingface.co/Qwen/Qwen3-4B",released:"2025-04"}),
  qwen3("qwen3-8b","Qwen3 8B","8B","Qwen3-8B-GGUF","7c41481f57cb95916b40956ab2f0b139b296d974","Qwen3-8B-Q4_K_M.gguf",5027783488,"d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785",{minMemoryMb:7168,minVramMb:6656},
    {summary:"A general-purpose chat model with a good balance of quality and speed on modest hardware.",parametersB:8.2,maxContextTokens:32768,sourceUrl:"https://huggingface.co/Qwen/Qwen3-8B",released:"2025-04"}),
  qwen3("qwen3-14b","Qwen3 14B","14B","Qwen3-14B-GGUF","530227a7d994db8eca5ab5ced2fb692b614357fd","Qwen3-14B-Q4_K_M.gguf",9001752960,"500a8806e85ee9c83f3ae08420295592451379b4f8cf2d0f41c15dffeb6b81f0",{minMemoryMb:11264,minVramMb:10752},
    {summary:"A stronger general-purpose chat model for longer writing, analysis and multilingual work.",parametersB:14.8,maxContextTokens:32768,sourceUrl:"https://huggingface.co/Qwen/Qwen3-14B",released:"2025-04"}),
  qwen3("qwen3-30b-a3b","Qwen3 30B-A3B (fast mixture-of-experts)","30B (3B active)","Qwen3-30B-A3B-GGUF","e4d4bafdfb96a411a163846265362aceb0b9c63a","Qwen3-30B-A3B-Q4_K_M.gguf",18556685824,"0d003f6662faee786ed5da3e31b29c978de5ae5d275c8794c606a7f3c01aa8f5",{minMemoryMb:20480,minVramMb:19968},
    {summary:"A mixture-of-experts chat model with 30B-class quality that runs at the speed of a 3B model.",parametersB:30.5,activeParametersB:3.3,maxContextTokens:32768,sourceUrl:"https://huggingface.co/Qwen/Qwen3-30B-A3B",released:"2025-04"}),
  textModel({id:"phi-4-mini",displayName:"Phi-4 mini 3.8B",parameters:"3.8B",quantization:"Q4_K_M",
    repository:"unsloth/Phi-4-mini-instruct-GGUF",revision:"78eb92a46fc37e6b524df991ed9aca9bc6aa7b80",
    files:[{file:"Phi-4-mini-instruct-Q4_K_M.gguf",bytes:2491874272,sha256:"88c00229914083cd112853aab84ed51b87bdf6b9ce42f532d8c85c7c63b1730a"}],
    licence:"MIT",licenceFiles:[artifact({name:"licences/Phi-4-mini-MIT.txt",bytes:1084,sha256:"fa8235e5b48faca34e3ca98cf4f694ef08bd216d28b58071a1f85b1d50cb814d",url:HF_RAW("microsoft/Phi-4-mini-instruct","cfbefacb99257ffa30c83adab238a50856ac3083","LICENSE")})],
    // The card's examples decode greedily (temperature 0).
    promptFormat:"phi4-mini-chat-v1",sampling:{temperature:"0",topP:"1",topK:0,minP:"0",presencePenalty:"0",repeatPenalty:"1"},
    memory:{layers:32,kvHeads:8,headDim:128},
    info:{publisher:"Microsoft",family:"Phi-4",summary:"A compact model tuned for reasoning-dense instructions, maths and short structured answers on small machines.",
      parametersB:3.8,contextTokens:8192,maxContextTokens:131072,licence:"MIT",sourceUrl:"https://huggingface.co/microsoft/Phi-4-mini-instruct",format:"GGUF Q4_K_M",modalities:TEXT_ONLY,reasoning:false,released:"2025-02"}}),
  textModel({id:"llama-3.1-8b",displayName:"Llama 3.1 8B Instruct",parameters:"8B",quantization:"Q4_K_M",
    repository:"unsloth/Llama-3.1-8B-Instruct-GGUF",revision:"600b0020115fd6b17f0752848fe7b5a1be686bcd",
    files:[{file:"Llama-3.1-8B-Instruct-Q4_K_M.gguf",bytes:4920739200,sha256:"b3bdbf23b47d7e6bb791c99b206deb169cd5a96362a9e3399028df2faacdc506"}],
    licence:"Llama-3.1-Community",licenceFiles:llamaLicences("3.1",[7680,"bf2eac60b81e5c5f779fc3b4849d3bfacfd63f97f3eb68b44e9c6868c5801712"],[4673,"f456a3f5b15ab588c84d06cf095a245bfee0bbc1620b48ed00af2cca4a711735"]),
    // Meta's generation_config and reference sampler: temperature 0.6 and top-p 0.9, no top-k.
    promptFormat:"llama3-chat-v1",sampling:{temperature:"0.6",topP:"0.9",topK:0,minP:"0",presencePenalty:"0",repeatPenalty:"1"},
    memory:{layers:32,kvHeads:8,headDim:128},
    info:{publisher:"Meta",family:"Llama 3.1",summary:"Meta's widely used 8B instruction model for multilingual chat, summaries and drafting.",
      parametersB:8.0,contextTokens:8192,maxContextTokens:131072,licence:"Llama 3.1 Community",sourceUrl:"https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct",format:"GGUF Q4_K_M",modalities:TEXT_ONLY,reasoning:false,released:"2024-07"}}),
  textModel({id:"phi-4",displayName:"Phi-4 14B",parameters:"14B",quantization:"Q4_K_M",
    // Microsoft names this file Q4_K, llama-quantize's alias for Q4_K_M (it matches other Q4_K_M conversions to within 256 bytes of metadata).
    repository:"microsoft/phi-4-gguf",revision:"6edc2ef6664b739a8e11e62f2672ff6afe0c15ac",
    files:[{file:"phi-4-Q4_K.gguf",bytes:9053114560,sha256:"5652b9be0ea4ae2842130d04fe31bc869fcb99a2b7106c53b4e754a343fd688f"}],
    licence:"MIT",licenceFiles:[artifact({name:"licences/Phi-4-MIT.txt",bytes:1105,sha256:"c49419617a6070bcb197cfe272f7007fdec3e790dbb529cb995473bd69c0bd51",url:HF_RAW("microsoft/phi-4-gguf","6edc2ef6664b739a8e11e62f2672ff6afe0c15ac","LICENSE")})],
    // The model card's inference settings use temperature 0.
    promptFormat:"phi4-chatml-v1",sampling:{temperature:"0",topP:"1",topK:0,minP:"0",presencePenalty:"0",repeatPenalty:"1"},
    memory:{layers:40,kvHeads:10,headDim:128},
    info:{publisher:"Microsoft",family:"Phi-4",summary:"A 14B model trained heavily on synthetic reasoning data; strong at maths, logic and careful step-by-step answers.",
      parametersB:14.7,contextTokens:8192,maxContextTokens:16384,licence:"MIT",sourceUrl:"https://huggingface.co/microsoft/phi-4",format:"GGUF Q4_K_M",modalities:TEXT_ONLY,reasoning:false,released:"2024-12"}}),
  textModel({id:"gpt-oss-20b",displayName:"gpt-oss 20B (reasoning)",parameters:"21B (3.6B active)",quantization:"MXFP4",
    repository:"ggml-org/gpt-oss-20b-GGUF",revision:"ef9b12f2ff56c69cf32153a02784e7a3c88bf524",
    files:[{file:"gpt-oss-20b-MXFP4.gguf",bytes:12109566624,sha256:"27cd6c432c7672cb812a92f611cf3ba7bbc35928262bb1e1253ff4ee6ae35901"}],
    licence:"Apache-2.0",licenceFiles:gptOssLicences("openai/gpt-oss-20b","6cee5e81ee83917806bbde320786a8fb61efebee",200,"d6387ef7985019c45db8d9801e6ac5fd9f98f02b9f1c56f8c5af80c3e8f385d0"),
    // OpenAI recommends temperature 1.0 and top-p 1.0 for gpt-oss; top-k is disabled.
    promptFormat:"gpt-oss-harmony-low-v1",sampling:{temperature:"1",topP:"1",topK:0,minP:"0",presencePenalty:"0",repeatPenalty:"1"},
    memory:{layers:24,kvHeads:8,headDim:64,slidingLayers:12,slidingWindow:128},
    info:{publisher:"OpenAI",family:"gpt-oss",summary:"OpenAI's open-weight reasoning model: it thinks briefly (low effort) before answering, which helps with maths, code and multi-step questions.",
      parametersB:20.9,activeParametersB:3.6,contextTokens:8192,maxContextTokens:131072,licence:"Apache-2.0",sourceUrl:"https://huggingface.co/openai/gpt-oss-20b",format:"GGUF MXFP4",modalities:TEXT_ONLY,reasoning:true,released:"2025-08"}}),
  textModel({id:"qwen3-coder-30b-a3b",displayName:"Qwen3 Coder 30B-A3B",parameters:"30B (3B active)",quantization:"Q4_K_M",
    repository:"unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF",revision:"b17cb02dd882d5b6ab62fc777ad2995f19668350",
    files:[{file:"Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf",bytes:18556689568,sha256:"fadc3e5f8d42bf7e894a785b05082e47daee4df26680389817e2093056f088ad"}],
    licence:"Apache-2.0",licenceFiles:[artifact({name:"licences/Qwen3-Coder-Apache-2.0.txt",bytes:11343,sha256:"832dd9e00a68dd83b3c3fb9f5588dad7dcf337a0db50f7d9483f310cd292e92e",url:HF_RAW("Qwen/Qwen3-Coder-30B-A3B-Instruct","b2cff646eb4bb1d68355c01b18ae02e7cf42d120","LICENSE")})],
    promptFormat:"qwen3-chatml-instruct-v1",sampling:{temperature:"0.7",topP:"0.8",topK:20,minP:"0",presencePenalty:"0",repeatPenalty:"1.05"},
    memory:{layers:48,kvHeads:4,headDim:128},
    info:{publisher:"Alibaba Qwen",family:"Qwen3-Coder",summary:"A fast mixture-of-experts coding model for writing, explaining and fixing code.",
      parametersB:30.5,activeParametersB:3.3,contextTokens:8192,maxContextTokens:262144,licence:"Apache-2.0",sourceUrl:"https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct",format:"GGUF Q4_K_M",modalities:TEXT_ONLY,reasoning:false,released:"2025-07"}}),
  textModel({id:"qwen3-30b-a3b-instruct-2507",displayName:"Qwen3 30B-A3B Instruct 2507",parameters:"30B (3B active)",quantization:"Q4_K_M",
    repository:"unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF",revision:"eea7b2be5805a5f151f8847ede8e5f9a9284bf77",
    files:[{file:"Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf",bytes:18556686752,sha256:"6c997b8af17debdfb01d890214400ccbab00db6acc0ba8da5de1cc906c4774d0"}],
    licence:"Apache-2.0",licenceFiles:[artifact({name:"licences/Qwen3-2507-Apache-2.0.txt",bytes:11343,sha256:"05cab46843576551502bfdf712f84e93e6e9590d9997306ed4f6635ef82811d9",url:HF_RAW("Qwen/Qwen3-30B-A3B-Instruct-2507","0d7cf23991f47feeb3a57ecb4c9cee8ea4a17bfe","LICENSE")})],
    promptFormat:"qwen3-chatml-instruct-v1",sampling:{temperature:"0.7",topP:"0.8",topK:20,minP:"0",presencePenalty:"0",repeatPenalty:"1"},
    memory:{layers:48,kvHeads:4,headDim:128},
    info:{publisher:"Alibaba Qwen",family:"Qwen3",summary:"The July 2025 update of Qwen3 30B-A3B without thinking: better instruction following, writing and knowledge at mixture-of-experts speed.",
      parametersB:30.5,activeParametersB:3.3,contextTokens:8192,maxContextTokens:262144,licence:"Apache-2.0",sourceUrl:"https://huggingface.co/Qwen/Qwen3-30B-A3B-Instruct-2507",format:"GGUF Q4_K_M",modalities:TEXT_ONLY,reasoning:false,released:"2025-07"}}),
  textModel({id:"qwen3-32b",displayName:"Qwen3 32B",parameters:"32B",quantization:"Q4_K_M",
    repository:"Qwen/Qwen3-32B-GGUF",revision:"938a7432affaec9157f883a87164e2646ae17555",
    files:[{file:"Qwen3-32B-Q4_K_M.gguf",bytes:19762149024,sha256:"efd971561896866f0e910cce52761ca77b1b138090c7f15fe284676d57d1f689"}],
    licence:"Apache-2.0",licenceFiles:[artifact({name:"licences/Qwen3-Apache-2.0.txt",bytes:11544,sha256:"5de36594c10839788a8c589443a8ef9d8b8d17c65a1b5807206ae037fc36c6bd",url:HF_RAW("Qwen/Qwen3-32B-GGUF","938a7432affaec9157f883a87164e2646ae17555","LICENSE")})],
    promptFormat:"qwen3-chatml-no-thinking-v1",sampling:QWEN_SAMPLING,
    memory:{layers:64,kvHeads:8,headDim:128},
    info:{publisher:"Alibaba Qwen",family:"Qwen3",summary:"The largest dense Qwen3 model, served with thinking switched off: high-quality writing, analysis and multilingual answers.",
      parametersB:32.8,contextTokens:8192,maxContextTokens:32768,licence:"Apache-2.0",sourceUrl:"https://huggingface.co/Qwen/Qwen3-32B",format:"GGUF Q4_K_M",modalities:TEXT_ONLY,reasoning:false,released:"2025-04"}}),
  textModel({id:"llama-3.3-70b",displayName:"Llama 3.3 70B Instruct",parameters:"70B",quantization:"Q4_K_M",
    repository:"unsloth/Llama-3.3-70B-Instruct-GGUF",revision:"8f14c5c5d06fca109ff16f94496147a8479711de",
    files:[{file:"Llama-3.3-70B-Instruct-Q4_K_M.gguf",bytes:42520398432,sha256:"d7f4f209208f984fe95af82d014171f9d05427029746b1ae08297f102a6ddee4"}],
    licence:"Llama-3.3-Community",licenceFiles:llamaLicences("3.3",[7909,"fb58d9a630ccc1dc0d08f8c00232de56bc73309020f59c8181d0c12ef28d9f8c"],[6020,"fac148bfbd9f515b3a7a9885d5d324187cd2ef9e2dcc9cdde49ef248695f3e07"]),
    promptFormat:"llama3-chat-v1",sampling:{temperature:"0.6",topP:"0.9",topK:0,minP:"0",presencePenalty:"0",repeatPenalty:"1"},
    memory:{layers:80,kvHeads:8,headDim:128},
    info:{publisher:"Meta",family:"Llama 3.3",summary:"Meta's 70B instruction model: strong general knowledge, writing and multilingual chat for machines with about 48 GB of memory.",
      parametersB:70.6,contextTokens:8192,maxContextTokens:131072,licence:"Llama 3.3 Community",sourceUrl:"https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct",format:"GGUF Q4_K_M",modalities:TEXT_ONLY,reasoning:false,released:"2024-12"}}),
  textModel({id:"gpt-oss-120b",displayName:"gpt-oss 120B (reasoning)",parameters:"117B (5.1B active)",quantization:"MXFP4",
    // ggml-org merged its earlier three split parts into this single file in July 2026, before the pinned llama.cpp release.
    repository:"ggml-org/gpt-oss-120b-GGUF",revision:"238abdd290bb874b90a5da1b4549881b7d05c091",
    files:[{file:"gpt-oss-120b-MXFP4.gguf",bytes:63387346208,sha256:"582bd40f6886200101f4c4ed9f25f3fe80cc14c86e9e2b37746cd8904a0c622d"}],
    licence:"Apache-2.0",licenceFiles:gptOssLicences("openai/gpt-oss-120b","b5c939de8f754692c1647ca79fbf85e8c1e70f8a",201,"fc48d386a7a7ff8b066f743cfe62df683ab16892450f5bb7357bb4de261cd037"),
    promptFormat:"gpt-oss-harmony-low-v1",sampling:{temperature:"1",topP:"1",topK:0,minP:"0",presencePenalty:"0",repeatPenalty:"1"},
    memory:{layers:36,kvHeads:8,headDim:64,slidingLayers:18,slidingWindow:128},
    info:{publisher:"OpenAI",family:"gpt-oss",summary:"OpenAI's largest open-weight reasoning model: it thinks briefly (low effort) before answering, for demanding maths, code and analysis on 64 GB-class machines.",
      parametersB:116.8,activeParametersB:5.1,contextTokens:8192,maxContextTokens:131072,licence:"Apache-2.0",sourceUrl:"https://huggingface.co/openai/gpt-oss-120b",format:"GGUF MXFP4",modalities:TEXT_ONLY,reasoning:true,released:"2025-08"}}),
] as ModelEntry[]).sort((a,b)=>a.minMemoryMb-b.minMemoryMb));
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
  /** Buyer-facing facts; never part of the capability. */
  readonly info:ModelInfo;
}
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
  return Object.freeze({...entry,artifacts:Object.freeze([...entry.artifacts]),capability,capabilityDigest:requestDigest(capability),
    info:Object.freeze({...entry.info,modalities:Object.freeze([...entry.info.modalities])})});
}
/** Pinned buffered media models, checked against Hugging Face on 15 September 2026. Their info contextTokens is the prompt
 * window each serves: one embedding input, the transcription context, or the text encoder's chunk (CLIP 77, FLUX's T5 256). */
export const MEDIA_CATALOG:readonly MediaModelEntry[]=Object.freeze([
  media({ id:"qwen3-embedding-0.6b", kind:"embedding", displayName:"Qwen3 Embedding 0.6B", parameters:"0.6B", quantization:"Q8_0", runtime:"llama.cpp",
    info:{publisher:"Alibaba Qwen",family:"Qwen3 Embedding",summary:"Turns up to 64 texts per job into 1,024-dimension vectors for search, clustering and retrieval.",
      parametersB:0.6,contextTokens:8192,maxContextTokens:32768,licence:"Apache-2.0",sourceUrl:"https://huggingface.co/Qwen/Qwen3-Embedding-0.6B",format:"GGUF Q8_0",modalities:["embedding"],reasoning:false,released:"2025-06"},
    minMemoryMb:1536, minVramMb:1024, gpuOnly:false, repository:"Qwen/Qwen3-Embedding-0.6B-GGUF", revision:"370f27d7550e0def9b39c1f16d3fbaa13aa67728", licence:"Apache-2.0",
    artifacts:[artifact({ name:"model.gguf", bytes:639150592, sha256:"06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439", url:HF("Qwen/Qwen3-Embedding-0.6B-GGUF","370f27d7550e0def9b39c1f16d3fbaa13aa67728","Qwen3-Embedding-0.6B-Q8_0.gguf") })],
    limits:{maxInputs:64,maxInputBytes:8192,maxTotalBytes:65536,maxInputTokens:32768,dimensions:1024,pooling:"last",normalize:"euclidean"} }),
  media({ id:"qwen3-asr-0.6b", kind:"transcription", displayName:"Qwen3 ASR 0.6B", parameters:"0.6B", quantization:"Q8_0", runtime:"llama.cpp",
    info:{publisher:"Alibaba Qwen",family:"Qwen3-ASR",summary:"Multilingual speech-to-text for WAV recordings up to five minutes, returned as plain transcript text.",
      parametersB:0.9,contextTokens:8192,licence:"Apache-2.0",sourceUrl:"https://huggingface.co/Qwen/Qwen3-ASR-0.6B",format:"GGUF Q8_0",modalities:["transcription"],reasoning:false,released:"2026-01"},
    minMemoryMb:2048, minVramMb:1536, gpuOnly:false, repository:"ggml-org/Qwen3-ASR-0.6B-GGUF", revision:"928ab958557df9aa2ef1c93e0e83c7ad0933fae2", licence:"Apache-2.0",
    artifacts:[
      artifact({ name:"model.gguf", bytes:804749248, sha256:"bca259818b50ca7c4c05e9bdb35a5dc04fa039653a6d6f3f0f331f96f6aa1971", url:HF("ggml-org/Qwen3-ASR-0.6B-GGUF","928ab958557df9aa2ef1c93e0e83c7ad0933fae2","Qwen3-ASR-0.6B-Q8_0.gguf") }),
      artifact({ name:"mmproj.gguf", bytes:214392480, sha256:"41a342b5e4c514e968cb756de6cd1b7be39eff43c44c57a2ef5fc6522e36603d", url:HF("ggml-org/Qwen3-ASR-0.6B-GGUF","928ab958557df9aa2ef1c93e0e83c7ad0933fae2","mmproj-Qwen3-ASR-0.6B-Q8_0.gguf") })],
    limits:{audioFormat:"wav-pcm16-mono-16khz",minSeconds:1,maxSeconds:300,maxTranscriptBytes:65536} }),
  media({ id:"sd-turbo", kind:"image", displayName:"SD-Turbo", parameters:"1B", quantization:"Q8_0", runtime:"stable-diffusion.cpp",
    info:{publisher:"Stability AI",family:"Stable Diffusion",summary:"A distilled Stable Diffusion 2.1 model that draws 512×512 images in one to four steps, fast enough for CPUs.",
      parametersB:1.3,contextTokens:77,licence:"Stability-AI-Community",sourceUrl:"https://huggingface.co/stabilityai/sd-turbo",format:"GGUF Q8_0",modalities:["image"],reasoning:false,released:"2023-11"},
    minMemoryMb:4096, minVramMb:3072, gpuOnly:false, repository:"Green-Sky/SD-Turbo-GGUF", revision:"19a31586d02d64a73b4419bc193b3ecfaf38e1f0", licence:"Stability-AI-Community",
    artifacts:[artifact({ name:"model.gguf", bytes:2023745376, sha256:"d50be7655f0a554cf8041c145d88b210bd5f3c545423119dee62ae08cae51580", url:HF("Green-Sky/SD-Turbo-GGUF","19a31586d02d64a73b4419bc193b3ecfaf38e1f0","sd_turbo-f16-q8_0.gguf") })],
    limits:{sizes:[512],maxSteps:4,maxImages:4,maxPromptBytes:2048,cfgScale:"1.0",format:"png"} }),
  media({ id:"flux1-schnell", kind:"image", displayName:"FLUX.1 schnell", parameters:"12B", quantization:"Q4_0", runtime:"stable-diffusion.cpp",
    info:{publisher:"Black Forest Labs",family:"FLUX.1",summary:"A 12B image model that follows detailed prompts and renders legible text, in one to eight steps at up to 1,024×1,024 on a GPU.",
      parametersB:12,contextTokens:256,licence:"Apache-2.0",sourceUrl:"https://huggingface.co/black-forest-labs/FLUX.1-schnell",format:"GGUF Q4_0",modalities:["image"],reasoning:false,released:"2024-08"},
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
export function parseTextRequest(input:unknown):TextRequest {const r=textRequestSchema.safeParse(input);if(!r.success)throw new AdapterError("INVALID_TEXT_REQUEST");return r.data;}
export function parseTextResult(input:unknown):TextResult {const r=textResultSchema.safeParse(input);if(!r.success)throw new AdapterError("INVALID_TEXT_RESULT");return r.data;}
