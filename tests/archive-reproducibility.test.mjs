import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, utimes } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { archiveDirectory } from '../scripts/public-worker/archive.mjs';
import { scanSafeZip } from '../packages/adapters/dist/zip.js';
import { scanSafeTarGz } from '../packages/adapters/dist/tar.js';

test('ZIP and tar.gz ignore source directory, creation order and filesystem timestamps', async () => {
  await mkdir('.cache', { recursive: true }); const root = await mkdtemp(resolve('.cache/archive-repro-'));
  try {
    for (const name of ['a', 'b']) await mkdir(join(root, name, 'nested'), { recursive: true });
    for (const [folder, names] of [['a', ['one.txt', 'nested/two.txt']], ['b', ['nested/two.txt', 'one.txt']]])
      for (const name of names) { const path = join(root, folder, name); await writeFile(path, name); await utimes(path, folder === 'a' ? 1000 : 2000, folder === 'a' ? 1000 : 2000); }
    for (const platform of ['win32-x64', 'linux-x64']) {
      await archiveDirectory(join(root, 'a'), 'excess-worker-0.1.0', join(root, 'a.archive'), platform, 1791190800);
      await archiveDirectory(join(root, 'b'), 'excess-worker-0.1.0', join(root, 'b.archive'), platform, 1791190800);
      const bytes = await readFile(join(root, 'a.archive')); assert.deepEqual(bytes, await readFile(join(root, 'b.archive')));
      const entries = []; const limits = { maxInputBytes: 1024*1024, maxTotalBytes: 1024*1024, maxEntryBytes: 1024*1024 };
      (platform === 'win32-x64' ? scanSafeZip : scanSafeTarGz)(bytes, limits, entry => entries.push(entry));
      assert.equal(entries.length, 2);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
