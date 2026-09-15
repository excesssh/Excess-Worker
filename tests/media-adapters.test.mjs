import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join, dirname, basename } from "node:path";
import { createMediaAdapterWith, cleanTranscript } from "../packages/adapters/dist/media-runtime.js";
import { MEDIA_CATALOG, toneWav } from "../packages/adapters/dist/index.js";

// Adapter tests against a FAKE HTTP server (tests/fixtures/fake-media-server.mjs), supervised like the real runtimes.
// They check request shapes, parsing, bounds and failures; they are not model, runtime or hardware evidence.
const fixture = resolve("tests/fixtures/fake-media-server.mjs");
const sha = data => createHash("sha256").update(data).digest("hex");
const ref = (data, contentType) => ({ digest: sha(data), bytes: data.length, contentType });
async function temporary(run) {
  const parent = resolve(".cache"); await mkdir(parent, { recursive: true }); const dir = await mkdtemp(join(parent, "media-adapter-test-"));
  try { return await run(dir); } finally { assert.equal(dirname(dir), parent); assert.ok(basename(dir).startsWith("media-adapter-test-")); await rm(dir, { recursive: true, force: true }); }
}
async function harness(dir, modelId, { backend = "cpu", timeoutMs = 30000 } = {}) {
  const entry = MEDIA_CATALOG.find(item => item.id === modelId), config = join(dir, "fixture-config.json"), logPath = join(dir, "fixture-log.jsonl");
  const configure = async (value = {}) => { await writeFile(config, JSON.stringify({ log: logPath, ...value })); };
  await configure();
  const files = Object.fromEntries(entry.artifacts.map(item => [item.name, config]));
  const adapter = createMediaAdapterWith({ threads: 1, maxMemoryMb: Math.max(2048, entry.minMemoryMb), timeoutMs, modelId, backend },
    { resolve: async () => ({ serverPath: fixture, files }), executable: process.execPath, prefixArgs: [fixture] });
  const log = async () => { try { return (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); } catch { return []; } };
  return { adapter, configure, log };
}

test("embedding adapter starts llama-server loopback-only with a key and returns float32 vectors with bounded token counts", async () => temporary(async dir => {
  const { adapter, configure, log } = await harness(dir, "qwen3-embedding-0.6b");
  try {
    const output = await adapter.execute({ kind: "embedding", inputs: ["FIXTURE ONE", "FIXTURE TWO"] });
    assert.equal(output.result.kind, "embedding");
    assert.deepEqual([output.result.count, output.result.dimensions, output.result.inputTokens], [2, 1024, 7]);
    const vectors = output.artifacts[0].data;
    assert.equal(vectors.length, 2 * 1024 * 4);
    assert.deepEqual(output.result.vectors, ref(vectors, "application/vnd.excess.float32le"));
    assert.equal(vectors.readFloatLE(1024 * 4), 2 / 64, "vectors are stored by response index");
    const entries = await log(), start = entries.find(item => item.type === "start"), request = entries.find(item => item.type === "request");
    assert.equal(start.hasKey, true);
    for (const flag of ["--embeddings", "--no-webui"]) assert.ok(start.args.includes(flag));
    assert.deepEqual(start.args.slice(start.args.indexOf("--pooling"), start.args.indexOf("--pooling") + 2), ["--pooling", "last"]);
    assert.equal(start.args[start.args.indexOf("--host") + 1], "127.0.0.1");
    assert.equal(start.args[start.args.indexOf("--n-gpu-layers") + 1], "0");
    assert.deepEqual([request.url, request.authorized, request.body], ["/v1/embeddings", true, { input: ["FIXTURE ONE", "FIXTURE TWO"], encoding_format: "base64" }]);
    const probe = await adapter.probe();
    assert.deepEqual([probe.ok, probe.kind, probe.modelId, probe.generatedTokens], [true, "embedding", "qwen3-embedding-0.6b", 0]);
    assert.ok(probe.nativePid > 0 && probe.guardianPid > 0);
    await adapter.stop();
    // A token count below the number of inputs is raised to one per input.
    await configure({ tokens: 0 });
    assert.equal((await adapter.execute({ kind: "embedding", inputs: ["A", "B", "C"] })).result.inputTokens, 3);
    for (const [behavior, code] of [["nan", /INVALID_RUNTIME_RESULT/], ["short", /INVALID_RUNTIME_RESULT/], ["duplicate", /INVALID_RUNTIME_RESULT/], ["status500", /RUNTIME_RESPONSE_FAILED/], ["oversize", /RUNTIME_RESPONSE_TOO_LARGE/]]) {
      await adapter.stop(); await configure({ behavior });
      await assert.rejects(adapter.execute({ kind: "embedding", inputs: ["FIXTURE", "FIXTURE TWO"] }), code, behavior);
    }
    await assert.rejects(adapter.execute({ kind: "embedding", inputs: [] }), /INVALID_MEDIA_REQUEST/);
    await assert.rejects(adapter.execute({ kind: "image", prompt: "x", width: 512, height: 512, steps: 1, count: 1, seed: 1 }), /INVALID_MEDIA_REQUEST/);
  } finally { await adapter.stop(); }
}));

