import { parseTextRequest, parseTextResult, type TextRequest, type TextResult, type MediaOutput } from "@excess/adapters";
import { requestDigest, textChunkSchema, textResultSchema, TEXT_LIMITS, MEDIA_LIMITS, mediaResultSchema, mediaResultUnits, type MediaRequest, type MediaResult } from "@excess/protocol";
import type { WindowsControllerJson } from "./windows-controller.js";

type Payload = Readonly<Record<string, WindowsControllerJson>>;
type HostHandler = (payload: Payload, signal: AbortSignal) => Promise<WindowsControllerJson>;
import { checkedMediaRequest, checkedMediaInputs, checkedMediaOutput, checkedMediaArtifacts, mediaRefs, mediaPart, mediaHash, WINDOWS_MEDIA_PROOF_BYTES, type WindowsMediaArtifactProof } from "./windows-media-validation.js";

type Assignment = {
  jobId: string; attemptId: string; deviceId: string; fence: string; leaseExpiresAt: string;
  runDeadlineAt: string; offerId: string; capabilityDigest: string; requestDigest: string; maxUnits: string;
};

/** This proof store must be host-owned, outside child-writable state. It stores
 * only assignment identity/digests and the bounded adapter output needed for
 * coordinator lost-receipt recovery; it must never store the prompt. */
export type WindowsTextExecutionProof = Readonly<{
  assignment: Assignment;
  inputDigest: string;
  output: TextResult | MediaResult;
  artifacts?: readonly WindowsMediaArtifactProof[];
  outputDigest: string;
  completedAt: string;
  /** Durable receipt marker closes the coordinator-accepted/worker-journal crash window. */
  receiptAccepted?: boolean;
}>;
export interface WindowsTextExecutionProofStore {
  load(): Promise<unknown | null>;
  save(proof: WindowsTextExecutionProof): Promise<void>;
  clear(attemptId: string): Promise<void>;
}
export interface WindowsTextExecutionHostOptions {
  readonly coordinator: { handle: HostHandler; close(): Promise<void> };
  readonly adapter: { handle: HostHandler; close(): Promise<void>; setInputs?(inputs: ReadonlyMap<string, Buffer>): void; readOutput?(): MediaOutput | undefined };
  readonly media?: { check(request: unknown): MediaRequest };
  readonly proofStore: WindowsTextExecutionProofStore;
  readonly deviceId: string;
  readonly capabilityDigest: string;
  readonly runSeconds: number;
  readonly now?: () => number;
}

