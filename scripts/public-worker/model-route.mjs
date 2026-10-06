import { open, readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { catalogEntry } from '../../packages/adapters/dist/manifest.js';
import { hashFile, noLinks, downloadToCache, importModelFiles } from '../../packages/adapters/dist/install.js';
import { assertPublicBytes, assertNoPersonalPathsOrCredentials } from './privacy.mjs';

const HEADER_LIMIT = 32 * 1024 * 1024;
const vocabularyKeys = new Set(['tokenizer.ggml.tokens', 'tokenizer.ggml.merges']);
const fixedSizes = new Map([[0,1],[1,1],[2,2],[3,2],[4,4],[5,4],[6,4],[7,1],[10,8],[11,8],[12,8]]);

/** Inspect human-readable GGUF fields. Never return their values or local paths.
 * Vocabulary is immutable upstream data; callers must verify the catalog hash
 * before treating this inspection as permission to import or transfer a file. */
export function inspectGgufMetadata(input) {
  let offset = 0, vocabularyStrings = 0, vocabularyIdentifierMatches = 0, checkedStrings = 0;
  const invalid = () => { throw Error('MODEL_METADATA_INVALID'); };
  const take = count => {
    if (!Number.isSafeInteger(count) || count < 0 || offset + count > input.length) invalid();
    const bytes = input.subarray(offset, offset + count); offset += count; return bytes;
  };
  const u32 = () => take(4).readUInt32LE();
  const u64 = () => { const value = take(8).readBigUInt64LE(); if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid(); return Number(value); };
  const string = vocabulary => {
    const length = u64(); if (length > 1024 * 1024) invalid();
    const bytes = take(length);
    // Strict UTF-8: replacement decoding must not hide malformed metadata.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (vocabulary) {
      vocabularyStrings++;
      const marker = Buffer.from([97,97,114,111,110]).toString();
      vocabularyIdentifierMatches += text.toLowerCase().split(marker).length - 1;
    } else { assertPublicBytes(bytes); checkedStrings++; }
    return text;
  };
  const value = (type, vocabulary, depth = 0) => {
    if (depth > 1) invalid();
    if (type === 8) { string(vocabulary); return; }
    if (type === 9) {
      const element = u32(), count = u64();
      if (element === 9 || count > 2_000_000 || (vocabulary && element !== 8)) invalid();
      if (fixedSizes.has(element)) { take(count * fixedSizes.get(element)); return; }
      for (let i = 0; i < count; i++) value(element, vocabulary, depth + 1);
      return;
    }
    if (!fixedSizes.has(type) || vocabulary) invalid();
    take(fixedSizes.get(type));
  };
  if (take(4).toString() !== 'GGUF' || u32() !== 3) invalid();
  const tensors = u64(), fields = u64();
  if (tensors > 100_000 || fields > 10_000) invalid();
  const keys = new Set();
  for (let i = 0; i < fields; i++) {
    const key = string(false); if (keys.has(key)) invalid(); keys.add(key);
    const type = u32(), vocabulary = vocabularyKeys.has(key);
    if (vocabulary && type !== 9) invalid();
    value(type, vocabulary);
  }
  for (let i = 0; i < tensors; i++) {
    string(false); const dimensions = u32(); if (dimensions < 1 || dimensions > 4) invalid();
    for (let n = 0; n < dimensions; n++) u64();
    u32(); u64();
  }
  return { format: 'GGUF v3', fields, tensors, checkedStrings, vocabularyStrings,
    vocabularyIdentifierMatches, inspectedHeaderBytes: offset, personalMetadata: 'passed' };
}

