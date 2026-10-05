import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const buildScript = path.join(root, 'scripts', 'public-worker', 'build-windows-sandbox.ps1');
const helper = 'C:\\ExcessBuilds\\tools\\excess-sandbox\\ExcessSandbox.exe';
const scratch = 'C:\\ExcessBuilds\\tools\\excess-sandbox\\scratch';
const unselectedFile = 'C:\\ExcessBuilds\\tools\\excess-sandbox\\unselected.dat';
const modelParent = 'C:\\ExcessBuilds\\models';
const modelRoot = 'C:\\ExcessBuilds\\models\\sandbox-probe';
const selectedModel = 'C:\\ExcessBuilds\\models\\sandbox-probe\\selected.bin';
const unselectedModel = 'C:\\ExcessBuilds\\models\\sandbox-probe\\unselected.bin';

function buildHelper() {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-File', buildScript], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, 'PowerShell should start the sandbox build');
  assert.equal(result.status, 0, 'sandbox helper should compile');
  assert.match(result.stdout, /status=build-ok/);
  assert.equal(existsSync(helper), true);
}

function getAclSnapshot(targets) {
  return targets.map((target) => {
    const command = `(Get-Acl -LiteralPath '${target}').Sddl`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    assert.equal(result.status, 0, 'ACL snapshot should be readable');
    const aces = result.stdout.trim().match(/\([^)]*\)/g) || [];
    return aces.length + ':' + aces.sort().join('|');
  });
}

test('Windows sandbox denies an outside-process loopback TCP connection without network capability', {
  skip: process.platform !== 'win32',
}, async () => {
  buildHelper();
  mkdirSync(scratch, { recursive: true });
  mkdirSync(modelRoot, { recursive: true });
  writeFileSync(unselectedFile, 'not in runtime manifest');
  writeFileSync(selectedModel, 'approved model fixture');
  writeFileSync(unselectedModel, 'unselected model fixture');
  const runtimeRoot = path.dirname(helper);
  const aclTargets = [
    'C:\\ExcessBuilds',
    'C:\\ExcessBuilds\\tools',
    runtimeRoot,
    scratch,
    helper,
    modelParent,
    modelRoot,
    selectedModel,
    unselectedModel,
  ];
  const aclBefore = getAclSnapshot(aclTargets);
  const scratchEntriesBefore = readdirSync(scratch).sort();

  const server = net.createServer((socket) => socket.end('outside\n'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const port = server.address().port;
    const config = {
      executable: helper,
      runtimeRoot,
      runtimeFiles: [{
        path: helper,
        sha256: createHash('sha256').update(readFileSync(helper)).digest('hex'),
      }],
      scratchDirectory: scratch,
      modelFiles: [selectedModel],
      arguments: ['--probe-connect', '127.0.0.1', String(port), runtimeRoot, unselectedFile, selectedModel, unselectedModel],
      memoryLimitBytes: 512 * 1024 * 1024,
      processLimit: 1,
    };
    const child = spawnSync(helper, [], {
      cwd: root,
      input: JSON.stringify(config),
      encoding: 'utf8',
      timeout: 45000,
      windowsHide: true,
      env: { ...process.env, EXCESS_SANDBOX_SENTINEL: 'private-probe-value' },
    });
    assert.equal(child.error, undefined, 'sandbox launcher should finish');
    assert.match(child.stdout, /status=started pid=\d+/);
    assert.match(child.stdout, /status=exited pid=\d+ code=\d+/);
    assert.match(child.stdout, /status=cleanup-ok/);
    const exit = Number(child.stdout.match(/code=(\d+)/)[1]);
    assert.ok(exit === 42 || exit === 43, `expected AppContainer loopback denial, observed status code ${exit}`);
    const aclAfter = getAclSnapshot(aclTargets);
    assert.equal(aclAfter.every((value, index) => value === aclBefore[index]), true,
      'all temporary ACL grants should be restored');
    assert.deepEqual(readdirSync(scratch).sort(), scratchEntriesBefore, 'private per-run scratch should be removed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (existsSync(unselectedFile)) unlinkSync(unselectedFile);
    if (existsSync(selectedModel)) unlinkSync(selectedModel);
    if (existsSync(unselectedModel)) unlinkSync(unselectedModel);
    if (existsSync(modelRoot)) rmdirSync(modelRoot);
    if (existsSync(modelParent) && readdirSync(modelParent).length === 0) rmdirSync(modelParent);
  }
});
