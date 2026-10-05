import { z } from "zod";

export const RUNTIME_PATHS=["/health","/tokenize","/completion","/detokenize","/v1/embeddings","/v1/chat/completions","/v1/models","/v1/images/generations"] as const;
export const MAX_RUNTIME_BODY_BYTES=16*1024*1024,MAX_RUNTIME_RESPONSE_BYTES=64*1024*1024,MAX_RUNTIME_CHUNK_BYTES=64*1024;
const id=z.number().int().min(1).max(2147483647);
export const runtimeRequestSchema=z.strictObject({type:z.literal("request"),id,method:z.enum(["GET","POST"]),path:z.enum(RUNTIME_PATHS),
  body:z.string().max(MAX_RUNTIME_BODY_BYTES).optional()});
export const runtimeControlSchema=z.strictObject({type:z.enum(["next","cancel"]),id});
export const runtimeResponseSchema=z.discriminatedUnion("type",[
  z.strictObject({type:z.literal("response"),id,status:z.number().int().min(200).max(599),headers:z.record(z.string().max(64),z.string().max(256)).optional()}),
  z.strictObject({type:z.literal("data"),id,data:z.string().max(Math.ceil(MAX_RUNTIME_CHUNK_BYTES/3)*4)}),
  z.strictObject({type:z.literal("end"),id}),
  z.strictObject({type:z.literal("error"),id,error:z.string().regex(/^[A-Z_]{1,64}$/)}),
]);
export type RuntimeRequest=z.infer<typeof runtimeRequestSchema>;
export type RuntimeControl=z.infer<typeof runtimeControlSchema>;
export type RuntimeResponse=z.infer<typeof runtimeResponseSchema>;