export async function verifyPinnedModelFile(modelId, path) {
  const entry = catalogEntry(modelId);
  await noLinks(path);
  const bytes = (await stat(path)).size;
  if (!entry.artifacts.some(item=>item.name.endsWith('.gguf') && item.bytes===bytes)) throw Error('MODEL_CATALOG_HASH_MISMATCH');
  const digest = await hashFile(path, bytes);
  const artifact = entry.artifacts.find(item => item.name.endsWith('.gguf') && item.bytes === bytes && item.sha256 === digest);
  if (!artifact) throw Error('MODEL_CATALOG_HASH_MISMATCH');
  const handle = await open(path, 'r');
  let report;
  try {
    const buffer = Buffer.alloc(Math.min(bytes, HEADER_LIMIT));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    report = inspectGgufMetadata(buffer.subarray(0, bytesRead));
  } finally { await handle.close(); }
  return { modelId, artifact: artifact.name, bytes, sha256: digest, source: artifact.url,
    licence: entry.capability.modelLicence, immutableUpstreamVocabulary: true, ...report };
}

export async function modelRoute(command, modelId, destination, paths, flags) {
  if (!['verify','import','download'].includes(command)) throw Error('MODEL_ROUTE_COMMAND_INVALID');
  const entry = catalogEntry(modelId), signal = AbortSignal.timeout(6 * 60 * 60 * 1000);
  if (command === 'verify') {
    if (paths.length !== 1) throw Error('MODEL_ROUTE_FILE_REQUIRED');
    return verifyPinnedModelFile(modelId, paths[0]);
  }
  if (!flags.has('--accept-licenses') || (command === 'download' && !flags.has('--accept-download'))) throw Error('MODEL_ROUTE_CONSENT_REQUIRED');
  const root = resolve(destination); assertPublicBytes(Buffer.from(root)); await noLinks(root);
  let sources = paths;
  if (command === 'download') {
    if (paths.length) throw Error('MODEL_ROUTE_ARGUMENTS_INVALID');
    sources = [];
    for (const artifact of entry.artifacts.filter(item => item.name.endsWith('.gguf')))
      sources.push(await downloadToCache(artifact, join(root,'downloads'), signal));
  }
  if (!sources.length) throw Error('MODEL_ROUTE_FILE_REQUIRED');
  const reports = [];
  for (const path of sources) reports.push(await verifyPinnedModelFile(modelId,path));
  const result = await importModelFiles(root, modelId, sources, {consent:true,signal});
  const licences = [];
  if (result.installed) for (const artifact of entry.artifacts.filter(item => item.name.startsWith('licences/'))) {
    const path = join(root,'models',modelId,artifact.name);
    if (await hashFile(path,artifact.bytes) !== artifact.sha256) throw Error('MODEL_LICENCE_HASH_MISMATCH');
    // Keep required upstream attribution verbatim. Only the exact catalog licence
    // receives this exception; personal paths and credentials still fail.
    assertNoPersonalPathsOrCredentials(await readFile(path));
    licences.push({artifact:artifact.name,bytes:artifact.bytes,sha256:artifact.sha256,source:artifact.url});
  }
  return {modelId,installed:result.installed,missing:result.missing,
    files:result.files.map(({artifact,method})=>({artifact,method})),licences,reports};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command,modelId,...args] = process.argv.slice(2), flags = new Set(args.filter(arg=>arg.startsWith('--')));
    if ([...flags].some(flag=>!['--accept-download','--accept-licenses'].includes(flag))) throw Error('MODEL_ROUTE_ARGUMENTS_INVALID');
    const positional = args.filter(arg=>!arg.startsWith('--'));
    const destination = command === 'verify' ? '' : positional.shift();
    if (!modelId || (command !== 'verify' && !destination)) throw Error('MODEL_ROUTE_ARGUMENTS_INVALID');
    console.log(JSON.stringify(await modelRoute(command,modelId,destination,positional,flags)));
  } catch (error) {
    const code = String(error?.code ?? error?.message ?? 'MODEL_ROUTE_FAILED');
    console.error(/^[A-Z][A-Z0-9_]+$/.test(code) ? code : 'MODEL_ROUTE_FAILED (details suppressed)'); process.exitCode = 1;
  }
}
