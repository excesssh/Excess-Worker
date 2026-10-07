import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const checks = z.strictObject({
  signedInstallation: z.literal(true), cpuInference: z.literal(true),
  fundedBuyerJob: z.literal(true), controllerBoundary: z.literal(true),
  drain: z.literal(true), restart: z.literal(true), revoke: z.literal(true),
  cleanup: z.literal(true),
});
const platform = z.strictObject({
  payloadSha256: digest, checks, gpuInference: z.boolean(), gpuCancellation: z.boolean(),
  configuration: z.string().min(1).max(512),
  reports: z.array(z.strictObject({ name: z.string().regex(/^[A-Za-z0-9_.-]+$/), sha256: digest })).min(1).max(16),
});
const schema = z.strictObject({
  format: z.literal(1), testedSourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  signedCandidateSequence: z.number().int().positive(), signedManifestSha256: digest,
  platforms: z.strictObject({ 'win32-x64': platform, 'linux-x64': platform }),
});

// Manifest/readme changes cannot confer execution evidence. Bind every executable,
// dependency, pin, launcher and licence byte; exclude only release metadata and onboarding.
export function payloadFingerprint(entries) {
  const rows = entries.filter(([name]) => !['manifest.json', 'SHA256SUMS.txt', 'ONBOARDING.txt'].includes(name));
  const seen = new Set();
  for (const [name, bytes] of rows) {
    if (!/^[A-Za-z0-9_@+./-]+$/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..') || seen.has(name) || !(bytes instanceof Uint8Array))
      throw Error('EXECUTION_PAYLOAD_INVALID');
    seen.add(name);
  }
  rows.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return hash(rows.map(([name, bytes]) => hash(bytes) + '  ' + name + '\n').join(''));
}

export async function packagePayloadFingerprint(root) {
  const entries = [];
  async function walk(directory, prefix = '') {
    if ((await lstat(directory)).isSymbolicLink()) throw Error('EXECUTION_PAYLOAD_LINK_DENIED');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix ? prefix + '/' + entry.name : entry.name, path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path, name);
      else if (entry.isFile()) entries.push([name, await readFile(path)]);
      else throw Error('EXECUTION_PAYLOAD_SPECIAL_FILE_DENIED');
    }
  }
  await walk(root);
  return payloadFingerprint(entries);
}

/** Reviewed operator reports, not independent hardware attestation. The publisher
 * still verifies the exact final signed archives and network update journey. */
export function verifyExecutionEvidence(bytes, selectedPlatform, payloadSha256, sequence) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 32768) throw Error('EXECUTION_EVIDENCE_INVALID');
  let value;
  try { value = schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  catch { throw Error('EXECUTION_EVIDENCE_INVALID'); }
  const selected = value.platforms[selectedPlatform];
  if (!selected || selected.payloadSha256 !== payloadSha256 || sequence <= value.signedCandidateSequence)
    throw Error('EXECUTION_EVIDENCE_BINDING_MISMATCH');
  if (selectedPlatform === 'win32-x64' && (!selected.gpuInference || !selected.gpuCancellation) ||
      selectedPlatform === 'linux-x64' && (selected.gpuInference || selected.gpuCancellation))
    throw Error('EXECUTION_EVIDENCE_GPU_SCOPE_INVALID');
  return { testedSourceCommit: value.testedSourceCommit, payloadSha256,
    evidenceSha256: hash(bytes), gpuVerified: selected.gpuInference, configuration: selected.configuration };
}
