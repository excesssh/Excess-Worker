import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { MODEL_CATALOG, MEDIA_CATALOG, HOSTED_CATALOG } from '../packages/adapters/dist/index.js';

test('fresh CLI inventory retains every local task and licence without treating fit or installation as execution', async () => {
  const parent = resolve('.cache'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'catalogue-inventory-'));
  const run = (...args) => spawnSync(process.execPath, [resolve('apps/worker/dist/main.js'), ...args], {
    env: { ...process.env, EXCESS_WORKER_HOME: join(root, 'state'), EXCESS_MODEL_DIR: join(root, 'ai') },
    encoding: 'utf8', timeout: 30000,
  });
  try {
    const result = run('models'); assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout), expected = [...MODEL_CATALOG, ...MEDIA_CATALOG];
    assert.deepEqual(data.models.map(row => row.id).sort(), expected.map(row => row.id).sort());
    assert.deepEqual([...new Set(data.models.map(row => row.kind))].sort(), ['embedding', 'image', 'text', 'transcription']);
    for (const entry of expected) {
      const row = data.models.find(item => item.id === entry.id);
      assert.equal(row.licence, entry.info.licence);
      assert.equal(row.installed, false);
      assert.equal(row.executionEvidence, 'not established by catalogue inventory');
      assert.equal(row.cpu.needsMemoryMb, entry.minMemoryMb);
      assert.equal(row.gpu.needsGpuMemoryMb, entry.minVramMb);
    }
    const hosted = run('use', HOSTED_CATALOG[0].id);
    assert.notEqual(hosted.status, 0, 'hosted-provider IDs cannot become local worker models');
  } finally { await rm(root, { recursive: true, force: true }); }
});
