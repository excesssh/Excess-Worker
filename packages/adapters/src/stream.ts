import { z } from "zod";
import { requestDigest, type TextChunk } from "@excess/protocol";
import { AdapterError, parseTextResult, type TextResult } from "./manifest.js";

export type ChunkCallback = (chunk: TextChunk) => Promise<void>;
const eventSchema = z.object({
  content: z.string().max(8192), tokens: z.array(z.number().int().min(0).max(2147483647)).max(128),
  stop: z.boolean(), tokens_predicted: z.number().int().min(0).max(128),
  stop_type: z.enum(["none", "eos", "limit", "word"]).optional(), truncated: z.boolean().optional(),
});
const invalid = () => new AdapterError("INVALID_RUNTIME_STREAM");

async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      abort = () => reject(new AdapterError("ADAPTER_ABORTED_OR_TIMED_OUT"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}

// Native /completion at pinned llama.cpp 5266f24 (server-task.cpp and
// server-context.cpp): partial events carry token IDs; the stop:true event
// carries empty content/tokens and the final count. This is not OpenAI SSE.
export async function readLlamaStream(response: Response, maxTokens: number, onChunk: ChunkCallback, signal?: AbortSignal): Promise<TextResult> {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 128 || !response.ok || !response.body ||
      response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "text/event-stream") {
    await response.body?.cancel().catch(() => {}); throw invalid();
  }
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let wireBytes = 0, line = "", data: string[] = [], eventBytes = 0, lines = 0, events = 0, skipLf = false;
  let finished = false, finishReason: "stop" | "length" = "stop", text = "", tokenCount = 0, sequence = 0;
  let pendingText = "", pendingTokens: number[] = [];
  const flush = async () => {
    if (!pendingTokens.length) { if (pendingText) throw invalid(); return; }
    if (++sequence > 128) throw invalid();
    const value = { sequence, delta: pendingText, tokenIds: pendingTokens };
    await abortable(Promise.resolve().then(() => onChunk({ ...value, chunkDigest: requestDigest(value) })), signal);
    pendingText = ""; pendingTokens = [];
  };
  const event = async () => {
    if (!data.length) return;
    if (finished || ++events > 260) throw invalid();
    let raw: unknown;
    try { raw = JSON.parse(data.join("\n")); } catch { throw invalid(); }
    data = []; eventBytes = 0;
    const parsed = eventSchema.safeParse(raw);
    if (!parsed.success) throw invalid();
    const value = parsed.data;
    // JSON escapes must not introduce unpaired UTF-16 surrogates after the
    // strict UTF-8 decoder has validated the wire bytes.
    if (Buffer.from(value.content, "utf8").toString("utf8") !== value.content) throw invalid();
    if (value.stop) {
      if (value.content !== "" || value.tokens.length || value.truncated !== false ||
          !value.stop_type || value.stop_type === "none" || value.tokens_predicted !== tokenCount) throw invalid();
      finished = true; finishReason = value.stop_type === "limit" ? "length" : "stop";
      await flush(); return;
    }
    if ((value.stop_type !== undefined && value.stop_type !== "none") || value.truncated === true || !value.tokens.length) throw invalid();
    // The pinned server can omit IDs while assembling a multibyte character.
    // Such a count gap fails closed; never invent missing metering evidence.
    tokenCount += value.tokens.length;
    if (tokenCount > maxTokens || value.tokens_predicted !== tokenCount) throw invalid();
    text += value.content;
    if (Buffer.byteLength(text, "utf8") > 8192) throw invalid();
    pendingText += value.content; pendingTokens.push(...value.tokens);
    if (pendingTokens.length >= 8) await flush();
  };
  const endLine = async () => {
    if (++lines > 2048) throw invalid();
    const current = line; line = "";
    if (current === "") { await event(); return; }
    if (current.startsWith(":")) return; // bounded SSE heartbeat comments
    const colon = current.indexOf(":"), field = colon < 0 ? current : current.slice(0, colon);
    let value = colon < 0 ? "" : current.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field !== "data") throw invalid();
    eventBytes += Buffer.byteLength(value, "utf8") + 1;
    if (eventBytes > 65536) throw invalid();
    data.push(value);
  };
  const consume = async (decoded: string) => {
    for (const character of decoded) {
      if (skipLf) { skipLf = false; if (character === "\n") continue; }
      if (character === "\r" || character === "\n") { skipLf = character === "\r"; await endLine(); }
      else { line += character; if (line.length > 65536) throw invalid(); }
    }
  };
  try {
    for (;;) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      wireBytes += next.value.byteLength;
      if (wireBytes > 262144) throw invalid();
      let decoded: string;
      try { decoded = decoder.decode(next.value, { stream: true }); } catch { throw invalid(); }
      await consume(decoded);
    }
    let tail: string;
    try { tail = decoder.decode(); } catch { throw invalid(); }
    await consume(tail);
    if (!finished || line || data.length) throw invalid();
    signal?.throwIfAborted();
    return parseTextResult({ text, generatedTokens: tokenCount, finishReason });
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