type Attempt = {
  assignment: Assignment;
  executionEnabled?: boolean;
  phase: "assigned" | "input" | "running" | "completed";
  input?: TextRequest | MediaRequest;
  inputs?: Map<string, Buffer>;
  inputParts?: Set<number>;
  deliveryMode?: "buffered" | "stream";
  inputDigest?: string;
  leaseExpiresAt?: number;
  startedAt?: number;
  sessionId?: string;
  chunkSequence: number;
  chunkText: string;
  chunkTokens: number;
  outstandingChunk?: ReturnType<typeof textChunkSchema.parse>;
  adapterError: boolean;
  stopObserved: boolean;
  executeStarting?: boolean;
  pulling?: boolean;
  proof?: WindowsTextExecutionProof;
};
type DeferredAssignment = { assignment: Assignment; executionEnabled: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const FENCE = /^[1-9][0-9]{0,18}$/;
const MAX_FENCE = 9223372036854775807n;
const MAX_UNITS = /^[1-9][0-9]{0,77}$/;
const ASSIGNMENT_KEYS = "attemptId,capabilityDigest,deviceId,fence,jobId,leaseExpiresAt,maxUnits,offerId,requestDigest,runDeadlineAt";
const MAX_PROOF_BYTES = WINDOWS_MEDIA_PROOF_BYTES;
const outputUnits = (output: TextResult | MediaResult) => "kind" in output ? mediaResultUnits(output) : output.generatedTokens;
const parseOutput = (value: unknown): TextResult | MediaResult => value && typeof value === "object" && "kind" in value ? mediaResultSchema.parse(value) : textResultSchema.parse(value);

function invalid(code = "CONTROLLER_EXECUTION_INVALID"): never { throw Error(code); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: string): Record<string, unknown> {
  const item = object(value);
  if (Object.keys(item).sort().join(",") !== keys) invalid();
  return item;
}
function date(value: unknown): number {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) invalid();
  return Date.parse(value);
}
function parseAssignment(value: unknown, deviceId: string, capabilityDigest: string, now: number, allowExpired = false): Assignment {
  const item = exact(value, ASSIGNMENT_KEYS);
  for (const name of ["jobId", "attemptId", "deviceId", "offerId"] as const) {
    if (typeof item[name] !== "string" || !UUID.test(item[name] as string)) invalid();
  }
  if (item.deviceId !== deviceId || item.capabilityDigest !== capabilityDigest ||
      typeof item.capabilityDigest !== "string" || !DIGEST.test(item.capabilityDigest) ||
      typeof item.requestDigest !== "string" || !DIGEST.test(item.requestDigest) ||
      typeof item.fence !== "string" || !FENCE.test(item.fence) || BigInt(item.fence) > MAX_FENCE ||
      typeof item.maxUnits !== "string" || !MAX_UNITS.test(item.maxUnits)) invalid();
  const lease = date(item.leaseExpiresAt), deadline = date(item.runDeadlineAt);
  if ((!allowExpired && (lease <= now || deadline <= now)) || lease > deadline) invalid("CONTROLLER_EXECUTION_ASSIGNMENT_EXPIRED");
  return item as unknown as Assignment;
}
function sameAttempt(a: Assignment, b: Assignment): boolean {
  return a.jobId === b.jobId && a.attemptId === b.attemptId && a.deviceId === b.deviceId && a.fence === b.fence &&
    a.offerId === b.offerId && a.capabilityDigest === b.capabilityDigest && a.requestDigest === b.requestDigest &&
    a.maxUnits === b.maxUnits && a.runDeadlineAt === b.runDeadlineAt;
}
function attemptData(value: unknown, a: Assignment): Record<string, unknown> {
  const item = object(value);
  for (const key of ["jobId", "attemptId", "fence"]) if (!Object.hasOwn(item, key)) invalid();
  if (item.jobId !== a.jobId || item.attemptId !== a.attemptId || item.fence !== a.fence) invalid("CONTROLLER_EXECUTION_ATTEMPT_MISMATCH");
  return item;
}
function success(value: WindowsControllerJson): unknown | undefined {
  const envelope = object(value);
  if (envelope.ok !== true) return undefined;
  if (Object.keys(envelope).sort().join(",") !== "ok,value") invalid();
  return envelope.value;
}
function digest(value: unknown): string {
  try { return requestDigest(value); } catch { return ""; }
}
function noOwnerMarker(result: TextResult | MediaResult): void {
  const marker = ["aa", "ron"].join("").toLowerCase();
  if (JSON.stringify(result).toLowerCase().includes(marker)) invalid("CONTROLLER_EXECUTION_OUTPUT_PRIVACY");
}
export function parseWindowsTextExecutionProof(value: unknown, deviceId: string, capabilityDigest: string, now: number): WindowsTextExecutionProof {
  const proof = object(value);
  const keys = Object.keys(proof).sort().join(",");
  if (keys !== "assignment,completedAt,inputDigest,output,outputDigest" &&
      keys !== "assignment,completedAt,inputDigest,output,outputDigest,receiptAccepted" &&
      keys !== "artifacts,assignment,completedAt,inputDigest,output,outputDigest" &&
      keys !== "artifacts,assignment,completedAt,inputDigest,output,outputDigest,receiptAccepted") invalid("CONTROLLER_EXECUTION_PROOF_INVALID");
  if (proof.receiptAccepted !== undefined && typeof proof.receiptAccepted !== "boolean") invalid("CONTROLLER_EXECUTION_PROOF_INVALID");
  const assignment = parseAssignment(proof.assignment, deviceId, capabilityDigest, now, true);
  if (typeof proof.inputDigest !== "string" || !DIGEST.test(proof.inputDigest) ||
      typeof proof.outputDigest !== "string" || !DIGEST.test(proof.outputDigest)) invalid("CONTROLLER_EXECUTION_PROOF_INVALID");
  const output = parseOutput(proof.output);
  const artifacts = "kind" in output ? checkedMediaArtifacts(output, proof.artifacts) : undefined;
  if (!("kind" in output) && proof.artifacts !== undefined) invalid("CONTROLLER_EXECUTION_PROOF_INVALID");
  noOwnerMarker(output);
  if (digest(output) !== proof.outputDigest || BigInt(outputUnits(output)) > BigInt(assignment.maxUnits)) invalid("CONTROLLER_EXECUTION_PROOF_INVALID");
  const completedAt = new Date(date(proof.completedAt)).toISOString();
  if (Date.parse(completedAt) > Date.parse(assignment.runDeadlineAt) || Date.parse(completedAt) > Date.parse(assignment.leaseExpiresAt)) invalid("CONTROLLER_EXECUTION_PROOF_INVALID");
  if (Buffer.byteLength(JSON.stringify(proof), "utf8") > MAX_PROOF_BYTES) invalid("CONTROLLER_EXECUTION_PROOF_LIMIT");
  return { assignment, inputDigest: proof.inputDigest, output, outputDigest: proof.outputDigest, completedAt,
    ...(artifacts ? { artifacts } : {}),
    ...(proof.receiptAccepted === true ? { receiptAccepted: true } : {}) };
}
function live(a: Attempt, now: number, runSeconds: number): void {
  const lease = a.leaseExpiresAt ?? Date.parse(a.assignment.leaseExpiresAt);
  const deadline = Math.min(Date.parse(a.assignment.runDeadlineAt), (a.startedAt ?? now) + runSeconds * 1000);
  if (now >= lease || now >= deadline) invalid("CONTROLLER_EXECUTION_LEASE_EXPIRED");
}

/** Couples the otherwise separate signing and adapter RPCs. This protects the
 * signing key from child-chosen job/result data; it does not attest the model or
 * make a malicious adapter honest. */
