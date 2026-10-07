import test from 'node:test';
import assert from 'node:assert/strict';
import {createTextAdapter} from '../packages/adapters/dist/index.js';
import {DEFAULT_WORKER_POLICY,parseWorkerPolicy} from '../apps/worker/dist/policy.js';

test('GPU residency budget is independent of supplier system RAM and old CPU policy remains usable',()=>{
 const old={...DEFAULT_WORKER_POLICY};delete old.maxGpuMemoryMb;
 assert.equal(parseWorkerPolicy(old).maxGpuMemoryMb,4096);
 const policy=parseWorkerPolicy({...old,maxMemoryMb:2048,maxGpuMemoryMb:6144});
 assert.equal(policy.maxMemoryMb,2048);assert.equal(policy.maxGpuMemoryMb,6144);
 for(const value of [null,0,1023,32769,4096.5,'4096'])assert.throws(()=>parseWorkerPolicy({...old,maxGpuMemoryMb:value}),/maxGpuMemoryMb/);
});

test('public CUDA route requires the supported fixed model and an explicit adequate GPU budget',()=>{
 const options={threads:1,maxMemoryMb:6144,timeoutMs:60000,backend:'cuda',modelId:'qwen3-4b'};
 const windows=process.platform==='win32'&&process.arch==='x64';
 assert.throws(()=>createTextAdapter('unused',options),new RegExp(windows?'GPU_MEMORY_POLICY_REQUIRED':'GPU_ISOLATION_UNVERIFIED'));
 assert.throws(()=>createTextAdapter('unused',{...options,maxGpuMemoryMb:1024}),new RegExp(windows?'GPU_MEMORY_BELOW_MODEL_REQUIREMENT':'GPU_ISOLATION_UNVERIFIED'));
 assert.throws(()=>createTextAdapter('unused',{...options,modelId:'qwen3-8b',maxGpuMemoryMb:16384}),/GPU_ISOLATION_UNVERIFIED/);
 assert.throws(()=>createTextAdapter('unused',{...options,backend:'vulkan',maxGpuMemoryMb:6144}),/GPU_ISOLATION_UNVERIFIED/);
 // Validation does not launch hardware or claim that a configured machine passed.
 assert.doesNotThrow(()=>createTextAdapter('unused',{...options,backend:'cpu'}));
});
