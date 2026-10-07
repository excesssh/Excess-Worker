import test from 'node:test';
import assert from 'node:assert/strict';
import { payloadFingerprint, verifyExecutionEvidence } from '../scripts/public-worker/execution-gates.mjs';

const entries = [['app/worker/dist/main.js', Buffer.from('inert gate fixture')], ['manifest.json', Buffer.from('{}')]];
const payload = payloadFingerprint(entries);
const checks = Object.fromEntries(['signedInstallation','cpuInference','fundedBuyerJob','controllerBoundary','drain','restart','revoke','cleanup'].map(key => [key, true]));
const platform = gpu => ({payloadSha256:payload, checks:{...checks}, gpuInference:gpu, gpuCancellation:gpu,
  configuration:'Inert gate fixture; no hardware claim', reports:[{name:'fixture.json',sha256:'1'.repeat(64)}]});
const report = () => ({format:1,testedSourceCommit:'2'.repeat(40),signedCandidateSequence:13,signedManifestSha256:'3'.repeat(64),
  platforms:{'win32-x64':platform(true),'linux-x64':platform(false)}});
const bytes = value => Buffer.from(JSON.stringify(value));

test('execution evidence binds all payload bytes and refuses missing journey checks', () => {
  assert.equal(payloadFingerprint([...entries].reverse()), payload);
  assert.equal(payloadFingerprint([...entries, ['ONBOARDING.txt',Buffer.from('notes')]]), payload);
  const changed = [['app/worker/dist/main.js',Buffer.from('changed')]];
  assert.notEqual(payloadFingerprint(changed), payload);
  assert.throws(() => payloadFingerprint([...entries,entries[0]]), /EXECUTION_PAYLOAD_INVALID/);
  assert.throws(() => payloadFingerprint([['../outside',Buffer.from('x')]]), /EXECUTION_PAYLOAD_INVALID/);
  assert.equal(verifyExecutionEvidence(bytes(report()),'win32-x64',payload,14).gpuVerified,true);
  assert.equal(verifyExecutionEvidence(bytes(report()),'linux-x64',payload,14).gpuVerified,false);
  assert.throws(() => verifyExecutionEvidence(bytes(report()),'win32-x64',payloadFingerprint(changed),14), /BINDING_MISMATCH/);
  assert.throws(() => verifyExecutionEvidence(bytes(report()),'win32-x64',payload,13), /BINDING_MISMATCH/);
  for (const key of Object.keys(checks)) {
    const missing = report();missing.platforms['win32-x64'].checks[key]=false;
    assert.throws(() => verifyExecutionEvidence(bytes(missing),'win32-x64',payload,14), /EVIDENCE_INVALID/);
  }
  const missingCancel=report();missingCancel.platforms['win32-x64'].gpuCancellation=false;
  assert.throws(() => verifyExecutionEvidence(bytes(missingCancel),'win32-x64',payload,14), /GPU_SCOPE_INVALID/);
  const linuxGpu=report();linuxGpu.platforms['linux-x64'].gpuInference=true;
  assert.throws(() => verifyExecutionEvidence(bytes(linuxGpu),'linux-x64',payload,14), /GPU_SCOPE_INVALID/);
});