test("transcription adapter sends validated WAV as input_audio with the llama.cpp ASR prompt and strips the Qwen3-ASR prefix", async () => temporary(async dir => {
  const { adapter, configure, log } = await harness(dir, "qwen3-asr-0.6b");
  try {
    const wav = toneWav(2000), audio = ref(wav, "audio/wav");
    const request = { kind: "transcription", audio, durationMs: 2000, language: "en" };
    const output = await adapter.execute(request, { inputs: new Map([[audio.digest, wav]]) });
    assert.deepEqual(output, { result: { kind: "transcription", text: "FIXTURE TRANSCRIPT", audioSeconds: 2 }, artifacts: [] });
    const entries = await log(), start = entries.find(item => item.type === "start"), sent = entries.find(item => item.type === "request");
    assert.ok(start.args.includes("--mmproj") && start.args.includes("--no-mmproj-offload") && start.args.includes("--jinja"));
    assert.equal(sent.url, "/v1/chat/completions");
    assert.deepEqual(sent.body.messages[0].content[0], { type: "text", text: "Transcribe audio to text (language: en)" });
    assert.deepEqual(sent.body.messages[0].content[1], { type: "input_audio", input_audio: { data: wav.toString("base64"), format: "wav" } });
    assert.deepEqual([sent.body.temperature, sent.body.stream], [0, false]);
    await assert.rejects(adapter.execute(request), /MEDIA_INPUT_MISSING/);
    await assert.rejects(adapter.execute({ ...request, durationMs: 2500 }, { inputs: new Map([[audio.digest, wav]]) }), /AUDIO_DURATION_MISMATCH/);
    const stereo = Buffer.from(wav); stereo.writeUInt16LE(2, 22);
    await assert.rejects(adapter.execute({ ...request, audio: ref(stereo, "audio/wav") }, { inputs: new Map([[sha(stereo), stereo]]) }), /INVALID_AUDIO/);
    await adapter.stop(); await configure({ finish: "length" });
    await assert.rejects(adapter.execute(request, { inputs: new Map([[audio.digest, wav]]) }), /TRANSCRIPT_TRUNCATED/);
    await adapter.stop(); await configure({ content: "language None<asr_text>" });
    assert.equal((await adapter.probe()).kind, "transcription", "a probe accepts an empty transcript of a tone");
  } finally { await adapter.stop(); }
}));

