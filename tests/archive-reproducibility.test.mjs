import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, utimes } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { archiveDirectory } from '../scripts/public-worker/archive.mjs';
import { scanSafeZip } from '../packages/adapters/dist/zip.js';
import { scanSafeTarGz } from '../packages/adapters/dist/tar.js';

test('ZIP and tar.gz ignore source directory, creation order and filesystem timestamps', async () => {
  const scratchRoot = resolve(process.env.EXCESS_TEST_ROOT ?? '.cache');
  await mkdir(scratchRoot, { recursive: true }); const root = await mkdtemp(join(scratchRoot, 'archive-repro-'));
  try {
    for (const name of ['a', 'b']) await mkdir(join(root, name, 'nested'), { recursive: true });
    for (const [folder, names] of [['a', ['one.txt', 'nested/two.txt']], ['b', ['nested/two.txt', 'one.txt']]])
      for (const name of names) { const path = join(root, folder, name); await writeFile(path, name); await utimes(path, folder === 'a' ? 1000 : 2000, folder === 'a' ? 1000 : 2000); }
    const gpuHelper = 'app/node_modules/@excess/adapters/native/excess-gpu-sandbox';
    for (const folder of ['a', 'b']) {
      const path = join(root, folder, ...gpuHelper.split('/'));
      await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, 'inert gpu helper bytes');
    }
    for (const platform of ['win32-x64', 'linux-x64']) {
      await archiveDirectory(join(root, 'a'), 'excess-worker-0.1.0', join(root, 'a.archive'), platform, 1791190800);
      await archiveDirectory(join(root, 'b'), 'excess-worker-0.1.0', join(root, 'b.archive'), platform, 1791190800);
      const bytes = await readFile(join(root, 'a.archive')); assert.deepEqual(bytes, await readFile(join(root, 'b.archive')));
      const entries = []; const limits = { maxInputBytes: 1024*1024, maxTotalBytes: 1024*1024, maxEntryBytes: 1024*1024, allowExcessWorkerScope: true };
      (platform === 'win32-x64' ? scanSafeZip : scanSafeTarGz)(bytes, limits, entry => entries.push(entry));
       assert.equal(entries.length, 3);
       if (platform === 'linux-x64') {
         const tar = gunzipSync(bytes); let offset = 0, helperMode;
         while (offset + 512 <= tar.length && tar.subarray(offset, offset + 512).some(byte => byte !== 0)) {
           const header = tar.subarray(offset, offset + 512), leaf = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
           const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
           const name = prefix ? prefix + '/' + leaf : leaf;
           const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(), 8);
           if (name === 'excess-worker-0.1.0/' + gpuHelper) helperMode = parseInt(header.subarray(100, 108).toString('ascii').trim(), 8);
           offset += 512 + Math.ceil(size / 512) * 512;
         }
         assert.equal(helperMode, 0o755, 'Linux CUDA helper is executable in the reproducible tar archive');
       }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
