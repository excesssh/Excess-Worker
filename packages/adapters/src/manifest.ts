import { requestDigest,textRequestSchema,textResultSchema } from "@excess/protocol";
import { z } from "zod";

export const ARTIFACTS = Object.freeze({
  runtime: { name:"runtime.zip", bytes:18407457, sha256:"9df3158ed228a641a4b127942d7f459f24c9e13f04682659d05c00c80099b6b5", url:"https://github.com/ggml-org/llama.cpp/releases/download/b10809/llama-b10809-bin-win-cpu-x64.zip" },
  model: { name:"model.gguf", bytes:639446688, sha256:"9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031", url:"https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/23749fefcc72300e3a2ad315e1317431b06b590a/Qwen3-0.6B-Q8_0.gguf" },
  runtimeLicense: { name:"licences/llama.cpp-MIT.txt", bytes:1078, sha256:"94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d", url:"https://raw.githubusercontent.com/ggml-org/llama.cpp/5266f24da75dc449bd56cbed7addb9c8e4a6a73e/LICENSE" },
  modelLicense: { name:"licences/Qwen3-Apache-2.0.txt", bytes:11544, sha256:"5de36594c10839788a8c589443a8ef9d8b8d17c65a1b5807206ae037fc36c6bd", url:"https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/raw/23749fefcc72300e3a2ad315e1317431b06b590a/LICENSE" },
});
for(const artifact of Object.values(ARTIFACTS))Object.freeze(artifact);
export const TEXT_CAPABILITY = Object.freeze({
  version:1,adapterId:"excess.llama-qwen3-cpu",adapterVersion:"0.1.0",backend:"cpu",platform:"win32-x64",
  runtime:"llama.cpp-b10809",runtimeCommit:"5266f24da75dc449bd56cbed7addb9c8e4a6a73e",runtimeSha256:ARTIFACTS.runtime.sha256,
  model:"Qwen3-0.6B-Q8_0",modelRevision:"23749fefcc72300e3a2ad315e1317431b06b590a",modelSha256:ARTIFACTS.model.sha256,
  runtimeLicence:"MIT",modelLicence:"Apache-2.0",meteringUnit:"output_token",trustClass:"supplier_visible",
  contextTokens:4096,maxPromptBytes:4096,maxOutputBytes:8192,maxOutputTokens:128,slots:1,
  promptFormat:"qwen3-chatml-no-thinking-v1",temperature:"0.7",topP:"0.8",topK:20,presencePenalty:"1.5",
});
export const capabilityDigest = requestDigest(TEXT_CAPABILITY);
export type TextRequest=z.infer<typeof textRequestSchema>;
export type TextResult=z.infer<typeof textResultSchema>;
export class AdapterError extends Error { constructor(public readonly code:string){super(code);this.name="AdapterError";} }
export function parseTextRequest(input:unknown):TextRequest {const r=textRequestSchema.safeParse(input);if(!r.success)throw new AdapterError("INVALID_TEXT_REQUEST");return r.data;}
export function parseTextResult(input:unknown):TextResult {const r=textResultSchema.safeParse(input);if(!r.success)throw new AdapterError("INVALID_TEXT_RESULT");return r.data;}
