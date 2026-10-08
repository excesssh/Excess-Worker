import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join, parse, relative, resolve, sep } from "node:path";
import { requestDigest, TEXT_LIMITS } from "@excess/protocol";
import { parseWindowsTextExecutionProof, type WindowsTextExecutionProof, type WindowsTextExecutionProofStore } from "./windows-controller-execution.js";

import { WINDOWS_MEDIA_PROOF_BYTES } from "./windows-media-validation.js";
const LIMIT = WINDOWS_MEDIA_PROOF_BYTES + 16384;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = (code = "CONTROLLER_EXECUTION_PROOF_INVALID"): never => { throw Error(code); };

async function noLinks(path: string): Promise<void> {
  const full = resolve(path), root = parse(full).root;
  let current = root;
  for (const part of relative(root, full).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) fail(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  }
}
function privacy(value: unknown, depth = 0): void {
  if (depth > 16) fail();
  if (typeof value === "string") {
    if (value.toLowerCase().includes(["aa", "ron"].join("")) ||
        /[a-z]:[\\/]+users[\\/]+|\/mnt\/[a-z]\/users\//i.test(value)) fail("CONTROLLER_EXECUTION_PROOF_PRIVACY");
  } else if (Array.isArray(value)) {
    for (const item of value) privacy(item, depth + 1);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) { privacy(key, depth + 1); privacy(item, depth + 1); }
  }
}
function proof(value: unknown): WindowsTextExecutionProof {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const item = value as Record<string, unknown>, keys = Object.keys(item).sort().join(",");
  if (keys !== "assignment,completedAt,inputDigest,output,outputDigest" &&
      keys !== "assignment,completedAt,inputDigest,output,outputDigest,receiptAccepted" &&
      keys !== "artifacts,assignment,completedAt,inputDigest,output,outputDigest" &&
      keys !== "artifacts,assignment,completedAt,inputDigest,output,outputDigest,receiptAccepted") fail();
  const assignment = item.assignment as Record<string, unknown> | undefined;
  if (!assignment || typeof assignment !== "object" || typeof assignment.attemptId !== "string" || !UUID.test(assignment.attemptId) ||
      (item.receiptAccepted !== undefined && item.receiptAccepted !== true)) fail();
  privacy(item);
  const media = item.output && typeof item.output === "object" && "kind" in item.output;
  if (Buffer.byteLength(JSON.stringify(item)) > (media ? WINDOWS_MEDIA_PROOF_BYTES : TEXT_LIMITS.maxOutputBytes * 4 + 8192)) fail("CONTROLLER_EXECUTION_PROOF_LIMIT");
  return item as unknown as WindowsTextExecutionProof;
}

function resultDigest(value: WindowsTextExecutionProof): string {
  const { receiptAccepted: _receipt, ...result } = value;
  if (!result.artifacts) return requestDigest(result);
  // Recovery proofs can contain megabytes of base64 artifact bytes. Compare
  // their exact encoded bytes separately; protocol messages stay bounded.
  const artifacts = result.artifacts.map(({ data, ...metadata }) => ({ metadata,
    encodedDataDigest: createHash("sha256").update("excess:proof-artifact:v1\n").update(data, "utf8").digest("hex") }));
  return requestDigest({ ...result, artifacts });
}

/** Host-only recovery data. The parent state directory must already have its
 * private ACL; this subdirectory inherits it and is absent from all controller
 * state selectors and AppContainer grants. No prompt is stored. */
