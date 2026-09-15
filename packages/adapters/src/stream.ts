import { z } from "zod";
import { requestDigest, TEXT_LIMITS, type TextChunk } from "@excess/protocol";
import { AdapterError, parseTextResult, type TextResult } from "./manifest.js";

export type ChunkCallback = (chunk: TextChunk) => Promise<void>;
// One native event is never split, so it must fit a single protocol chunk.
const eventSchema = z.object({
  content: z.string().max(TEXT_LIMITS.maxChunkBytes), tokens: z.array(z.number().int().min(0).max(2147483647)).max(TEXT_LIMITS.maxChunkTokens),
  stop: z.boolean(), tokens_predicted: z.number().int().min(0).max(TEXT_LIMITS.maxOutputTokens),
  stop_type: z.enum(["none", "eos", "limit", "word"]).optional(), truncated: z.boolean().optional(),
});
const invalid = () => new AdapterError("INVALID_RUNTIME_STREAM");

/** Follows generated token IDs until the answer marker (the loaded vocabulary's tokenization of a format's answerMarker)
 * has appeared. Everything up to and including it is reasoning: metered, but its text is never delivered. */
export class AnswerGate {
  private matched = 0;
  revealed = false;
  constructor(private readonly marker: readonly number[]) { if (!marker.length) throw new AdapterError("RUNTIME_RESPONSE_INVALID"); }
  /** Index just past the marker within these tokens, or -1 while the answer has not begun. */
  feed(tokens: readonly number[]): number {
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      this.matched = token === this.marker[this.matched] ? this.matched + 1 : token === this.marker[0] ? 1 : 0;
      if (this.matched === this.marker.length) { this.revealed = true; return index + 1; }
    }
    return -1;
  }
}
/** A reasoning run that ends before its answer began: the output budget ran out, or the model stopped. */
export const unansweredReasoning = (finishReason: "stop" | "length") =>
  new AdapterError(finishReason === "length" ? "REASONING_EXCEEDED_OUTPUT_TOKENS" : "REASONING_WITHOUT_ANSWER");

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
// With a gate, reasoning tokens are streamed as chunks with an empty delta: the buyer sees them counted, never their text.
export async function readLlamaStream(response: Response, maxTokens: number, onChunk: ChunkCallback, signal?: AbortSignal, gate?: AnswerGate): Promise<TextResult> {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > TEXT_LIMITS.maxOutputTokens || !response.ok || !response.body ||
      response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "text/event-stream") {
    await response.body?.cancel().catch(() => {}); throw invalid();
  }
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let wireBytes = 0, line = "", data: string[] = [], eventBytes = 0, lines = 0, events = 0, skipLf = false;
  let finished = false, finishReason: "stop" | "length" = "stop", text = "", tokenCount = 0, sequence = 0;
  let pendingText = "", pendingTokens: number[] = [];
  const flush = async () => {
    if (!pendingTokens.length) { if (pendingText) throw invalid(); return; }
    if (++sequence > TEXT_LIMITS.maxStreamChunks) throw invalid();
    const value = { sequence, delta: pendingText, tokenIds: pendingTokens };
    await abortable(Promise.resolve().then(() => onChunk({ ...value, chunkDigest: requestDigest(value) })), signal);
    pendingText = ""; pendingTokens = [];
  };
  const event = async () => {
    if (!data.length) return;
    // Every partial event carries at least one token: at most maxOutputTokens + 1 events, with slack.
    if (finished || ++events > 2 * TEXT_LIMITS.maxOutputTokens + 4) throw invalid();
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
    let content = value.content;
    if (gate && !gate.revealed) {
      const after = gate.feed(value.tokens);
      // A native event carries one generated token. One that completes the marker and also carries answer tokens cannot be
      // split into withheld and delivered text, so it fails closed.
      if (after >= 0 && after !== value.tokens.length) throw invalid();
      content = "";
    }
    text += content;
    const contentBytes = Buffer.byteLength(content, "utf8");
    if (Buffer.byteLength(text, "utf8") > TEXT_LIMITS.maxOutputBytes || contentBytes > TEXT_LIMITS.maxChunkBytes) throw invalid();
    // Keep each emitted chunk within the per-chunk token and byte bounds.
    if (pendingTokens.length + value.tokens.length > TEXT_LIMITS.maxChunkTokens ||
        Buffer.byteLength(pendingText, "utf8") + contentBytes > TEXT_LIMITS.maxChunkBytes) await flush();
    pendingText += content; pendingTokens.push(...value.tokens);
    if (pendingTokens.length >= 8) await flush();
  };
  const endLine = async () => {
    if (++lines > 16 * TEXT_LIMITS.maxOutputTokens) throw invalid();
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
      if (wireBytes > 32 * TEXT_LIMITS.maxOutputBytes) throw invalid();
      let decoded: string;
      try { decoded = decoder.decode(next.value, { stream: true }); } catch { throw invalid(); }
      await consume(decoded);
    }
    let tail: string;
    try { tail = decoder.decode(); } catch { throw invalid(); }
    await consume(tail);
    if (!finished || line || data.length) throw invalid();
    signal?.throwIfAborted();
    if (gate && !gate.revealed) throw unansweredReasoning(finishReason);
    return parseTextResult({ text, generatedTokens: tokenCount, finishReason });
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
