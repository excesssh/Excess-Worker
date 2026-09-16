import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { AdapterError, parseTextRequest, parseTextResult, type MediaAdapter, type MediaOutput, type TextAdapter, type TextResult } from "@excess/adapters";
import { MAX_WORKER_MESSAGE_BYTES, MEDIA_LIMITS, mediaRequestSchema, mediaResultSchema, mediaResultUnits, requestDigest, TEXT_LIMITS, textChunkSchema,
  type ArtifactRef, type MediaRequest, type MediaResult, type TextChunk } from "@excess/protocol";
import { createServedAdapter, isMediaAdapter, servedModel, type ServedAdapter } from "./served.js";
import { createWorkerConnection, WorkerConnectionError, type WorkerConnection } from "./identity.js";
import { observeLocalResources } from "./telemetry.js";
import { readWorkerPolicy, parseWorkerPolicy, policyDecision, type WorkerPolicy, type ResourceObservation } from "./policy.js";
import { readWorkerOffer, type WorkerOffer } from "./offer.js";
import { acquireRuntimeLock, atomicPrivateJson, readWorkerControl, setWorkerControl, writeWorkerStatus, WorkerShutdownError, type WorkerMode, type WorkerProbe } from "./control.js";

type Assignment = {
  jobId: string; attemptId: string; deviceId: string; fence: string; leaseExpiresAt: string;
  runDeadlineAt: string; offerId: string; capabilityDigest: string; requestDigest: string; maxUnits: string;
};
type Entry = { assignment: Assignment; state: "seen" | "running" | "result_pending" | "finished" | "abandoned"; updatedAt: string; reason: string; resultDigest?: string };
type Timing = { pollMs: number; heartbeatMs: number; renewMs: number; monitorMs: number };
export type WorkerRuntimeOptions = {
  identityPath: string; stateDir: string; installDir: string; policy?: WorkerPolicy;
  telemetry?: () => Promise<ResourceObservation>; signal?: AbortSignal;
  // Dependency injection is for explicit local tests, never a CLI fallback.
  adapter?: ServedAdapter; connection?: WorkerConnection; timings?: Partial<Timing>; offer?: WorkerOffer | null;
};
// Listed offers need a probe newer than the coordinator's five-minute window.
const REPROBE_MS = 240_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid coordinator response");
  return value as Record<string, unknown>;
}
function successfulProbe(value: unknown, policy: WorkerPolicy, startedAt: number): WorkerProbe {
  const proof = record(value), entry = servedModel(policy.model);
  const probedAt = typeof proof.probedAt === "string" ? Date.parse(proof.probedAt) : NaN;
  if (proof.ok !== true || proof.capabilityDigest !== entry.capabilityDigest || proof.backend !== policy.backend ||
      (proof.modelId !== undefined && proof.modelId !== entry.id) ||
      proof.model !== entry.model || proof.runtime !== entry.runtime ||
      proof.threads !== policy.threads || proof.maxMemoryMb !== policy.maxMemoryMb ||
      !Number.isFinite(probedAt) || probedAt < startedAt || probedAt > Date.now() ||
      !Number.isSafeInteger(proof.generatedTokens) || Number(proof.generatedTokens) < 0 || Number(proof.generatedTokens) > Math.max(8, entry.probeMaxTokens) ||
      !Number.isSafeInteger(proof.peakRssMb) || Number(proof.peakRssMb) < 0) throw Error("Invalid local probe observation");
  for (const name of ["nativePid", "guardianPid"]) {
    if (proof[name] !== undefined && (!Number.isSafeInteger(proof[name]) || Number(proof[name]) < 1)) throw Error("Invalid local probe process identity");
  }
  return {
    ok: true, capabilityDigest: entry.capabilityDigest, backend: policy.backend, model: entry.model, runtime: entry.runtime,
    threads: policy.threads, maxMemoryMb: policy.maxMemoryMb, probedAt: String(proof.probedAt),
    generatedTokens: Number(proof.generatedTokens), peakRssMb: Number(proof.peakRssMb),
    ...(proof.nativePid === undefined ? {} : { nativePid: Number(proof.nativePid) }),
    ...(proof.guardianPid === undefined ? {} : { guardianPid: Number(proof.guardianPid) }),
    policy: { ...policy },
  };
}
function assignment(value: unknown, deviceId: string, allowExpired = false): Assignment {
  const data = record(value);
  if (Object.keys(data).some(k => !["jobId", "attemptId", "deviceId", "fence", "leaseExpiresAt", "runDeadlineAt", "offerId", "capabilityDigest", "requestDigest", "maxUnits"].includes(k))) throw Error("Invalid assignment");
  for (const field of ["jobId", "attemptId", "deviceId", "offerId"]) if (typeof data[field] !== "string" || !uuid.test(data[field] as string)) throw Error("Invalid assignment");
  if (data.deviceId !== deviceId || typeof data.fence !== "string" || !/^[1-9][0-9]{0,18}$/.test(data.fence) || BigInt(data.fence) > 9223372036854775807n ||
      typeof data.maxUnits !== "string" || !/^[1-9][0-9]{0,77}$/.test(data.maxUnits) ||
      typeof data.capabilityDigest !== "string" || !digest.test(data.capabilityDigest) || typeof data.requestDigest !== "string" || !digest.test(data.requestDigest)) throw Error("Invalid assignment");
  for (const field of ["leaseExpiresAt", "runDeadlineAt"]) if (typeof data[field] !== "string" || !Number.isFinite(Date.parse(data[field] as string)) || (!allowExpired && Date.parse(data[field] as string) <= Date.now())) throw Error("Expired assignment");
  if (Date.parse(data.leaseExpiresAt as string) > Date.parse(data.runDeadlineAt as string)) throw Error("Invalid assignment lease");
  return data as unknown as Assignment;
}
const attemptData = (a: Assignment) => ({ jobId: a.jobId, attemptId: a.attemptId, fence: a.fence });
const pause = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
  const timer = setTimeout(finish, ms);
  signal?.addEventListener("abort", finish, { once: true });
  if (signal?.aborted) finish();
});
// Adapter codes are fixed identifiers (no paths or prompts), so the supplier sees why a probe or job failed.
const safeReason = (error: unknown) => error instanceof WorkerConnectionError ? error.code
  : error instanceof AdapterError && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.code) ? "adapter_" + error.code.toLowerCase() : "worker_operation_failed";
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const artifactRefs = (output: MediaResult): ArtifactRef[] => output.kind === "embedding" ? [output.vectors] : output.kind === "image" ? output.images : [];
// Output artifact bytes are journaled beside the result so a lost upload can be resent after a restart.
async function writePrivateFile(path: string, data: Buffer): Promise<void> {
  const temporary = path + ".pending-" + randomUUID();
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
}

