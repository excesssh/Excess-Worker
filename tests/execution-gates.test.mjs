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

test('Linux GPU evidence requires the monitored device profile and names only verified models', () => {
  const value = report(); value.format = 2;
  const linux = value.platforms['linux-x64'];
  linux.gpuInference = linux.gpuCancellation = true;
  assert.throws(() => verifyExecutionEvidence(bytes(value), 'linux-x64', payload, 14), /GPU_SCOPE_INVALID/);
  linux.gpuScope = { profile:'linux-cuda-device-budget-v1', backend:'cuda', gpuCount:1, device:0,
    gpu:'NVIDIA H200', driver:'580.178.04', cuda:'12.9', kernel:'7.0.0-38-generic', landlockAbi:6,
    memoryMonitoring:'whole-device-nvml', hardVramPartition:false,
    checks:Object.fromEntries(['cancellation','resourceLimitRefusal','drain','restart','revocation','cleanup'].map(key => [key,true])),
    verifiedModels:[{model:'qwen3-4b',task:'text',capabilityDigest:'4'.repeat(64),reportSha256:'5'.repeat(64),maxMemoryMb:6144,maxGpuMemoryMb:6144}] };
  const accepted = verifyExecutionEvidence(bytes(value), 'linux-x64', payload, 14);
  assert.deepEqual(accepted.gpuScope.verifiedModels.map(row => row.model), ['qwen3-4b']);
  assert.equal(accepted.gpuScope.hardVramPartition, false);
  for (const [field, wrong] of [['profile','linux-landlock-v1'],['gpuCount',2],['backend','vulkan'],['landlockAbi',5],['hardVramPartition',true]]) {
    const invalid = structuredClone(value); invalid.platforms['linux-x64'].gpuScope[field] = wrong;
    assert.throws(() => verifyExecutionEvidence(bytes(invalid), 'linux-x64', payload, 14), /EVIDENCE_INVALID/);
  }
  const missingCancel = structuredClone(value); missingCancel.platforms['linux-x64'].gpuCancellation = false;
  assert.throws(() => verifyExecutionEvidence(bytes(missingCancel), 'linux-x64', payload, 14), /GPU_SCOPE_INVALID/);
  const duplicate = structuredClone(value); duplicate.platforms['linux-x64'].gpuScope.verifiedModels.push({...linux.gpuScope.verifiedModels[0]});
  assert.throws(() => verifyExecutionEvidence(bytes(duplicate), 'linux-x64', payload, 14), /GPU_SCOPE_INVALID/);
  const noGpu = report(); noGpu.format = 2;
  assert.equal(verifyExecutionEvidence(bytes(noGpu), 'linux-x64', payload, 14).gpuVerified, false);
});