export async function createWindowsTextExecutionHost(options: WindowsTextExecutionHostOptions) {
  if (!UUID.test(options.deviceId) || !DIGEST.test(options.capabilityDigest) ||
      !Number.isSafeInteger(options.runSeconds) || options.runSeconds < 1 || options.runSeconds > 3600) invalid();
  const now = options.now ?? Date.now;
  let current: Attempt | undefined, pendingProof: WindowsTextExecutionProof | undefined;
  let deferredAssignment: DeferredAssignment | undefined, probeSessionId: string | undefined, probeStarting = false, probePulling = false, stopInFlight = false;
  let stopPromise: Promise<WindowsControllerJson> | undefined;
  let closing = false, closePromise: Promise<void> | undefined;
  let mutationTail: Promise<void> = Promise.resolve();
  let activeHandlers = 0, drainHandlers: (() => void) | undefined;
  let loaded = false, loadPromise: Promise<WindowsTextExecutionProof | null> | undefined;
  const load = async (signal: AbortSignal) => {
    if (!loadPromise) loadPromise = (async () => {
      const value = await options.proofStore.load();
      if (value === null) return null;
      const stored = object(value);
      // A host-owned accepted receipt can survive a model change. Validate it
      // against its original capability and retain it until newer input arrives.
      // Unaccepted work must still recover under the current capability.
      const capability = stored.receiptAccepted === true ? object(stored.assignment).capabilityDigest : options.capabilityDigest;
      if (typeof capability !== "string") invalid();
      return parseWindowsTextExecutionProof(value, options.deviceId, capability, now());
    })();
    const proof = await loadPromise;
    if (closing || signal.aborted) invalid("CONTROLLER_EXECUTION_CLOSED");
    if (!loaded) { pendingProof = proof ?? undefined; loaded = true; }
  };
  const assertCurrent = (attempt: Attempt) => { if (closing || current !== attempt) invalid("CONTROLLER_EXECUTION_STATE_CHANGED"); };
  const enter = () => {
    if (closing) invalid("CONTROLLER_EXECUTION_CLOSED");
    activeHandlers++;
    let done = false;
    return () => {
      if (done) return; done = true; activeHandlers--;
      if (closing && activeHandlers === 0) { drainHandlers?.(); drainHandlers = undefined; }
    };
  };
  const serialize = async (signal: AbortSignal, action: () => Promise<WindowsControllerJson>): Promise<WindowsControllerJson> => {
    const previous = mutationTail;
    let unlock!: () => void;
    mutationTail = new Promise<void>(resolve => { unlock = resolve; });
    await previous;
    try {
      if (closing || signal.aborted) invalid("CONTROLLER_EXECUTION_CLOSED");
      return await action();
    } finally { unlock(); }
  };
  const activateDeferred = (proof: WindowsTextExecutionProof) => {
    if (current?.proof === proof) current = undefined;
    if (pendingProof === proof) pendingProof = undefined;
    if (deferredAssignment && !sameAttempt(deferredAssignment.assignment, proof.assignment) &&
        Date.parse(deferredAssignment.assignment.leaseExpiresAt) > now() && Date.parse(deferredAssignment.assignment.runDeadlineAt) > now()) {
      current = { assignment: deferredAssignment.assignment, executionEnabled: deferredAssignment.executionEnabled,
        phase: "assigned", chunkSequence: 0, chunkText: "", chunkTokens: 0, adapterError: false, stopObserved: false };
    }
    deferredAssignment = undefined;
  };
  const finishProof = async (proof: WindowsTextExecutionProof) => {
    await options.proofStore.clear(proof.assignment.attemptId);
    if (closing) invalid("CONTROLLER_EXECUTION_CLOSED");
    activateDeferred(proof);
  };
  const markReceiptAccepted = async (proof: WindowsTextExecutionProof) => {
    const accepted = proof.receiptAccepted ? proof : { ...proof, receiptAccepted: true as const };
    await options.proofStore.save(accepted);
    if (closing) invalid("CONTROLLER_EXECUTION_CLOSED");
    if (pendingProof === proof) pendingProof = accepted;
    if (current?.proof === proof) current.proof = accepted;
  };
  const relayProof = async (proof: WindowsTextExecutionProof, signal: AbortSignal) => {
    const a = proof.assignment;
    const payload: Payload = { action: "command", type: "job.result", data: {
      jobId: a.jobId, attemptId: a.attemptId, fence: a.fence, outputDigest: proof.outputDigest,
      reportedUnits: String(outputUnits(proof.output)), output: proof.output,
    } };
    if ("kind" in proof.output) {
      for (const artifact of proof.artifacts ?? []) {
        const bytes = mediaPart(artifact.data, artifact.ref.bytes), parts = Math.ceil(bytes.length / MEDIA_LIMITS.artifactPartBytes);
        for (let part = 0; part < parts; part++) {
          if (closing || signal.aborted) invalid("CONTROLLER_EXECUTION_CLOSED");
          const upload = await options.coordinator.handle({ action: "command", type: "job.artifact", data: {
            jobId: a.jobId, attemptId: a.attemptId, fence: a.fence, ...artifact.ref, part, parts,
            data: bytes.subarray(part * MEDIA_LIMITS.artifactPartBytes, (part + 1) * MEDIA_LIMITS.artifactPartBytes).toString("base64") } }, signal);
          const got = success(upload);
          if (got === undefined) {
            const envelope = object(upload);
            if (envelope.ok === false && [404, 409].includes(Number(envelope.status))) await finishProof(proof);
            return upload;
          }
          const receipt = object(got);
          if (receipt.accepted !== true && !(receipt.digest === artifact.ref.digest && receipt.part === part)) invalid("CONTROLLER_EXECUTION_ARTIFACT_RECEIPT_INVALID");
        }
      }
    }
    const response = await options.coordinator.handle(payload, signal);
    if (closing || signal.aborted) invalid("CONTROLLER_EXECUTION_CLOSED");
    const value = success(response), errorEnvelope = object(response);
    if (value !== undefined && object(value).accepted === true) await markReceiptAccepted(proof);
    else if (errorEnvelope.ok === false && [404, 409].includes(Number(errorEnvelope.status))) await finishProof(proof);
    return response;
  };
  const coordinator: HostHandler = async (payload, signal) => {
    const leave = enter();
    try {
    if (signal.aborted) invalid("CONTROLLER_EXECUTION_CLOSED");
    await load(signal);
    if (closing || signal.aborted) invalid("CONTROLLER_EXECUTION_CLOSED");
    const request = object(payload), action = request.action;
    if (action === "command") {
      return serialize(signal, async () => {
      const command = exact(request, "action,data,type");
      const type = command.type, data = object(command.data);
      if (typeof type !== "string") invalid();
      if (type === "job.usage" || (!options.media && ["job.artifact", "job.artifact.read"].includes(type))) invalid("CONTROLLER_EXECUTION_TEXT_ONLY");
      if (type === "job.artifact.read") {
        if (!current || current.phase !== "input" || !current.input || !("kind" in current.input) || current.input.kind !== "transcription") invalid("CONTROLLER_EXECUTION_INPUT_UNOBSERVED");
        const active = current, ref = current.input.audio;
        exact(data, "attemptId,digest,fence,jobId,part"); attemptData(data, active.assignment); live(active, now(), options.runSeconds);
        const parts = Math.ceil(ref.bytes / MEDIA_LIMITS.artifactPartBytes);
        if (data.digest !== ref.digest || !Number.isSafeInteger(data.part) || Number(data.part) < 0 || Number(data.part) >= parts) invalid("CONTROLLER_EXECUTION_ARTIFACT_MISMATCH");
        const response = await options.coordinator.handle(payload, signal); assertCurrent(active); live(active, now(), options.runSeconds);
        const value = success(response); if (value === undefined) return response;
        const got = object(value), part = Number(data.part), size = Math.min(MEDIA_LIMITS.artifactPartBytes, ref.bytes - part * MEDIA_LIMITS.artifactPartBytes);
        if (got.digest !== ref.digest || got.part !== part || got.parts !== parts) invalid("CONTROLLER_EXECUTION_ARTIFACT_MISMATCH");
        const bytes = mediaPart(got.data, size);
        active.inputs ??= new Map(); active.inputParts ??= new Set();
        let cached = active.inputs.get(ref.digest);
        if (!cached) { cached = Buffer.alloc(ref.bytes); active.inputs.set(ref.digest, cached); }
        if (active.inputParts.has(part) && !cached.subarray(part * MEDIA_LIMITS.artifactPartBytes, part * MEDIA_LIMITS.artifactPartBytes + size).equals(bytes)) invalid("CONTROLLER_EXECUTION_ARTIFACT_CHANGED");
        bytes.copy(cached, part * MEDIA_LIMITS.artifactPartBytes); active.inputParts.add(part);
        return response;
      }
      if (type === "job.artifact") {
        exact(data, "attemptId,bytes,contentType,data,digest,fence,jobId,part,parts");
        const proof = current?.proof ?? pendingProof;
        if (!proof || !("kind" in proof.output)) invalid("CONTROLLER_EXECUTION_RESULT_UNOBSERVED");
        attemptData(data, proof.assignment);
        const artifact = proof.artifacts?.find(item => item.ref.digest === data.digest);
        if (!artifact) invalid("CONTROLLER_EXECUTION_ARTIFACT_MISMATCH");
        const ref = artifact.ref, part = Number(data.part), parts = Math.ceil(ref.bytes / MEDIA_LIMITS.artifactPartBytes);
        if (!Number.isSafeInteger(part) || part < 0 || part >= parts || data.parts !== parts || data.bytes !== ref.bytes || data.contentType !== ref.contentType) invalid("CONTROLLER_EXECUTION_ARTIFACT_MISMATCH");
        const bytes = mediaPart(artifact.data, ref.bytes), expected = bytes.subarray(part * MEDIA_LIMITS.artifactPartBytes, (part + 1) * MEDIA_LIMITS.artifactPartBytes).toString("base64");
        if (data.data !== expected) invalid("CONTROLLER_EXECUTION_ARTIFACT_MISMATCH");
        return options.coordinator.handle(payload, signal);
      }
      if (type === "worker.poll") {
        if (Object.keys(data).length !== 0) invalid();
        if (current && current.phase !== "completed") invalid("CONTROLLER_EXECUTION_ATTEMPT_BUSY");
        const response = await options.coordinator.handle(payload, signal);
        if (closing || signal.aborted) invalid("CONTROLLER_EXECUTION_CLOSED");
        const value = success(response); if (value === undefined) return response;
        const poll = exact(value, "assignments,executionEnabled");
        if (typeof poll.executionEnabled !== "boolean" || !Array.isArray(poll.assignments) || poll.assignments.length > 1) invalid();
        if (current?.phase === "completed") {
          if (current.proof) pendingProof = current.proof;
          current = undefined;
        }
        if (poll.assignments.length) {
          const a = parseAssignment(poll.assignments[0], options.deviceId, options.capabilityDigest, now());
          if (pendingProof) {
            if (!sameAttempt(pendingProof.assignment, a)) {
              if (deferredAssignment && !sameAttempt(deferredAssignment.assignment, a)) invalid("CONTROLLER_EXECUTION_ASSIGNMENT_CHANGED");
              deferredAssignment = { assignment: a, executionEnabled: poll.executionEnabled };
            } else deferredAssignment = undefined;
          } else {
            deferredAssignment = undefined;
            current = { assignment: a, executionEnabled: poll.executionEnabled, phase: "assigned", chunkSequence: 0, chunkText: "", chunkTokens: 0, adapterError: false, stopObserved: false };
          }
        } else deferredAssignment = undefined;
        return response;
      }
      if (type === "job.result") {
        const data = exact(command.data, "attemptId,fence,jobId,output,outputDigest,reportedUnits");
        const currentMatch = current && current.assignment.jobId === data.jobId && current.assignment.attemptId === data.attemptId && current.assignment.fence === data.fence ? current : undefined;
        const pending = pendingProof;
        const proof = currentMatch?.proof ?? (pending && pending.assignment.jobId === data.jobId && pending.assignment.attemptId === data.attemptId && pending.assignment.fence === data.fence ? pending : undefined);
        if (!proof) invalid("CONTROLLER_EXECUTION_RESULT_UNOBSERVED");
        attemptData(data, proof.assignment);
        const output = parseOutput(data.output);
        if (digest(output) !== proof.outputDigest || data.outputDigest !== proof.outputDigest ||
            data.reportedUnits !== String(outputUnits(output))) invalid("CONTROLLER_EXECUTION_RESULT_MISMATCH");
        if (proof.receiptAccepted) return { ok: true, value: { accepted: true } };
        const response = await options.coordinator.handle(payload, signal);
        if (closing || signal.aborted) invalid("CONTROLLER_EXECUTION_CLOSED");
        const value = success(response), errorEnvelope = object(response);
        if (value !== undefined && object(value).accepted === true) await markReceiptAccepted(proof);
        else if (errorEnvelope.ok === false && [404, 409].includes(Number(errorEnvelope.status))) await finishProof(proof);
        return response;
      }
      if (type === "job.input" && pendingProof?.receiptAccepted && deferredAssignment &&
          !sameAttempt(deferredAssignment.assignment, pendingProof.assignment)) {
        exact(command.data, "attemptId,fence,jobId");
        if (data.jobId !== deferredAssignment.assignment.jobId || data.attemptId !== deferredAssignment.assignment.attemptId ||
            data.fence !== deferredAssignment.assignment.fence) {
          invalid("CONTROLLER_EXECUTION_ATTEMPT_MISMATCH");
        }
        const acceptedProof = pendingProof;
        await options.proofStore.clear(acceptedProof.assignment.attemptId);
        if (closing || signal.aborted) invalid("CONTROLLER_EXECUTION_CLOSED");
        activateDeferred(acceptedProof);
      }
      if (type === "job.failed" && pendingProof) {
        const failed = exact(command.data, "attemptId,fence,jobId,reason"), proof = pendingProof;
        if (failed.jobId !== proof.assignment.jobId || failed.attemptId !== proof.assignment.attemptId || failed.fence !== proof.assignment.fence ||
            !["busy", "execution_error", "cancelled_locally"].includes(String(failed.reason))) invalid("CONTROLLER_EXECUTION_ATTEMPT_MISMATCH");
        return relayProof(proof, signal);
      }
      if (["job.input", "job.started", "job.renew", "job.chunk", "job.failed"].includes(type)) {
        if (!current) invalid("CONTROLLER_EXECUTION_NO_ASSIGNMENT");
        const a = current.assignment;
        attemptData(data, a);
        if (type === "job.input") {
          exact(data, "attemptId,fence,jobId");
          if (current.phase !== "assigned" || current.executionEnabled === false) invalid("CONTROLLER_EXECUTION_STATE_INVALID");
          live(current, now(), options.runSeconds);
          const active = current;
          const response = await options.coordinator.handle(payload, signal);
          assertCurrent(active);
          const value = success(response); if (value === undefined) return response;
          const input = object(value);
          const allowed = ["capabilityDigest", "deliveryMode", "request", "requestDigest", ...(options.media ? ["artifacts"] : [])];
          if (Object.keys(input).some(key => !allowed.includes(key)) ||
              input.capabilityDigest !== a.capabilityDigest || input.requestDigest !== a.requestDigest ||
              (input.deliveryMode !== undefined && input.deliveryMode !== "buffered" && input.deliveryMode !== "stream")) invalid("CONTROLLER_EXECUTION_INPUT_MISMATCH");
          const parsed = options.media ? options.media.check(checkedMediaRequest(input.request, a.maxUnits)) : parseTextRequest(input.request);
          if (options.media && input.deliveryMode !== "buffered") invalid("CONTROLLER_EXECUTION_INPUT_MISMATCH");
          if (options.media) {
            const refs = "kind" in parsed && parsed.kind === "transcription" ? [parsed.audio] : [];
            const listed = input.artifacts ?? [];
            if (!Array.isArray(listed) || listed.length !== refs.length || refs.some((ref, i) => {
              const item = object(listed[i]); return item.digest !== ref.digest || item.bytes !== ref.bytes || item.contentType !== ref.contentType || item.parts !== Math.ceil(ref.bytes / MEDIA_LIMITS.artifactPartBytes);
            })) invalid("CONTROLLER_EXECUTION_INPUT_MISMATCH");
          }
          if (digest(parsed) !== a.requestDigest || (!("kind" in parsed) && BigInt(parsed.maxTokens) > BigInt(a.maxUnits))) invalid("CONTROLLER_EXECUTION_INPUT_MISMATCH");
          active.input = parsed; active.deliveryMode = input.deliveryMode === "stream" ? "stream" : "buffered";
          active.inputDigest = digest({ request: parsed, deliveryMode: active.deliveryMode, capabilityDigest: a.capabilityDigest });
          active.phase = "input";
          return response;
        }
        if (type === "job.started" || type === "job.renew") {
          if (type === "job.started" ? current.phase !== "input" || current.executionEnabled === false : current.phase !== "running") invalid("CONTROLLER_EXECUTION_STATE_INVALID");
          exact(data, "attemptId,fence,jobId");
          if (type === "job.started" && options.media && current.input && "kind" in current.input) checkedMediaInputs(current.input, current.inputs ?? new Map());
          live(current, now(), options.runSeconds);
          const active = current;
          const response = await options.coordinator.handle(payload, signal);
          assertCurrent(active);
          const value = success(response); if (value === undefined) return response;
          const lease = object(value);
          if (lease.state !== "running" || typeof lease.leaseExpiresAt !== "string") invalid("CONTROLLER_EXECUTION_LEASE_INVALID");
          const expiry = date(lease.leaseExpiresAt), deadline = Math.min(Date.parse(a.runDeadlineAt), now() + options.runSeconds * 1000);
          if (expiry <= now() || expiry > Date.parse(a.runDeadlineAt) || expiry > deadline ||
              (type === "job.renew" && expiry < (current.leaseExpiresAt ?? 0))) invalid("CONTROLLER_EXECUTION_LEASE_INVALID");
          active.leaseExpiresAt = expiry; active.assignment = { ...active.assignment, leaseExpiresAt: lease.leaseExpiresAt as string };
          if (type === "job.started") { active.startedAt = now(); active.phase = "running"; }
          return response;
        }
        if (type === "job.chunk") {
          if (current.phase !== "running" || current.deliveryMode !== "stream" || !current.outstandingChunk) invalid("CONTROLLER_EXECUTION_CHUNK_UNOBSERVED");
          exact(data, "attemptId,chunkDigest,delta,fence,jobId,sequence,tokenIds");
          live(current, now(), options.runSeconds);
          const { sequence, delta, tokenIds, chunkDigest } = textChunkSchema.parse({ sequence: data.sequence, delta: data.delta, tokenIds: data.tokenIds, chunkDigest: data.chunkDigest });
          const expected = current.outstandingChunk;
          if (sequence !== expected.sequence || delta !== expected.delta || chunkDigest !== expected.chunkDigest ||
              JSON.stringify(tokenIds) !== JSON.stringify(expected.tokenIds)) invalid("CONTROLLER_EXECUTION_CHUNK_MISMATCH");
          const active = current;
          const response = await options.coordinator.handle(payload, signal);
          assertCurrent(active);
          const value = success(response); if (value === undefined) return response;
          const receipt = object(value);
          if (receipt.accepted !== true || receipt.sequence !== sequence || receipt.chunkDigest !== chunkDigest) invalid("CONTROLLER_EXECUTION_CHUNK_RECEIPT_INVALID");
          active.chunkSequence = sequence; active.chunkText += delta; active.chunkTokens += tokenIds.length; delete active.outstandingChunk;
          return response;
        }
        if (type === "job.failed") {
          exact(data, "attemptId,fence,jobId,reason");
          if (current.phase === "completed" || typeof data.reason !== "string" ||
              (data.reason === "execution_error" && !current.adapterError) ||
              (data.reason === "cancelled_locally" && current.phase === "running" && !current.stopObserved) ||
              (data.reason === "busy" && current.executionEnabled !== false) ||
              !["busy", "execution_error", "cancelled_locally"].includes(data.reason)) invalid("CONTROLLER_EXECUTION_FAILURE_UNOBSERVED");
          const active = current;
          const response = await options.coordinator.handle(payload, signal);
          assertCurrent(active);
          const value = success(response);
          const errorEnvelope = object(response);
      if (value !== undefined && object(value).accepted === true || errorEnvelope.ok === false && [404, 409].includes(Number(errorEnvelope.status))) {
            await options.proofStore.clear(a.attemptId); assertCurrent(active); current = undefined;
            if (pendingProof?.assignment.attemptId === a.attemptId) pendingProof = undefined;
          }
          return response;
        }
      }
      return options.coordinator.handle(payload, signal);
      });
    }
    return options.coordinator.handle(payload, signal);
    } finally { leave(); }
  };
  const adapter: HostHandler = async (payload, signal) => {
    const leave = enter();
    try {
    if (signal.aborted) invalid("CONTROLLER_EXECUTION_CLOSED");
    await load(signal);
    if (closing || signal.aborted) invalid("CONTROLLER_EXECUTION_CLOSED");
    const request = object(payload), action = request.action;
    if (action === "probe") {
      if (Object.keys(request).length !== 1 || current?.phase === "running" || probeStarting || probePulling || probeSessionId || stopInFlight) invalid("CONTROLLER_EXECUTION_STATE_INVALID");
      probeStarting = true;
      try {
        const response = await options.adapter.handle(payload, signal), value = object(response);
        if (closing || signal.aborted) invalid("CONTROLLER_EXECUTION_CLOSED");
        if (stopInFlight) invalid("CONTROLLER_EXECUTION_STATE_CHANGED");
        if (typeof value.id !== "string" || !UUID.test(value.id)) invalid("CONTROLLER_EXECUTION_SESSION_INVALID");
        probeSessionId = value.id;
        return response;
      } finally { probeStarting = false; }
    }
    if (action === "execute") {
      if (!current || current.phase !== "running" || !current.input || !current.inputDigest) invalid("CONTROLLER_EXECUTION_NO_LIVE_INPUT");
      const active = current;
      if (active.executeStarting || active.sessionId || probeStarting || probeSessionId || pendingProof || stopInFlight) invalid("CONTROLLER_EXECUTION_SESSION_BUSY");
      live(active, now(), options.runSeconds);
      const data = exact(request, "action,request,streaming");
      const parsed = options.media ? options.media.check(checkedMediaRequest(data.request, active.assignment.maxUnits)) : parseTextRequest(data.request);
      if (digest(parsed) !== digest(active.input) || data.streaming !== (active.deliveryMode === "stream")) invalid("CONTROLLER_EXECUTION_PROMPT_MISMATCH");
      active.executeStarting = true;
      try {
        if (options.media) {
          checkedMediaInputs(parsed as MediaRequest, active.inputs ?? new Map());
          if (!options.adapter.setInputs) invalid("CONTROLLER_EXECUTION_MEDIA_UNAVAILABLE");
          options.adapter.setInputs(active.inputs ?? new Map());
        }
        const response = await options.adapter.handle(payload, signal);
        assertCurrent(active);
        if (signal.aborted) invalid("CONTROLLER_EXECUTION_CLOSED");
        if (stopInFlight || active.stopObserved) invalid("CONTROLLER_EXECUTION_STATE_CHANGED");
        const value = object(response);
        if (value.kind !== undefined || typeof value.id !== "string" || !UUID.test(value.id)) invalid("CONTROLLER_EXECUTION_SESSION_INVALID");
        active.sessionId = value.id;
        return response;
      } catch (error) {
        if (error instanceof Error && /^CONTROLLER_ADAPTER_/.test(error.message) && error.message !== "CONTROLLER_ADAPTER_BUSY" && current === active) active.adapterError = true;
        throw error;
      } finally {
        if (current === active) active.executeStarting = false;
      }
    }
    if (action === "artifact.read") {
      const data = exact(request, "action,digest,part"), proof = current?.proof ?? pendingProof;
      if (!options.media || !proof || !("kind" in proof.output)) invalid("CONTROLLER_EXECUTION_RESULT_UNOBSERVED");
      const artifact = proof.artifacts?.find(item => item.ref.digest === data.digest), part = Number(data.part);
      if (!artifact || !Number.isSafeInteger(part) || part < 0 || part >= Math.ceil(artifact.ref.bytes / MEDIA_LIMITS.artifactPartBytes)) invalid("CONTROLLER_EXECUTION_ARTIFACT_MISMATCH");
      const bytes = mediaPart(artifact.data, artifact.ref.bytes);
      return { digest: artifact.ref.digest, part, data: bytes.subarray(part * MEDIA_LIMITS.artifactPartBytes, (part + 1) * MEDIA_LIMITS.artifactPartBytes).toString("base64") };
    }
    if (action === "pull") {
      const probeData = object(request);
      if (probeSessionId && probeData.id === probeSessionId) {
        if (probePulling || stopInFlight) invalid("CONTROLLER_EXECUTION_PULL_BUSY");
        exact(request, "ack,action,id");
        probePulling = true;
        try {
          const response = await options.adapter.handle(payload, signal), value = object(response);
          if (closing || signal.aborted) invalid("CONTROLLER_EXECUTION_CLOSED");
          if (value.kind === "probe" || value.kind === "error") probeSessionId = undefined;
          else if (value.kind !== "pending") invalid("CONTROLLER_EXECUTION_ADAPTER_EVENT_INVALID");
          return response;
        } finally { probePulling = false; }
      }
      if (!current || current.phase !== "running" || !current.sessionId) invalid("CONTROLLER_EXECUTION_SESSION_INVALID");
      const active = current;
      if (active.pulling || active.outstandingChunk || stopInFlight) invalid("CONTROLLER_EXECUTION_PULL_BUSY");
      const data = exact(request, "ack,action,id");
      if (data.id !== active.sessionId) invalid("CONTROLLER_EXECUTION_SESSION_INVALID");
      live(active, now(), options.runSeconds);
      active.pulling = true;
      try {
        const response = await options.adapter.handle(payload, signal);
        assertCurrent(active);
        if (signal.aborted) invalid("CONTROLLER_EXECUTION_CLOSED");
        live(active, now(), options.runSeconds);
        const value = object(response);
        if (value.kind === "chunk") {
          if (active.deliveryMode !== "stream" || active.outstandingChunk) invalid("CONTROLLER_EXECUTION_CHUNK_INVALID");
          const chunk = textChunkSchema.parse(value.chunk);
          if (chunk.sequence !== active.chunkSequence + 1 || chunk.chunkDigest !== digest({ sequence: chunk.sequence, delta: chunk.delta, tokenIds: chunk.tokenIds }) ||
              Buffer.from(chunk.delta, "utf8").toString("utf8") !== chunk.delta || active.chunkTokens + chunk.tokenIds.length > (active.input as TextRequest).maxTokens ||
              Buffer.byteLength(active.chunkText + chunk.delta, "utf8") > TEXT_LIMITS.maxOutputBytes) invalid("CONTROLLER_EXECUTION_CHUNK_INVALID");
          active.outstandingChunk = chunk;
        } else if (value.kind === "result") {
          let output: TextResult | MediaResult, artifacts: WindowsMediaArtifactProof[] | undefined;
          if (options.media) {
            const observed = options.adapter.readOutput?.();
            if (!observed || digest(observed.result) !== digest(value.result)) invalid("CONTROLLER_EXECUTION_RESULT_UNOBSERVED");
            const checked = checkedMediaOutput(active.input as MediaRequest, observed, active.assignment.maxUnits);
            output = checked.result;
            artifacts = checked.artifacts.map(item => ({ ref: item.ref, data: item.data.toString("base64") }));
            value.result = output;
          } else {
            output = parseTextResult(value.result);
            if (output.generatedTokens > (active.input as TextRequest).maxTokens || BigInt(output.generatedTokens) > BigInt(active.assignment.maxUnits) ||
                (active.deliveryMode === "stream" && (active.outstandingChunk || output.text !== active.chunkText || output.generatedTokens !== active.chunkTokens))) invalid("CONTROLLER_EXECUTION_RESULT_MISMATCH");
          }
          noOwnerMarker(output);
          const completedAt = now();
          if (completedAt > Date.parse(active.assignment.runDeadlineAt) || completedAt > (active.startedAt ?? completedAt) + options.runSeconds * 1000) invalid("CONTROLLER_EXECUTION_LEASE_EXPIRED");
          const proof: WindowsTextExecutionProof = { assignment: active.assignment, inputDigest: active.inputDigest!, output,
            outputDigest: digest(output), completedAt: new Date(completedAt).toISOString(), ...(artifacts ? { artifacts } : {}) };
          if (!proof.outputDigest || Buffer.byteLength(JSON.stringify(proof), "utf8") > MAX_PROOF_BYTES) invalid("CONTROLLER_EXECUTION_PROOF_LIMIT");
          if (pendingProof && pendingProof.assignment.attemptId !== active.assignment.attemptId) invalid("CONTROLLER_EXECUTION_RECEIPT_PENDING");
          await options.proofStore.save(proof);
          assertCurrent(active);
          if (signal.aborted) invalid("CONTROLLER_EXECUTION_CLOSED");
          active.proof = proof; active.phase = "completed"; delete active.sessionId;
          pendingProof = proof; active.inputs?.clear(); delete active.inputParts;
        } else if (value.kind === "error") {
          active.adapterError = true; delete active.sessionId;
        } else if (value.kind !== "pending") invalid("CONTROLLER_EXECUTION_ADAPTER_EVENT_INVALID");
        return response;
      } catch (error) {
        if (options.media && current === active) active.adapterError = true;
        throw error;
      } finally { if (current === active) active.pulling = false; }
    }
    if (action === "stop") {
      if (Object.keys(request).length !== 1) invalid();
      // Abort listeners, execution unwind and final shutdown can all request
      // stop. They must await the same verified reap; a duplicate is not a
      // cleanup failure, and an actual reap failure remains a failure for all.
      if (!stopPromise) {
        const active = current;
        stopInFlight = true;
        stopPromise = Promise.resolve().then(async () => {
          const result = await options.adapter.handle(payload, signal);
          if (closing || signal.aborted) invalid("CONTROLLER_EXECUTION_CLOSED");
          if (exact(result, "stopped").stopped !== true) invalid("CONTROLLER_ADAPTER_STOP_UNCONFIRMED");
          if (active && current === active && active.phase === "running") { active.stopObserved = true; delete active.sessionId; }
          probeSessionId = undefined;
          return result;
        }).finally(() => { stopInFlight = false; stopPromise = undefined; });
      }
      const result = await stopPromise;
      if (closing || signal.aborted) invalid("CONTROLLER_EXECUTION_CLOSED");
      return result;
    }
    invalid("CONTROLLER_EXECUTION_ADAPTER_ACTION_INVALID");
    } finally { leave(); }
  };
  return Object.freeze({
    handleCoordinator: coordinator,
    handleAdapter: adapter,
    async close(): Promise<void> {
      if (!closePromise) {
        closing = true;
        const drained = activeHandlers === 0 ? Promise.resolve() : new Promise<void>(resolve => { drainHandlers = resolve; });
        closePromise = (async () => {
          const results = await Promise.allSettled([options.adapter.close(), options.coordinator.close()]);
          await drained;
          if (results.some(result => result.status === "rejected")) invalid("CONTROLLER_EXECUTION_CLEANUP_UNCONFIRMED");
        })();
      }
      return closePromise;
    },
  });
}