class AttemptJournal {
  private constructor(readonly dir: string, readonly deviceId: string, private bytes: number, readonly entries: Map<string, Entry>) {}
  static async load(dir: string, deviceId: string): Promise<AttemptJournal> {
    const path = join(dir, "attempts.jsonl");
    const markerPath = join(dir, "journal-owner.json");
    let initialized = false;
    try {
      const owner = JSON.parse(await readFile(markerPath, "utf8")) as { version?: unknown; deviceId?: unknown };
      if (owner.version !== 1 || owner.deviceId !== deviceId) throw Error("Attempt journal belongs to another device");
      initialized = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let data: Buffer;
    try { data = await readFile(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (initialized) throw Error("Worker attempt journal missing; explicit recovery required");
      const file = await open(path, "wx", 0o600);
      try { await file.sync(); } finally { await file.close(); }
      data = Buffer.alloc(0);
    }
    if (data.length > MAX_JOURNAL_BYTES) throw Error("Worker attempt journal requires maintenance");
    const complete = data.lastIndexOf(10) + 1;
    const entries = new Map<string, Entry>();
    for (const line of data.subarray(0, complete).toString("utf8").split("\n").filter(Boolean)) {
      const value = record(JSON.parse(line));
      const a = assignment(value.assignment, deviceId, true);
      if (!["seen", "running", "result_pending", "finished", "abandoned"].includes(String(value.state)) || typeof value.reason !== "string" || typeof value.updatedAt !== "string") throw Error("Invalid attempt journal");
      const previous = entries.get(a.attemptId);
      if (previous && requestDigest(previous.assignment) !== requestDigest(a)) throw Error("Attempt journal identity changed");
      if (!previous && value.state !== "seen") throw Error("Attempt journal missing first observation");
      if (previous && ["finished", "abandoned"].includes(previous.state)) throw Error("Attempt journal resurrected terminal attempt");
      entries.set(a.attemptId, value as unknown as Entry);
    }
    // A torn final append cannot erase an earlier durable 'seen' record.
    if (complete !== data.length) {
      const file = await open(path, "r+");
      try { await file.truncate(complete); await file.sync(); } finally { await file.close(); }
    }
    if (!initialized) await atomicPrivateJson(markerPath, { version: 1, deviceId });
    return new AttemptJournal(dir, deviceId, complete, entries);
  }
  async append(value: Entry): Promise<void> {
    const line = JSON.stringify(value) + "\n";
    const bytes = Buffer.byteLength(line);
    if (this.bytes + bytes > MAX_JOURNAL_BYTES) throw Error("Worker attempt journal requires maintenance");
    const file = await open(join(this.dir, "attempts.jsonl"), "a", 0o600);
    try { await file.writeFile(line); await file.sync(); } finally { await file.close(); }
    this.bytes += bytes; this.entries.set(value.assignment.attemptId, value);
  }
  resultPath(a: Assignment): string { return join(this.dir, a.attemptId + ".result.json"); }
  artifactPath(a: Assignment, artifactDigest: string): string {
    if (!digest.test(artifactDigest)) throw Error("Invalid artifact digest");
    return join(this.dir, `${a.attemptId}.artifact.${artifactDigest}.bin`);
  }
  async removeOutput(a: Assignment): Promise<void> {
    try { await unlink(this.resultPath(a)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    for (const name of await readdir(this.dir)) {
      if (!name.startsWith(a.attemptId + ".artifact.")) continue;
      try { await unlink(join(this.dir, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  async set(a: Assignment, state: Entry["state"], reason: string, resultDigest?: string): Promise<Entry> {
    const entry: Entry = { assignment: a, state, reason, updatedAt: new Date().toISOString(), ...(resultDigest ? { resultDigest } : {}) };
    await this.append(entry); return entry;
  }
}

export async function runWorker(options: WorkerRuntimeOptions): Promise<{ state: string; reason: string }> {
  const dir = resolve(options.stateDir);
  await mkdir(dir, { recursive: true });
  const releaseLock = await acquireRuntimeLock(dir);
  let adapter: ServedAdapter | undefined;
  let connection: WorkerConnection | undefined;
  let lastProbe: WorkerProbe | undefined;
  let active: { assignment: Assignment | null; abort: AbortController } | null = null;
  let closing = false, mode: WorkerMode = "stop", connected = false, probed = false, capabilityDigest = "";
  let fatal: string | null = null, statusState = "starting", statusReason = "initializing", statusDetail: string | undefined;
  let observation: ResourceObservation = { freeMemoryMb: null, idleSeconds: null }, observedAt = 0;
  let tasks: Promise<void>[] = [];
  const lifetime = new AbortController();
  const timing: Timing = { pollMs: 1000, heartbeatMs: 5000, renewMs: 5000, monitorMs: 100, ...options.timings };
  for (const value of Object.values(timing)) if (!Number.isInteger(value) || value < 10 || value > 10000) { await releaseLock(); throw Error("Invalid runtime timing"); }
  const abortActive = (reason: string) => {
    if (active && !active.abort.signal.aborted) active.abort.abort(Error(reason));
  };
  const disconnected = (error: unknown) => {
    connected = false; statusReason = safeReason(error); statusState = "disconnected"; abortActive("coordinator_disconnected");
    if (error instanceof WorkerConnectionError && [401, 403].includes(error.status ?? 0)) { fatal = "device_revoked_or_unauthorized"; mode = "stop"; }
  };
  try {
    const policy = options.policy ? parseWorkerPolicy(options.policy) : await readWorkerPolicy(dir);
    // The worker serves exactly one catalog model at a time, chosen in its policy: text or a buffered media kind.
    const served = servedModel(policy.model);
    capabilityDigest = served.capabilityDigest;
    const offer = options.offer !== undefined ? options.offer : await readWorkerOffer(dir, policy.model);
    mode = await readWorkerControl(dir);
    if (mode !== "run") {
      statusState = "stopped"; statusReason = mode === "drain" ? "drained" : "explicit_resume_required";
      await writeWorkerStatus(dir, { state: statusState, reason: statusReason });
      return { state: "stopped", reason: "explicit_resume_required" };
    }
    connection = options.connection ?? await createWorkerConnection(options.identityPath);
    if (!uuid.test(connection.deviceId)) throw Error("Invalid device identity");
    const journal = await AttemptJournal.load(dir, connection.deviceId);
    for (const entry of [...journal.entries.values()]) {
      if (entry.state === "seen" || entry.state === "running") await journal.set(entry.assignment, "abandoned", "interrupted_before_receipt");
      if (entry.state !== "result_pending") await journal.removeOutput(entry.assignment);
    }
    adapter = options.adapter ?? createServedAdapter(options.installDir, policy);
    if ((served.kind === "text") === isMediaAdapter(adapter)) throw Error("Adapter does not match the served model kind");
    const decide = () => policyDecision(policy, Date.now() - observedAt <= 5000 ? observation : { freeMemoryMb: null, idleSeconds: null }, active !== null);
    const state = async () => writeWorkerStatus(dir, { state: statusState, reason: statusReason, ...(statusDetail ? { detail: statusDetail } : {}), deviceId: connection!.deviceId,
      activeAttemptId: active?.assignment?.attemptId ?? null, capabilityDigest: probed ? capabilityDigest : null,
      ...(lastProbe ? { lastProbe } : {}) });
    tasks.push((async () => {
      let lastStatus = 0;
      while (!closing && !lifetime.signal.aborted) {
        try {
          mode = options.signal?.aborted || fatal ? "stop" : await readWorkerControl(dir);
          if (mode === "stop") { abortActive("stop_now"); lifetime.abort(); }
          else if (!decide().allowed && active) abortActive("local_resource_policy");
          if (Date.now() - lastStatus >= 1000) { await state(); lastStatus = Date.now(); }
        } catch { fatal = "local_control_unavailable"; mode = "stop"; abortActive("local_control_unavailable"); }
        await pause(timing.monitorMs, lifetime.signal);
      }
    })());
    tasks.push((async () => {
      while (!closing && !lifetime.signal.aborted) {
        try { observation = await (options.telemetry ?? observeLocalResources)(); observedAt = Date.now(); }
        catch { observation = { freeMemoryMb: null, idleSeconds: null }; observedAt = Date.now(); }
        await pause(Math.min(1000, timing.pollMs), lifetime.signal);
      }
    })());
    tasks.push((async () => {
      while (!closing && !lifetime.signal.aborted) {
        try {
          const available = mode === "run" && probed && connected && !active && decide().allowed &&
            ![...journal.entries.values()].some(entry => entry.state === "result_pending") ? 1 : 0;
          const response = record(await connection!.heartbeat({ totalSlots: 1, availableSlots: available, capabilityDigests: probed ? [capabilityDigest] : [] }, lifetime.signal));
          if (response.accepted !== true) throw Error("Heartbeat was not accepted");
        } catch (error) { if (!closing) disconnected(error); }
        await pause(timing.heartbeatMs, lifetime.signal);
      }
    })());
    tasks.push((async () => {
      let published = false;
      while (!closing && !lifetime.signal.aborted) {
        try {
          published = false;
          if (offer && connection!.offer && mode === "run" && probed && connected && lastProbe) {
            record(await connection!.offer({ capabilityDigest, assetId: offer.assetId, netUnits: offer.netUnits, slots: 1, probedAt: lastProbe.probedAt }, lifetime.signal));
            published = true;
          }
        } catch (error) {
          // A refused offer (such as a probe the coordinator considers stale) retries; lost transport is a disconnect.
          if (!closing && !(error instanceof WorkerConnectionError && [400, 403, 409].includes(error.status ?? 0))) disconnected(error);
        }
        await pause(published ? timing.heartbeatMs * 6 : timing.heartbeatMs, lifetime.signal);
      }
    })());

    const reportFailure = async (a: Assignment, reason: "busy" | "execution_error" | "cancelled_locally") => {
      try { await connection!.command("job.failed", { ...attemptData(a), reason }, lifetime.signal.aborted ? AbortSignal.timeout(2000) : lifetime.signal); }
      catch (error) { if (!(error instanceof WorkerConnectionError && [404, 409].includes(error.status ?? 0))) disconnected(error); }
    };
    // Uploads every output artifact of a media result part by part. Parts are idempotent by (job, digest, part), so a resend
    // after a lost receipt or a restart is safe; each part is re-authorized against the lease and deadline first.
    const uploadArtifacts = async (a: Assignment, output: MediaResult, signal: AbortSignal, authorize?: () => void) => {
      const partBytes = MEDIA_LIMITS.artifactPartBytes, sent = new Set<string>();
      for (const ref of artifactRefs(output)) {
        if (sent.has(ref.digest)) continue;
        sent.add(ref.digest);
        const data = await readFile(journal.artifactPath(a, ref.digest));
        if (data.length !== ref.bytes || sha256(data) !== ref.digest) throw Error("Cached artifact digest mismatch");
        const parts = Math.ceil(ref.bytes / partBytes);
        for (let part = 0; part < parts; part++) {
          authorize?.();
          const receipt = record(await connection!.command("job.artifact", { ...attemptData(a), digest: ref.digest, part, parts, bytes: ref.bytes, contentType: ref.contentType,
            data: data.subarray(part * partBytes, Math.min(ref.bytes, (part + 1) * partBytes)).toString("base64") }, signal));
          if ((receipt.digest !== undefined && receipt.digest !== ref.digest) || (receipt.part !== undefined && receipt.part !== part) ||
              (receipt.accepted !== true && !(receipt.digest === ref.digest && receipt.part === part))) throw Error("Artifact part receipt mismatch");
        }
      }
    };
    const sendResult = async (entry: Entry, authorize?: () => void, signal: AbortSignal = lifetime.signal): Promise<boolean> => {
      try {
        const data = await readFile(journal.resultPath(entry.assignment), "utf8");
        if (Buffer.byteLength(data) > MAX_WORKER_MESSAGE_BYTES) throw Error("Cached result too large");
        const value: unknown = JSON.parse(data);
        // Media results carry a kind; text results keep their untagged shape.
        const media = !!value && typeof value === "object" && "kind" in value;
        const output = media ? mediaResultSchema.parse(value) : parseTextResult(value);
        if (requestDigest(output) !== entry.resultDigest) throw Error("Cached result digest mismatch");
        if (media) await uploadArtifacts(entry.assignment, output as MediaResult, signal, authorize);
        authorize?.();
        const reportedUnits = String(media ? mediaResultUnits(output as MediaResult) : (output as TextResult).generatedTokens);
        const response = record(await connection!.command("job.result", { ...attemptData(entry.assignment),
          outputDigest: entry.resultDigest, reportedUnits, output }, signal));
        if (response.accepted !== true) throw Error("Result receipt missing");
        await journal.set(entry.assignment, "finished", "result_receipted");
        await journal.removeOutput(entry.assignment);
        return true;
      } catch (error) {
        if (error instanceof WorkerConnectionError && [404, 409].includes(error.status ?? 0)) {
          await journal.set(entry.assignment, "abandoned", "result_no_longer_accepted");
          await journal.removeOutput(entry.assignment);
          return true;
        }
        if (error instanceof WorkerConnectionError) { disconnected(error); return false; }
        throw error;
      }
    };
    // Downloads the input artifacts of a buffered job part by part while the pre-start lease is live, checking each part's
    // exact size and the whole artifact's digest.
    const downloadInputs = async (a: Assignment, request: MediaRequest, listed: unknown, signal: AbortSignal): Promise<Map<string, Buffer>> => {
      const expected: ArtifactRef[] = request.kind === "transcription" ? [request.audio] : [];
      if (listed === undefined ? expected.length !== 0 : !Array.isArray(listed) || listed.length !== expected.length) throw Error("Job input artifacts mismatch");
      const inputs = new Map<string, Buffer>(), partBytes = MEDIA_LIMITS.artifactPartBytes;
      for (const [index, ref] of expected.entries()) {
        const item = record((listed as unknown[])[index]), parts = Math.ceil(ref.bytes / partBytes);
        if (item.digest !== ref.digest || item.bytes !== ref.bytes || item.contentType !== ref.contentType || item.parts !== parts) throw Error("Job input artifact mismatch");
        const data = Buffer.alloc(ref.bytes);
        for (let part = 0; part < parts; part++) {
          if (signal.aborted || Date.now() >= Date.parse(a.leaseExpiresAt)) throw Error("Lease expired before start");
          const size = Math.min(partBytes, ref.bytes - part * partBytes);
          const got = record(await connection!.command("job.artifact.read", { ...attemptData(a), digest: ref.digest, part }, signal));
          const chunk = typeof got.data === "string" && got.data.length === Math.ceil(size / 3) * 4 && /^[A-Za-z0-9+/]*={0,2}$/.test(got.data) ? Buffer.from(got.data, "base64") : null;
          if (got.digest !== ref.digest || got.part !== part || got.parts !== parts || !chunk || chunk.length !== size || chunk.toString("base64") !== got.data) throw Error("Invalid input artifact part");
          chunk.copy(data, part * partBytes);
        }
        if (sha256(data) !== ref.digest) throw Error("Input artifact digest mismatch");
        inputs.set(ref.digest, data);
      }
      return inputs;
    };
    // The adapter's output must match the request, the quote and its own artifact bytes before anything is journaled.
    const boundedResult = (request: MediaRequest, output: MediaOutput, maxUnits: bigint): MediaResult => {
      let result = mediaResultSchema.parse(output.result);
      if (result.kind === "embedding" && request.kind === "embedding") {
        if (result.count !== request.inputs.length) throw Error("Embedding count mismatch");
        // Supplier-reported tokens are billed at most up to the quoted maximum.
        result = { ...result, inputTokens: Math.max(result.count, Math.min(result.inputTokens, Number(maxUnits))) };
      } else if (result.kind === "transcription" && request.kind === "transcription") {
        if (result.audioSeconds !== Math.ceil(request.durationMs / 1000)) throw Error("Audio seconds mismatch");
      } else if (result.kind === "image" && request.kind === "image") {
        if (result.width !== request.width || result.height !== request.height || result.images.length !== request.count) throw Error("Image result mismatch");
      } else throw Error("Media result kind mismatch");
      const refs = artifactRefs(result);
      for (const ref of refs) {
        const artifact = output.artifacts.find(item => item.ref.digest === ref.digest);
        if (!artifact || artifact.ref.contentType !== ref.contentType || artifact.data.length !== ref.bytes || sha256(artifact.data) !== ref.digest) throw Error("Media artifact mismatch");
      }
      if (output.artifacts.some(item => !refs.some(ref => ref.digest === item.ref.digest))) throw Error("Unreferenced media artifact");
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_WORKER_MESSAGE_BYTES - 4096) throw Error("Result exceeds signed transport limit");
      return mediaResultSchema.parse(result);
    };
    const performMedia = async (a: Assignment, input: Record<string, unknown>, controller: AbortController, media: MediaAdapter, markStarted: () => void) => {
      const request = mediaRequestSchema.parse(input.request);
      if (request.kind !== served.kind || a.capabilityDigest !== capabilityDigest || input.capabilityDigest !== capabilityDigest ||
          input.requestDigest !== a.requestDigest || requestDigest(request) !== a.requestDigest || input.deliveryMode !== "buffered") throw Error("Job input identity mismatch");
      media.check(request);
      // Quotes bind the units: embeddings at least one token per input; audio seconds and image counts exactly.
      const maxUnits = BigInt(a.maxUnits);
      if (request.kind === "embedding" ? BigInt(request.inputs.length) > maxUnits :
          request.kind === "transcription" ? BigInt(Math.ceil(request.durationMs / 1000)) !== maxUnits : BigInt(request.count) !== maxUnits) throw Error("Job input does not match its quote");
      const inputs = await downloadInputs(a, request, input.artifacts, controller.signal);
      if (controller.signal.aborted || mode !== "run" || !decide().allowed) throw Error("Local policy no longer permits start");
      const acknowledgment = record(await connection!.command("job.started", attemptData(a), controller.signal));
      if (acknowledgment.state !== "running" || typeof acknowledgment.leaseExpiresAt !== "string" || !Number.isFinite(Date.parse(acknowledgment.leaseExpiresAt)) ||
          Date.parse(acknowledgment.leaseExpiresAt) <= Date.now() || Date.parse(acknowledgment.leaseExpiresAt) > Date.parse(a.runDeadlineAt)) throw Error("Invalid start acknowledgment");
      markStarted();
      await journal.set(a, "running", "start_acknowledged");
      if (controller.signal.aborted) throw Error("Start interrupted");
      statusState = "running"; statusReason = "executing";
      let leaseExpires = Date.parse(acknowledgment.leaseExpiresAt);
      const deadline = Math.min(Date.parse(a.runDeadlineAt), Date.now() + policy.runSeconds * 1000);
      const deadlineTimer = setTimeout(() => controller.abort(Error("Local execution deadline")), Math.max(0, deadline - Date.now()));
      const leaseWatch = setInterval(() => { if (Date.now() >= leaseExpires) controller.abort(Error("Lease expired")); }, Math.min(100, timing.monitorMs));
      const authorizeExecution = () => {
        if (controller.signal.aborted || Date.now() >= deadline || Date.now() >= leaseExpires) {
          controller.abort(Error("Execution deadline expired")); throw Error("Execution no longer authorized");
        }
      };
      // Execution and upload both keep the lease renewed, exactly like a text execution.
      const leased = async <T>(work: Promise<T>): Promise<T> => {
        const settled = work.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
        while (true) {
          let wakeTimer: ReturnType<typeof setTimeout> | undefined;
          const tick = new Promise<null>(resolve => { wakeTimer = setTimeout(() => resolve(null), Math.min(timing.renewMs, Math.max(10, Math.floor((leaseExpires - Date.now()) / 3)))); });
          const completed = await Promise.race([settled, tick]);
          clearTimeout(wakeTimer);
          if (completed) { if (!completed.ok) throw completed.error; return completed.value; }
          if (controller.signal.aborted) { await media.stop(); continue; }
          try {
            const renewed = record(await connection!.command("job.renew", attemptData(a), controller.signal));
            if (renewed.state !== "running" || typeof renewed.leaseExpiresAt !== "string" || !Number.isFinite(Date.parse(renewed.leaseExpiresAt)) ||
                Date.parse(renewed.leaseExpiresAt) <= Date.now() || Date.parse(renewed.leaseExpiresAt) > Date.parse(a.runDeadlineAt)) throw Error("Invalid lease renewal");
            leaseExpires = Date.parse(renewed.leaseExpiresAt);
          } catch (error) { disconnected(error); controller.abort(Error("Lease renewal failed")); await media.stop(); }
        }
      };
      try {
        const output = await leased(media.execute(request, { signal: controller.signal, inputs }));
        const result = boundedResult(request, output, maxUnits);
        authorizeExecution();
        for (const artifact of output.artifacts) await writePrivateFile(journal.artifactPath(a, artifact.ref.digest), artifact.data);
        await atomicPrivateJson(journal.resultPath(a), result);
        authorizeExecution();
        const entry = await journal.set(a, "result_pending", "awaiting_result_receipt", requestDigest(result));
        await leased(sendResult(entry, authorizeExecution, controller.signal));
      } finally { clearTimeout(deadlineTimer); clearInterval(leaseWatch); }
    };
    const perform = async (a: Assignment) => {
      const controller = new AbortController();
      active = { assignment: a, abort: controller };
      let started = false;
      await journal.set(a, "seen", "observed_before_execution");
      try {
        const input = record(await connection!.command("job.input", attemptData(a), controller.signal));
        if (isMediaAdapter(adapter!)) { await performMedia(a, input, controller, adapter, () => { started = true; }); return; }
        const textAdapter = adapter as TextAdapter;
        const request = parseTextRequest(input.request);
        if (a.capabilityDigest !== capabilityDigest || input.capabilityDigest !== capabilityDigest ||
            input.requestDigest !== a.requestDigest || requestDigest(request) !== a.requestDigest || BigInt(request.maxTokens) > BigInt(a.maxUnits)) throw Error("Job input identity mismatch");
        if (input.deliveryMode !== undefined && input.deliveryMode !== "buffered" && input.deliveryMode !== "stream") throw Error("Invalid delivery mode");
        const streaming = input.deliveryMode === "stream";
        if (streaming && textAdapter.supportsStreaming !== true) throw Error("Adapter does not support streaming");
        if (controller.signal.aborted || mode !== "run" || !decide().allowed) throw Error("Local policy no longer permits start");
        const acknowledgment = record(await connection!.command("job.started", attemptData(a), controller.signal));
        if (acknowledgment.state !== "running" || typeof acknowledgment.leaseExpiresAt !== "string" || !Number.isFinite(Date.parse(acknowledgment.leaseExpiresAt)) ||
            Date.parse(acknowledgment.leaseExpiresAt) <= Date.now() || Date.parse(acknowledgment.leaseExpiresAt) > Date.parse(a.runDeadlineAt)) throw Error("Invalid start acknowledgment");
        started = true;
        await journal.set(a, "running", "start_acknowledged");
        if (controller.signal.aborted) throw Error("Start interrupted");
        statusState = "running"; statusReason = "executing";
        let leaseExpires = Date.parse(acknowledgment.leaseExpiresAt);
        const deadline = Math.min(Date.parse(a.runDeadlineAt), Date.now() + policy.runSeconds * 1000);
        const deadlineTimer = setTimeout(() => controller.abort(Error("Local execution deadline")), Math.max(0, deadline - Date.now()));
        const leaseWatch = setInterval(() => { if (Date.now() >= leaseExpires) controller.abort(Error("Lease expired")); }, Math.min(100, timing.monitorMs));
        const authorizeExecution = () => {
          if (controller.signal.aborted || Date.now() >= deadline || Date.now() >= leaseExpires) {
            controller.abort(Error("Execution deadline expired")); throw Error("Execution no longer authorized");
          }
        };
        let streamText = "", streamTokens = 0, streamSequence = 0, chunkInFlight = false, executionOpen = true;
        const onChunk = async (value: TextChunk): Promise<void> => {
          try {
            if (!executionOpen || chunkInFlight || controller.signal.aborted) throw Error("Chunk execution interrupted");
            chunkInFlight = true;
            const chunk = textChunkSchema.parse(value);
            const { sequence, delta, tokenIds, chunkDigest } = chunk;
            if (sequence !== streamSequence + 1 || chunkDigest !== requestDigest({ sequence, delta, tokenIds }) ||
                Buffer.from(delta, "utf8").toString("utf8") !== delta || streamTokens + tokenIds.length > request.maxTokens ||
                Buffer.byteLength(streamText + delta, "utf8") > TEXT_LIMITS.maxOutputBytes) throw Error("Invalid adapter chunk");
            const data = { ...attemptData(a), ...chunk };
            if (Buffer.byteLength(JSON.stringify(data), "utf8") > 12000) throw Error("Chunk exceeds signed transport limit");
            authorizeExecution();
            const receipt = record(await connection!.command("job.chunk", data, controller.signal));
            if (receipt.accepted !== true || receipt.sequence !== sequence || receipt.chunkDigest !== chunkDigest) throw Error("Chunk receipt mismatch");
            authorizeExecution();
            streamSequence = sequence; streamText += delta; streamTokens += tokenIds.length;
          } catch (error) {
            if (error instanceof WorkerConnectionError) disconnected(error);
            controller.abort(Error("Chunk delivery failed"));
            throw error;
          } finally { chunkInFlight = false; }
        };
        let output: TextResult;
        try {
          const execution = textAdapter.execute(request, { signal: controller.signal, ...(streaming ? { onChunk } : {}) }).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
          while (true) {
            let wakeTimer: ReturnType<typeof setTimeout> | undefined;
            const tick = new Promise<null>(resolve => { wakeTimer = setTimeout(() => resolve(null), Math.min(timing.renewMs, Math.max(10, Math.floor((leaseExpires - Date.now()) / 3)))); });
            const completed = await Promise.race([execution, tick]);
            clearTimeout(wakeTimer);
            if (completed) { if (!completed.ok) throw completed.error; output = parseTextResult(completed.value); break; }
            if (controller.signal.aborted) { await adapter!.stop(); continue; }
            try {
              const renewed = record(await connection!.command("job.renew", attemptData(a), controller.signal));
              if (renewed.state !== "running" || typeof renewed.leaseExpiresAt !== "string" || !Number.isFinite(Date.parse(renewed.leaseExpiresAt)) ||
                  Date.parse(renewed.leaseExpiresAt) <= Date.now() || Date.parse(renewed.leaseExpiresAt) > Date.parse(a.runDeadlineAt)) throw Error("Invalid lease renewal");
              leaseExpires = Date.parse(renewed.leaseExpiresAt);
            } catch (error) { disconnected(error); controller.abort(Error("Lease renewal failed")); await adapter!.stop(); }
          }
        } finally { executionOpen = false; clearTimeout(deadlineTimer); clearInterval(leaseWatch); }
        if (streaming && (chunkInFlight || streamSequence < 1 || output.text !== streamText || output.generatedTokens !== streamTokens)) {
          controller.abort(Error("Stream result does not match acknowledged chunks")); throw Error("Invalid stream result");
        }
        authorizeExecution();
        if (output.generatedTokens > request.maxTokens) throw Error("Execution no longer authorized");
        // Leave room for the signed envelope around the complete output.
        if (Buffer.byteLength(JSON.stringify(output)) > MAX_WORKER_MESSAGE_BYTES - 4096) throw Error("Result exceeds signed transport limit");
        const outputDigest = requestDigest(output);
        authorizeExecution();
        await atomicPrivateJson(journal.resultPath(a), output);
        authorizeExecution();
        const entry = await journal.set(a, "result_pending", "awaiting_result_receipt", outputDigest);
        await sendResult(entry, authorizeExecution);
      } catch (error) {
        await adapter!.stop();
        const entry = journal.entries.get(a.attemptId);
        if (entry?.state === "finished") throw error;
        if (entry?.state !== "result_pending") {
          await journal.set(a, "abandoned", controller.signal.aborted ? "execution_cancelled" : "execution_failed");
          await journal.removeOutput(a);
          await reportFailure(a, controller.signal.aborted || !started ? "cancelled_locally" : "execution_error");
        }
        if (error instanceof WorkerConnectionError) disconnected(error);
      } finally { active = null; }
    };

    while (mode !== "stop" && !fatal) {
      if ((mode as WorkerMode) === "drain") { statusState = "draining"; statusReason = "drained"; break; }
      let assignments: Assignment[];
      try {
        const response = record(await connection.command("worker.poll", {}, lifetime.signal));
        if (typeof response.executionEnabled !== "boolean" || !Array.isArray(response.assignments) || response.assignments.length > 1) throw Error("Invalid polling response");
        assignments = response.assignments.map(value => assignment(value, connection!.deviceId));
        connected = true;
        for (const entry of [...journal.entries.values()]) {
          if (entry.state === "result_pending") {
            if (!await sendResult(entry)) break;
          }
        }
        if (!connected) { await pause(timing.pollMs); continue; }
        for (const a of assignments) {
          const prior = journal.entries.get(a.attemptId);
          if (prior) {
            if (requestDigest(prior.assignment) !== requestDigest(a)) {
              // Lease expiry may advance after acknowledgment; immutable identity
              // fields must still agree before any failure or result is reported.
              const { leaseExpiresAt: _old, ...oldIdentity } = prior.assignment;
              const { leaseExpiresAt: _new, ...newIdentity } = a;
              if (requestDigest(oldIdentity) !== requestDigest(newIdentity)) throw Error("Known attempt identity changed");
            }
            if (prior.state !== "result_pending" && prior.state !== "finished") await reportFailure(a, "cancelled_locally");
          }
        }
        const fresh = assignments.filter(a => !journal.entries.has(a.attemptId));
        if (fresh.length && !response.executionEnabled) {
          for (const a of fresh) { await journal.set(a, "seen", "execution_disabled"); await journal.set(a, "abandoned", "execution_disabled"); await reportFailure(a, "busy"); }
        }
        const decision = decide();
        if (!decision.allowed) { statusState = "blocked"; statusReason = decision.reason; statusDetail = decision.detail; await pause(timing.pollMs); continue; }
        if (probed && lastProbe && !fresh.length && Date.now() - Date.parse(lastProbe.probedAt) > REPROBE_MS) probed = false;
        if (!probed) {
          const controller = new AbortController(); active = { assignment: null, abort: controller };
          statusState = "starting"; statusReason = "probing_installed_model";
          const abortProbe = () => { void adapter!.stop().catch(() => {}); };
          controller.signal.addEventListener("abort", abortProbe, { once: true });
          try {
            const startedAt = Date.now();
            const proof = await adapter.probe();
            if (controller.signal.aborted) throw Error("Local probe failed");
            lastProbe = successfulProbe(proof, policy, startedAt);
            probed = true;
            statusState = "idle"; statusReason = "probe_complete";
            await state();
          } finally { controller.signal.removeEventListener("abort", abortProbe); active = null; }
        }
        if (mode !== "run" || !decide().allowed) continue;
        if (response.executionEnabled && fresh.length && connected && ![...journal.entries.values()].some(e => e.state === "result_pending")) {
          await perform(fresh[0]!);
        } else { statusState = "idle"; statusReason = "waiting_for_assignment"; statusDetail = undefined; await pause(timing.pollMs); }
      } catch (error) {
        if (error instanceof WorkerConnectionError) { disconnected(error); await pause(timing.pollMs); }
        else { fatal = safeReason(error); mode = "stop"; }
      }
    }
    if (fatal) await setWorkerControl(dir, "stop");
    statusState = fatal ? (fatal === "device_revoked_or_unauthorized" ? "revoked" : "error") : "stopped";
    statusReason = fatal ?? ((mode as WorkerMode) === "drain" ? "drained" : "stopped_locally");
    return { state: statusState, reason: statusReason };
  } catch (error) {
    statusState = "error"; statusReason = safeReason(error);
    await writeWorkerStatus(dir, { state: statusState, reason: statusReason, ...(lastProbe ? { lastProbe } : {}) });
    throw error;
  } finally {
    closing = true; lifetime.abort(); abortActive("runtime_shutdown");
    if (options.signal?.aborted) await setWorkerControl(dir, "stop").catch(() => {});
    let shutdownFailed = false, shutdownError: unknown;
    try { await adapter?.stop(); }
    catch (error) {
      shutdownFailed = true; shutdownError = error; statusState = "error"; statusReason = "adapter_stop_failed";
      // Never release ownership while a native process may still be running.
      // Marker-write failure itself leaves the guard for explicit inspection.
      await releaseLock.markShutdownUnverified().catch(() => {});
    }
    await Promise.allSettled(tasks);
    if (shutdownFailed) await setWorkerControl(dir, "stop").catch(() => {});
    // Withdraw capacity after every outstanding heartbeat has settled. A lost
    // withdrawal remains bounded by the coordinator's liveness/offer expiry.
    await connection?.heartbeat({ totalSlots: 1, availableSlots: 0, capabilityDigests: [] }, AbortSignal.timeout(2000)).catch(() => {});
    await writeWorkerStatus(dir, { state: statusState, reason: statusReason, ...(connection ? { deviceId: connection.deviceId } : {}), activeAttemptId: null,
      capabilityDigest: probed && !shutdownFailed ? capabilityDigest : null, ...(lastProbe ? { lastProbe } : {}) });
    if (shutdownFailed) throw new WorkerShutdownError(shutdownError);
    await releaseLock();
  }
}