export async function createWindowsExecutionProofStore(stateDir: string): Promise<WindowsTextExecutionProofStore & {
  checkRetirement(deviceId: string): Promise<void>;
  retire(deviceId: string, destination: string): Promise<void>;
  close(): Promise<void>;
}> {
  const root = join(resolve(stateDir), "host-execution-proof"), target = join(root, "proof.json");
  await noLinks(stateDir);
  await mkdir(root, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  let closing = false, closePromise: Promise<void> | undefined, tail: Promise<void> = Promise.resolve();
  let queued = 0;
  const directory = async () => {
    await noLinks(root);
    const info = await lstat(root);
    if (!info.isDirectory() || (process.platform === "linux" && (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700))) fail();
    const names = await readdir(root);
    if (names.some(name => name !== "proof.json")) fail("CONTROLLER_EXECUTION_PROOF_RECOVERY_REQUIRED");
  };
  const read = async (): Promise<WindowsTextExecutionProof | null> => {
    await directory();
    let file;
    try { file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    try {
      const before = await file.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > LIMIT ||
          (process.platform === "linux" && (before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600))) fail();
      const bytes = await file.readFile(), after = await file.stat(), current = await lstat(target);
      if (bytes.length !== before.size || after.size !== before.size || current.isSymbolicLink() || current.nlink !== 1 ||
          after.mtimeMs !== before.mtimeMs || current.dev !== before.dev || current.ino !== before.ino) fail();
      let value: unknown;
      try { value = JSON.parse(bytes.toString("utf8")); } catch { fail(); }
      const envelope = value as Record<string, unknown>;
      if (!envelope || typeof envelope !== "object" || Object.keys(envelope).sort().join(",") !== "proof,version" || envelope.version !== 1) fail();
      return proof(envelope.proof);
    } finally { await file.close(); }
  };
  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    if (closing) return Promise.reject(Error("CONTROLLER_EXECUTION_PROOF_CLOSED"));
    if (++queued > 8) { queued--; return Promise.reject(Error("CONTROLLER_EXECUTION_PROOF_BUSY")); }
    const result = tail.then(action);
    tail = result.then(() => undefined, () => undefined);
    return result.finally(() => { queued--; });
  };
  await directory();
  const accepted = async (deviceId: string) => {
    if (!UUID.test(deviceId)) fail("CONTROLLER_EXECUTION_DEVICE_MISMATCH");
    const previous = await read();
    if (!previous) return;
    if (previous.assignment.deviceId !== deviceId) fail("CONTROLLER_EXECUTION_DEVICE_MISMATCH");
    parseWindowsTextExecutionProof(previous, deviceId, previous.assignment.capabilityDigest, Date.now());
    if (previous.receiptAccepted !== true) fail("CONTROLLER_EXECUTION_RECEIPT_PENDING");
  };
  return Object.freeze({
    load: () => serialize(read),
    checkRetirement: (deviceId: string) => serialize(() => accepted(deviceId)),
    // Called only while the outside host runtime lock excludes execution.
    // Preserve accepted evidence with the retired identity; do not discard it.
    retire: (deviceId: string, destination: string) => serialize(async () => {
      await accepted(deviceId);
      await noLinks(destination);
      const folder = await lstat(destination), before = await lstat(root);
      if (!folder.isDirectory() || (process.platform === "linux" &&
          (folder.uid !== process.getuid?.() || (folder.mode & 0o777) !== 0o700))) fail();
      const target = join(destination, "host-execution-proof");
      try { await lstat(target); fail("CONTROLLER_EXECUTION_PROOF_RECOVERY_REQUIRED"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await directory();
      const current = await lstat(root);
      if (current.dev !== before.dev || current.ino !== before.ino) fail();
      await rename(root, target);
    }),
    save: (value: WindowsTextExecutionProof) => {
      let candidate: WindowsTextExecutionProof, bytes: Buffer;
      try {
        candidate = proof(value);
        bytes = Buffer.from(JSON.stringify({ version: 1, proof: candidate }) + "\n", "utf8");
        if (bytes.length > LIMIT) fail("CONTROLLER_EXECUTION_PROOF_LIMIT");
        // Snapshot before the first await; callers cannot mutate queued data.
        candidate = proof(JSON.parse(bytes.toString("utf8")).proof);
      } catch (error) { return Promise.reject(error); }
      return serialize(async () => {
        const previous = await read();
        if (previous && previous.assignment.attemptId !== candidate.assignment.attemptId) fail("CONTROLLER_EXECUTION_RECEIPT_PENDING");
        if (previous?.receiptAccepted && !candidate.receiptAccepted) fail("CONTROLLER_EXECUTION_RECEIPT_REGRESSION");
        if (previous) {
          if (resultDigest(previous) !== resultDigest(candidate)) fail("CONTROLLER_EXECUTION_PROOF_CHANGED");
        }
        const stage = join(root, ".proof-" + randomUUID() + ".tmp");
        let created = false;
        try {
          const file = await open(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); created = true;
          try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
          await rename(stage, target); created = false;
        } finally { if (created) await unlink(stage).catch(() => {}); }
      });
    },
    clear: (attemptId: string) => serialize(async () => {
      if (!UUID.test(attemptId)) fail();
      const previous = await read();
      if (previous && previous.assignment.attemptId !== attemptId) fail("CONTROLLER_EXECUTION_ATTEMPT_MISMATCH");
      if (previous) await unlink(target);
    }),
    close: () => {
      if (!closePromise) { closing = true; closePromise = tail; }
      return closePromise;
    },
  });
}
