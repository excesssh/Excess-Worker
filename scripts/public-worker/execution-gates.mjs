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
const schemaV1 = z.strictObject({
  format: z.literal(1), testedSourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  signedCandidateSequence: z.number().int().positive(), signedManifestSha256: digest,
  platforms: z.strictObject({ 'win32-x64': platform, 'linux-x64': platform }),
});
const gpuScope = z.strictObject({
  profile: z.literal('linux-cuda-device-budget-v2'), backend: z.literal('cuda'),
  gpuCount: z.literal(1), device: z.literal(0),
  gpu: z.string().regex(/(?:H100|H200|B300)/).max(256),
  driver: z.string().regex(/^[0-9.]+$/), cuda: z.literal('12.9'),
  kernel: z.string().min(1).max(128), landlockAbi: z.number().int().min(6),
  memoryMonitoring: z.literal('whole-device-nvml'),
  hardVramPartition: z.literal(false),
  checks: z.strictObject({ cancellation: z.literal(true), resourceLimitRefusal: z.literal(true),
    drain: z.literal(true), restart: z.literal(true), revocation: z.literal(true), cleanup: z.literal(true) }),
  verifiedModels: z.array(z.strictObject({
    model: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/).max(128),
    task: z.enum(['text', 'embedding', 'transcription', 'image']),
    capabilityDigest: digest, reportSha256: digest,
    maxMemoryMb: z.number().int().min(1024).max(129024),
    maxGpuMemoryMb: z.number().int().min(1024).max(131072),
  })).min(1).max(64),
});
const platformV2 = platform.extend({ gpuScope: gpuScope.optional() });
const schemaV2 = schemaV1.extend({ format: z.literal(2),
  platforms: z.strictObject({ 'win32-x64': platformV2, 'linux-x64': platformV2 }),
});
const schema = z.discriminatedUnion('format', [schemaV1, schemaV2]);

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
  const linuxGpu = selectedPlatform === 'linux-x64' && selected.gpuInference;
  if (selectedPlatform === 'win32-x64' && (!selected.gpuInference || !selected.gpuCancellation || selected.gpuScope) ||
      selectedPlatform === 'linux-x64' && (
        value.format === 1 && (selected.gpuInference || selected.gpuCancellation) ||
        value.format === 2 && (selected.gpuInference !== selected.gpuCancellation ||
          linuxGpu !== Boolean(selected.gpuScope))))
    throw Error('EXECUTION_EVIDENCE_GPU_SCOPE_INVALID');
  if (selected.gpuScope && new Set(selected.gpuScope.verifiedModels.map(row => row.model)).size !== selected.gpuScope.verifiedModels.length)
    throw Error('EXECUTION_EVIDENCE_GPU_SCOPE_INVALID');
  return { testedSourceCommit: value.testedSourceCommit, payloadSha256,
    evidenceSha256: hash(bytes), gpuVerified: selected.gpuInference, configuration: selected.configuration,
    ...(selected.gpuScope ? { gpuScope: selected.gpuScope } : {}) };
}
