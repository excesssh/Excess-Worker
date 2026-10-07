import test from 'node:test';
import assert from 'node:assert/strict';
import {createTextAdapter,createMediaAdapter} from '../packages/adapters/dist/index.js';
import {DEFAULT_WORKER_POLICY,parseWorkerPolicy} from '../apps/worker/dist/policy.js';

test('GPU residency budget is independent of supplier system RAM and old CPU policy remains usable',()=>{
 const old={...DEFAULT_WORKER_POLICY};delete old.maxGpuMemoryMb;
 assert.equal(parseWorkerPolicy(old).maxGpuMemoryMb,4096);
 const policy=parseWorkerPolicy({...old,maxMemoryMb:2048,maxGpuMemoryMb:6144});
 assert.equal(policy.maxMemoryMb,2048);assert.equal(policy.maxGpuMemoryMb,6144);
 for(const value of [null,0,1023,131073,4096.5,'4096'])assert.throws(()=>parseWorkerPolicy({...old,maxGpuMemoryMb:value}),/maxGpuMemoryMb/);
 assert.equal(parseWorkerPolicy({...old,maxGpuMemoryMb:98304}).maxGpuMemoryMb,98304);
});

test('image authentication admission is limited to the patched Linux CUDA runtime',()=>{
 const options={threads:1,maxMemoryMb:6144,timeoutMs:60000,modelId:'sd-turbo',backend:'cuda',maxGpuMemoryMb:6144};
 if(process.platform==='linux'&&process.arch==='x64') {
  assert.doesNotThrow(()=>createMediaAdapter('unused',options));
  assert.throws(()=>createMediaAdapter('unused',{...options,maxGpuMemoryMb:1024}),/GPU_MEMORY_BELOW_MODEL_REQUIREMENT/);
 } else assert.throws(()=>createMediaAdapter('unused',options),/RUNTIME_AUTH_UNSUPPORTED/);
 for(const backend of ['cpu','vulkan'])assert.throws(()=>createMediaAdapter('unused',{...options,backend}),/RUNTIME_AUTH_UNSUPPORTED/);
 // Admission is checked here; installed hashes, native profile and real GPU work remain separate gates.
});

test('public CUDA route requires the supported fixed model and an explicit adequate GPU budget',()=>{
 const options={threads:1,maxMemoryMb:6144,timeoutMs:60000,backend:'cuda',modelId:'qwen3-4b'};
 const windows=process.platform==='win32'&&process.arch==='x64',linux=process.platform==='linux'&&process.arch==='x64';
 assert.throws(()=>createTextAdapter('unused',options),new RegExp(windows||linux?'GPU_MEMORY_POLICY_REQUIRED':'GPU_ISOLATION_UNVERIFIED'));
 assert.throws(()=>createTextAdapter('unused',{...options,maxGpuMemoryMb:1024}),new RegExp(windows||linux?'GPU_MEMORY_BELOW_MODEL_REQUIREMENT':'GPU_ISOLATION_UNVERIFIED'));
 if(linux)assert.doesNotThrow(()=>createTextAdapter('unused',{...options,modelId:'qwen3-8b',maxGpuMemoryMb:16384}));
 else assert.throws(()=>createTextAdapter('unused',{...options,modelId:'qwen3-8b',maxGpuMemoryMb:16384}),/GPU_ISOLATION_UNVERIFIED/);
 assert.throws(()=>createTextAdapter('unused',{...options,backend:'vulkan',maxGpuMemoryMb:6144}),/GPU_ISOLATION_UNVERIFIED/);
 // Validation does not launch hardware or claim that a configured machine passed.
 assert.doesNotThrow(()=>createTextAdapter('unused',{...options,backend:'cpu'}));
});


test('Windows controller admits only the pinned CUDA model with independent six GiB budgets', async()=>{
 const {validateWindowsControllerModelPolicy}=await import('../apps/worker/dist/windows-worker.js');
 const policy=parseWorkerPolicy({...DEFAULT_WORKER_POLICY,model:'qwen3-4b',backend:'cuda',maxMemoryMb:6144,maxGpuMemoryMb:6144});
 assert.doesNotThrow(()=>validateWindowsControllerModelPolicy(policy));
 for(const limit of ['maxMemoryMb','maxGpuMemoryMb'])for(const value of [1024,4096,6143]){
  assert.throws(()=>validateWindowsControllerModelPolicy({...policy,[limit]:value}),/CONTROLLER_GPU_MEMORY_BUDGET_REQUIRED/);
 }
 assert.throws(()=>validateWindowsControllerModelPolicy({...policy,maxGpuMemoryMb:32769}),/CONTROLLER_GPU_MEMORY_BUDGET_REQUIRED/);
 for(const changed of [{backend:'vulkan'},{model:'qwen3-8b'},{model:'qwen3-14b'},{model:'flux1-schnell'}]){
  assert.throws(()=>validateWindowsControllerModelPolicy({...policy,...changed}),/CONTROLLER_GPU_PROFILE_UNVERIFIED/);
 }
 assert.doesNotThrow(()=>validateWindowsControllerModelPolicy({...DEFAULT_WORKER_POLICY,backend:'cpu'}));
});
