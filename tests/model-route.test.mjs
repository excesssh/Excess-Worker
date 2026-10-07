import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { inspectGgufMetadata, verifyPinnedModelFile, modelRoute } from '../scripts/public-worker/model-route.mjs';
import { assertPublicBytes } from '../scripts/public-worker/privacy.mjs';

const u32 = value => {const bytes=Buffer.alloc(4);bytes.writeUInt32LE(value);return bytes;};
const u64 = value => {const bytes=Buffer.alloc(8);bytes.writeBigUInt64LE(BigInt(value));return bytes;};
const str = value => {const bytes=Buffer.from(value);return Buffer.concat([u64(bytes.length),bytes]);};
const marker = Buffer.from([97,97,114,111,110]).toString();
const gguf = fields => Buffer.concat([Buffer.from('GGUF'),u32(3),u64(0),u64(fields.length),
  ...fields.flatMap(([key,value])=>[str(key),u32(Array.isArray(value)?9:8),
    ...(Array.isArray(value)?[u32(8),u64(value.length),...value.map(str)]:[str(value)])])]);

test('immutable upstream vocabulary is classified without exposing its values',()=>{
  const bytes=gguf([['general.name','Qwen3'],['tokenizer.ggml.tokens',['hello',marker]],['tokenizer.ggml.merges',[marker+' word']]]);
  assert.throws(()=>assertPublicBytes(bytes),/PRIVACY_IDENTIFIER_BLOCKED/);
  const report=inspectGgufMetadata(bytes);
  assert.equal(report.vocabularyIdentifierMatches,2);
  assert.equal(report.vocabularyStrings,3);
  assert.equal(report.personalMetadata,'passed');
  assert.ok(!JSON.stringify(report).includes(marker));
});
test('vocabulary classification never permits personal metadata or tensor names',()=>{
  for(const key of ['general.name','general.author','general.description'])
    assert.throws(()=>inspectGgufMetadata(gguf([[key,marker]])),/PRIVACY_IDENTIFIER_BLOCKED/);
  const tensor=Buffer.concat([Buffer.from('GGUF'),u32(3),u64(1),u64(0),str(marker),u32(1),u64(1),u32(0),u64(0)]);
  assert.throws(()=>inspectGgufMetadata(tensor),/PRIVACY_IDENTIFIER_BLOCKED/);
});
test('paths and credentials in ordinary GGUF metadata remain blocked',()=>{
  const values=[['C:','Users','private-user','model'].join('\\'),
    ['https:','','user:secret@example.invalid','model'].join('/'),
    'gh'+'p_'+'1'.repeat(36)];
  for(const value of values)assert.throws(()=>inspectGgufMetadata(gguf([['general.description',value]])),/PRIVACY_CONTENT_BLOCKED/);
});
test('malformed GGUF arrays, duplicate keys, lengths and truncated headers fail closed',()=>{
  const bytes=gguf([['general.name','Qwen3']]);
  for(const end of [0,4,20,bytes.length-1])assert.throws(()=>inspectGgufMetadata(bytes.subarray(0,end)));
  assert.throws(()=>inspectGgufMetadata(gguf([['general.name','one'],['general.name','two']])),/MODEL_METADATA_INVALID/);
  assert.throws(()=>inspectGgufMetadata(gguf([['tokenizer.ggml.tokens','wrong type']])),/MODEL_METADATA_INVALID/);
  const bomb=Buffer.concat([Buffer.from('GGUF'),u32(3),u64(0),u64(1),str('tokenizer.ggml.tokens'),u32(9),u32(8),u64(2_000_001)]);
  assert.throws(()=>inspectGgufMetadata(bomb),/MODEL_METADATA_INVALID/);
});
test('the transfer route requires an exact catalog artifact and explicit consent',async()=>{
  const root=await mkdtemp(resolve('.cache/model-route-'));
  try {
    const path=join(root,'model.gguf');await writeFile(path,gguf([]));
    for(const id of ['qwen3-4b','qwen3-embedding-0.6b','qwen3-asr-0.6b','sd-turbo','flux1-schnell']) {
      await assert.rejects(verifyPinnedModelFile(id,path),/MODEL_CATALOG_HASH_MISMATCH/);
      await assert.rejects(modelRoute('download',id,root,[],new Set(['--accept-licenses'])),/MODEL_ROUTE_CONSENT_REQUIRED/);
    }
    await assert.rejects(verifyPinnedModelFile('unknown-model',path),/UNKNOWN_MODEL/);
    await assert.rejects(modelRoute('import','qwen3-4b',root,[path],new Set()),/MODEL_ROUTE_CONSENT_REQUIRED/);
    await assert.rejects(modelRoute('download','qwen3-4b',root,[],new Set(['--accept-licenses'])),/MODEL_ROUTE_CONSENT_REQUIRED/);
  } finally {await rm(root,{recursive:true,force:true});}
});