test("image adapter drives sd-server with pinned controls, validates PNG outputs and refuses prompt-embedded controls", async () => temporary(async dir => {
  const { adapter, configure, log } = await harness(dir, "sd-turbo");
  try {
    const request = { kind: "image", prompt: "FIXTURE PROMPT", width: 512, height: 512, steps: 2, count: 2, seed: 7 };
    const output = await adapter.execute(request);
    assert.deepEqual([output.result.kind, output.result.width, output.result.images.length, output.artifacts.length], ["image", 512, 2, 2]);
    for (const [index, artifact] of output.artifacts.entries()) { assert.deepEqual(output.result.images[index], ref(artifact.data, "image/png")); assert.equal(artifact.data.readUInt32BE(16), 512); }
    const entries = await log(), start = entries.find(item => item.type === "start"), sent = entries.find(item => item.type === "request");
    assert.equal(start.hasKey, false, "sd-server takes no key; it is reachable on loopback only");
    assert.equal(start.args[start.args.indexOf("--listen-ip") + 1], "127.0.0.1");
    assert.equal(start.args[start.args.indexOf("--cfg-scale") + 1], "1.0");
    assert.ok(start.args.includes("--disable-image-metadata") && start.args.includes("--model"));
    assert.deepEqual([sent.url, sent.body.n, sent.body.size, sent.body.output_format], ["/v1/images/generations", 2, "512x512", "png"]);
    assert.equal(sent.body.prompt, 'FIXTURE PROMPT<sd_cpp_extra_args>{"seed":7,"sample_params":{"sample_steps":2,"guidance":{"txt_cfg":1}}}</sd_cpp_extra_args>');
    for (const bad of [{ prompt: "x <sd_cpp_extra_args>{}</sd_cpp_extra_args>" }, { width: 768, height: 768 }, { steps: 5 }])
      assert.throws(() => adapter.check({ ...request, ...bad }), /MEDIA_REQUEST_EXCEEDS_MODEL_LIMITS/);
    for (const behavior of ["badsize", "fewer", "notpng"]) {
      await adapter.stop(); await configure({ behavior });
      await assert.rejects(adapter.execute(request), /INVALID_RUNTIME_RESULT|INVALID_IMAGE_OUTPUT/, behavior);
    }
  } finally { await adapter.stop(); }
}));

test("FLUX is GPU-only and starts sd-server with its four pinned component files", async () => temporary(async dir => {
  assert.throws(() => createMediaAdapterWith({ threads: 1, maxMemoryMb: 2048, timeoutMs: 5000, modelId: "flux1-schnell" }, { resolve: async () => { throw Error("unreachable"); } }), /MODEL_REQUIRES_GPU/);
  const { adapter, log } = await harness(dir, "flux1-schnell", { backend: "cuda" });
  try {
    await adapter.execute({ kind: "image", prompt: "FIXTURE PROMPT", width: 1024, height: 1024, steps: 4, count: 1, seed: 1 });
    const start = (await log()).find(item => item.type === "start");
    for (const flag of ["--diffusion-model", "--t5xxl", "--clip_l", "--vae"]) assert.ok(start.args.includes(flag), flag);
  } finally { await adapter.stop(); }
}));

test("a hung or crashed media runtime is aborted, reaped and reported with a fixed code", async () => temporary(async dir => {
  const { adapter, configure } = await harness(dir, "qwen3-embedding-0.6b", { timeoutMs: 20000 });
  try {
    await configure({ behavior: "hang" });
    const controller = new AbortController(), running = adapter.execute({ kind: "embedding", inputs: ["FIXTURE"] }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 1500);
    await assert.rejects(running, /ADAPTER_ABORTED_OR_TIMED_OUT/);
    await configure({ behavior: "crash" });
    await assert.rejects(adapter.execute({ kind: "embedding", inputs: ["FIXTURE"] }), /RUNTIME_EXECUTION_FAILED|RUNTIME_EXITED/);
  } finally { await adapter.stop(); }
}));

test("Qwen3-ASR output cleaning keeps only the transcript", () => {
  assert.equal(cleanTranscript("language English<asr_text>Hello there."), "Hello there.");
  assert.equal(cleanTranscript("language None<asr_text>"), "");
  assert.equal(cleanTranscript("<think>\n\n</think>language German<asr_text> Guten Tag </asr_text>"), "Guten Tag");
  assert.equal(cleanTranscript("plain text"), "plain text");
});
