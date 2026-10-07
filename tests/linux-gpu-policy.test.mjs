import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_CATALOG, MEDIA_CATALOG } from '../packages/adapters/dist/index.js';
import { DEFAULT_WORKER_POLICY, parseWorkerPolicy } from '../apps/worker/dist/policy.js';
import { validateLinuxControllerModelPolicy } from '../apps/worker/dist/controller.js';
import { validateControllerBudget } from '../apps/worker/dist/controller-budget.js';
import { userUnit } from '../apps/worker/dist/service.js';

test('Linux CUDA admission covers each local task and refuses insufficient independent budgets', () => {
  for (const entry of [...MODEL_CATALOG, ...MEDIA_CATALOG]) {
    const policy = parseWorkerPolicy({ ...DEFAULT_WORKER_POLICY, model: entry.id, backend: 'cuda',
      maxMemoryMb: entry.minMemoryMb, maxGpuMemoryMb: entry.minVramMb });
    assert.doesNotThrow(() => validateLinuxControllerModelPolicy(policy));
    assert.throws(() => validateLinuxControllerModelPolicy({ ...policy, maxGpuMemoryMb: entry.minVramMb-1 }), /GPU_MEMORY_BUDGET_REQUIRED/);
    assert.throws(() => validateLinuxControllerModelPolicy({ ...policy, maxMemoryMb: entry.minMemoryMb-1 }), /GPU_MEMORY_BUDGET_REQUIRED/);
    assert.throws(() => validateLinuxControllerModelPolicy({ ...policy, backend: 'vulkan' }), /GPU_PROFILE_UNVERIFIED/);
  }
  assert.throws(() => validateLinuxControllerModelPolicy({ ...DEFAULT_WORKER_POLICY, backend: 'cuda', maxMemoryMb: 129025 }), /GPU_MEMORY_BUDGET_REQUIRED/);
});

test('large GPU models retain a finite hard cgroup with no swap, bounded tasks and CPU', () => {
  const gib = 1024n**3n, limits = { maximumMemoryBytes: 128n*gib, minimumMemoryBytes: 64n*gib };
  assert.doesNotThrow(() => validateControllerBudget(String(64n*gib), '0', '128', '200000 100000', limits));
  for (const [memory, swap, tasks, cpu] of [
    [String(63n*gib), '0', '128', '200000 100000'], [String(129n*gib), '0', '128', '200000 100000'],
    ['max', '0', '128', '200000 100000'], [String(64n*gib), '1', '128', '200000 100000'],
    [String(64n*gib), '0', '129', '200000 100000'], [String(64n*gib), '0', '128', '200001 100000'],
  ]) assert.throws(() => validateControllerBudget(memory, swap, tasks, cpu, limits), /RESOURCE_BOUNDARY_REQUIRED/);
  // Existing CPU admission retains its original ceiling.
  assert.throws(() => validateControllerBudget(String(13n*gib), '0', '128', '200000 100000'), /RESOURCE_BOUNDARY_REQUIRED/);
  assert.throws(() => userUnit('/opt/excess-worker', { backend: 'cuda', maxMemoryMb: 129025 }), /GPU_MEMORY_BUDGET_REQUIRED/);
});
