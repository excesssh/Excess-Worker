import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LINUX_GPU_PROFILE, readLinuxGpuSandbox, requiresLinuxGpuSandbox } from '../scripts/public-worker/linux-gpu-package.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('v0.2 Linux packaging requires the exact scanned CUDA helper and integrity pin', async () => {
  assert.equal(requiresLinuxGpuSandbox('0.1.9'), false);
  assert.equal(requiresLinuxGpuSandbox('0.2.0'), true);
  assert.equal(requiresLinuxGpuSandbox('0.2.0-rc.1'), true);
  assert.equal(requiresLinuxGpuSandbox('1.0.0'), true);
  const scratchRoot = resolve(process.env.EXCESS_TEST_ROOT ?? '.cache');
  await mkdir(scratchRoot, { recursive: true });
  const root = await mkdtemp(join(scratchRoot, 'linux-gpu-package-'));
  const helper = Buffer.from('inert Linux GPU helper fixture');
  const native = join(root, 'native');
  try {
    await mkdir(native);
    await writeFile(join(native, 'excess-gpu-sandbox'), helper);
    await writeFile(join(native, 'integrity-gpu.json'), JSON.stringify({ profile: LINUX_GPU_PROFILE, sha256: digest(helper) }) + '\n');
    const packageInput = await readLinuxGpuSandbox(native);
    assert.deepEqual(packageInput, {
      helper,
      pinBytes: Buffer.from(JSON.stringify({ profile: LINUX_GPU_PROFILE, sha256: digest(helper) }) + '\n'),
      profile: LINUX_GPU_PROFILE,
      sha256: digest(helper),
    });

    await writeFile(join(native, 'integrity-gpu.json'), JSON.stringify({ profile: LINUX_GPU_PROFILE, sha256: 'f'.repeat(64) }));
    await assert.rejects(readLinuxGpuSandbox(native), /GPU_SANDBOX_INTEGRITY_INVALID/);
    await writeFile(join(native, 'integrity-gpu.json'), JSON.stringify({ profile: LINUX_GPU_PROFILE, sha256: digest(helper), extra: true }));
    await assert.rejects(readLinuxGpuSandbox(native), /GPU_SANDBOX_INTEGRITY_INVALID/);
    await rm(join(native, 'excess-gpu-sandbox'));
    await assert.rejects(readLinuxGpuSandbox(native), /GPU_SANDBOX_BUILD_REQUIRED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
