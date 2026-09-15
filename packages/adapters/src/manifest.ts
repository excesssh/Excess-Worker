import { requestDigest,textRequestSchema,textResultSchema } from "@excess/protocol";
import { z } from "zod";

export interface Artifact { readonly name:string; readonly bytes:number; readonly sha256:string; readonly url:string }
const artifact=(value:Artifact):Artifact=>Object.freeze({...value});
const RELEASE="https://github.com/ggml-org/llama.cpp/releases/download/b10809/";
const RUNTIME_LICENCE=artifact({ name:"licences/llama.cpp-MIT.txt", bytes:1078, sha256:"94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d", url:"https://raw.githubusercontent.com/ggml-org/llama.cpp/5266f24da75dc449bd56cbed7addb9c8e4a6a73e/LICENSE" });

/** Pinned llama.cpp b10809 builds. Every backend runs the same release, so a model's capability is backend-independent. */
export type Backend="cpu"|"cuda";
export const BACKENDS:readonly Backend[]=Object.freeze(["cpu","cuda"]);
export const RUNTIME_ARTIFACTS:Readonly<Record<Backend,readonly Artifact[]>>=Object.freeze({
  cpu:Object.freeze([
    artifact({ name:"runtime.zip", bytes:18407457, sha256:"9df3158ed228a641a4b127942d7f459f24c9e13f04682659d05c00c80099b6b5", url:RELEASE+"llama-b10809-bin-win-cpu-x64.zip" }),
    RUNTIME_LICENCE]),
  // CUDA 12.4 runs on drivers that report CUDA 12.4 or newer (verified with driver 596.49, CUDA 13.2).
  cuda:Object.freeze([
    artifact({ name:"runtime.zip", bytes:253938543, sha256:"c77bfcd9ed8d91e8721a2d6a290b907fddd4fa5412a47b21c6fa1709116b85f9", url:RELEASE+"llama-b10809-bin-win-cuda-12.4-x64.zip" }),
    artifact({ name:"cudart.zip", bytes:391443627, sha256:"8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6", url:RELEASE+"cudart-llama-bin-win-cuda-12.4-x64.zip" }),
    RUNTIME_LICENCE]),
});

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
    version:2,adapterId:"excess.llama-text",adapterVersion:"0.3.0",platform:"win32-x64",
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

export type TextRequest=z.infer<typeof textRequestSchema>;
export type TextResult=z.infer<typeof textResultSchema>;
export class AdapterError extends Error { constructor(public readonly code:string,options?:{cause?:unknown}){super(code,options);this.name="AdapterError";} }
export function parseTextRequest(input:unknown):TextRequest {const r=textRequestSchema.safeParse(input);if(!r.success)throw new AdapterError("INVALID_TEXT_REQUEST");return r.data;}
export function parseTextResult(input:unknown):TextResult {const r=textResultSchema.safeParse(input);if(!r.success)throw new AdapterError("INVALID_TEXT_RESULT");return r.data;}
