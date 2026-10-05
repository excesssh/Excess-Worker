import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// A small C fixture establishes kernel denials; it is not model/hardware execution evidence.
test('Linux kernel denies host files, read-only writes, outbound TCP, UDP, forks and excess allocation', { skip: process.platform !== 'linux' }, async () => {
  await mkdir('.cache', { recursive: true });
  const root = await mkdtemp(resolve('.cache/linux-isolation-'));
  try {
    const scratch = join(root, 'scratch'); await mkdir(scratch);
    const allow = join(root, 'model-fixture.txt'), deny = join(root, 'credential-fixture.txt');
    await writeFile(allow, 'public fixture'); await writeFile(deny, 'private fixture');
    const helper = join(root, 'excess-sandbox'), probe = join(root, 'isolation-probe'), modelProbe = join(root, 'model-fd-probe');
    execFileSync('gcc', ['-O2', '-s', 'native/linux/excess-sandbox.c', '-o', helper], { stdio: 'pipe' });
    execFileSync('gcc', ['-O2', '-pthread', 'tests/fixtures/isolation-probe.c', '-o', probe], { stdio: 'pipe' });
    execFileSync('gcc', ['-O2', 'tests/fixtures/isolation-model-fd-probe.c', '-o', modelProbe], { stdio: 'pipe' });
    assert.equal(execFileSync(helper, ['--check'], { encoding: 'utf8' }).trim(), 'linux-landlock-v1');
    const result = execFileSync(helper, [String(256*1024*1024), '10', '54321', scratch, '1', allow, '0', '--', probe, allow, deny], { encoding: 'utf8' });
    assert.match(result, /fixture isolation checks passed/);
    const selectedScratch = join(root, 'selected-scratch'); await mkdir(selectedScratch);
    const selectedResult = execFileSync(helper, [String(256*1024*1024), '10', '54322', selectedScratch, '0', '1', allow, '--', modelProbe, allow, deny], { encoding: 'utf8' });
    assert.match(selectedResult, /selected read-only model handle accessible; unselected file denied/);
  } finally { assert.ok(root.startsWith(resolve('.cache') + '/linux-isolation-')); await rm(root, { recursive: true, force: true }); }
});
