import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const buildScript = path.join(root, 'scripts', 'public-worker', 'build-windows-sandbox.ps1');
const runId = randomUUID().replaceAll('-', '');
const outputBase = 'C:\\ExcessBuilds\\tools\\excess-sandbox-runs';
const runRoot = path.join(outputBase, runId);
const runtimeRoot = path.join(runRoot, 'runtime');
const helper = path.join(runtimeRoot, 'ExcessSandbox.exe');
const sourceCopy = path.join(runtimeRoot, 'ExcessSandbox.cs');
const scratch = path.join(runRoot, 'scratch');
const unselectedFile = path.join(runtimeRoot, 'unselected.dat');
const modelParent = process.env.LOCALAPPDATA ?? (process.platform === 'win32' ? '' : 'C:\\ExcessBuilds\\tools');
if (process.platform === 'win32') assert.ok(modelParent, 'a per-user local application data directory is required for the exact-file ACL probe');
const modelRoot = path.join(modelParent, `excess-sandbox-probe-${runId}`);
const selectedModel = path.join(modelRoot, 'selected.bin');
const unselectedModel = path.join(modelRoot, 'unselected.bin');
const profileRoot = path.dirname(modelParent);

function ancestors(target) {
  const values = [];
  let current = path.resolve(target);
  while (path.dirname(current) !== current) {
    values.push(current);
    current = path.dirname(current);
  }
  return values;
}

function buildHelper() {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-File', buildScript], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    env: { ...process.env, EXCESS_SANDBOX_OUTPUT_ROOT: runtimeRoot },
  });
  assert.equal(result.error, undefined, 'PowerShell should start the sandbox build');
  assert.equal(result.status, 0, 'sandbox helper should compile');
  assert.match(result.stdout, /status=build-ok/);
  assert.equal(existsSync(helper), true);
}

function getAclSnapshot(targets) {
  const targetList = targets.map((target) => `'${target.replaceAll("'", "''")}'`).join(',');
  const command = `$targets=@(${targetList}); foreach($target in $targets){$acl=Get-Acl -LiteralPath $target; [Console]::WriteLine($acl.Sddl)}`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, 'ACL snapshot should be readable');
  return result.stdout.trim().split(/\r?\n/).map((sddl) => {
    const aces = sddl.match(/\([^)]*\)/g) || [];
    return aces.length + ':' + aces.sort().join('|');
  });
}

function protectScratchRoot(directory) {
  const literal = `'${directory.replaceAll("'", "''")}'`;
  const command = `$path=${literal}; $acl=Get-Acl -LiteralPath $path; $acl.SetAccessRuleProtection($true,$false); $user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl.SetOwner($user); foreach($sid in @($user,'S-1-5-18','S-1-5-32-544')){$identity=New-Object System.Security.Principal.SecurityIdentifier($sid); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.SetAccessRule($rule)}; Set-Acl -LiteralPath $path -AclObject $acl`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
    encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  assert.equal(result.status, 0, 'private scratch fixture ACL should be set');
}

function launchSandbox(config) {
  const child = spawn(helper, [], {
    cwd: root,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: {
      ...process.env,
      EXCESS_SANDBOX_SENTINEL: 'private-probe-value',
      LLAMA_API_KEY: 'probe-runtime-key-123456',
      OMP_NUM_THREADS: '4',
    },
  });
  let stdout = '';
  const waiters = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    for (let index = waiters.length - 1; index >= 0; index--) {
      if (waiters[index].predicate(stdout)) {
        clearTimeout(waiters[index].timer);
        waiters[index].resolve(stdout);
        waiters.splice(index, 1);
      }
    }
  });
  const done = new Promise((resolve) => {
    child.once('error', (error) => resolve({ error, stdout }));
    child.once('close', (code, signal) => resolve({ code, signal, stdout }));
  });
  child.stdin.write(JSON.stringify(config) + '\n');
  return {
    child,
    done,
    stop() {
      child.stdin.write('{"type":"stop"}\n');
      child.stdin.end();
    },
    send(message) { child.stdin.write(JSON.stringify(message) + '\n'); },
    endInput() { child.stdin.end(); },
    output() { return stdout; },
    waitFor(predicate, timeout = 10000) {
      if (predicate(stdout)) return Promise.resolve(stdout);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('sandbox status wait timed out'));
        }, timeout);
        waiters.push(waiter);
      });
    },
  };
}

function parseEvents(output) {
  return output.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForRpcEvent(launcher, type, id, timeout = 10000) {
  await launcher.waitFor((output) => {
    try { return parseEvents(output).some((event) => event.type === type && event.id === id); }
    catch { return false; }
  }, timeout);
  return parseEvents(launcher.output()).find((event) => event.type === type && event.id === id);
}

async function unlinkFixture(file) {
  if (!existsSync(file)) return;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { unlinkSync(file); return; }
    catch (error) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code) || attempt === 29)
        throw new Error('known sandbox fixture file cleanup failed');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function rmdirFixture(directory) {
  if (!existsSync(directory)) return;
  if (readdirSync(directory).length !== 0) throw new Error('known sandbox fixture directory was not empty');
  try { rmdirSync(directory); }
  catch { throw new Error('known sandbox fixture directory cleanup failed'); }
}

function connectAndRead(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let data = '';
    let didConnect = false;
    const timer = setTimeout(() => socket.destroy(), 1000);
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { data += chunk; });
    socket.once('connect', () => { didConnect = true; });
    socket.once('end', () => { clearTimeout(timer); resolve({ connected: didConnect, data, error: didConnect ? undefined : 'closed-before-connect' }); });
    socket.once('error', (error) => { clearTimeout(timer); resolve({ connected: false, error: error.code ?? 'unknown' }); });
    socket.once('close', () => {
      if (didConnect) { clearTimeout(timer); resolve({ connected: true, data }); }
    });
  });
}

async function connectDuringLaunch(port, done) {
  const deadline = Date.now() + 3500;
  let lastError = 'no-attempt';
  while (Date.now() < deadline) {
    const attempt = await Promise.race([
      connectAndRead(port),
      done.then((result) => ({ launcherClosed: result })),
    ]);
    if ('launcherClosed' in attempt) return { connected: false, error: lastError, launcher: attempt.launcherClosed };
    if (attempt.connected) return attempt;
    lastError = attempt.error;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { connected: false, error: lastError };
}

test('Windows sandbox denies an outside-process loopback TCP connection without network capability', {
  skip: process.platform !== 'win32',
}, async () => {
  buildHelper();
  mkdirSync(scratch, { recursive: true });
  protectScratchRoot(scratch);
  mkdirSync(modelRoot, { recursive: true });
  writeFileSync(unselectedFile, 'not in runtime manifest');
  writeFileSync(selectedModel, 'approved model fixture');
  writeFileSync(unselectedModel, 'unselected model fixture');
  const aclTargets = [
    outputBase,
    runRoot,
    runtimeRoot,
    scratch,
    helper,
    sourceCopy,
    modelRoot,
    selectedModel,
    unselectedModel,
    profileRoot,
    ...ancestors(runtimeRoot),
    ...ancestors(modelRoot),
    ...ancestors(scratch),
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
      modelFiles: [{
        path: selectedModel,
        sha256: createHash('sha256').update(readFileSync(selectedModel)).digest('hex'),
      }],
      arguments: ['--probe-connect', '127.0.0.1', String(port), runtimeRoot, unselectedFile, selectedModel, unselectedModel, profileRoot],
      memoryLimitBytes: 512 * 1024 * 1024,
      processLimit: 1,
      timeoutMilliseconds: 15000,
    };
    const contained = launchSandbox(config);
    const child = await contained.done;
    assert.equal(child.error, undefined, 'sandbox launcher should finish');
    const childEvents = parseEvents(child.stdout);
    assert.ok(childEvents.some((event) => event.type === 'started' && Number.isInteger(event.pid)));
    const childStatus = childEvents.find((event) => event.type === 'status');
    assert.ok(childStatus);
    assert.ok(childEvents.some((event) => event.type === 'cleanup' && event.ok === true));
    assert.equal(typeof childStatus.peakWorkingSetBytes, 'number');
    assert.equal(typeof childStatus.peakJobCommitBytes, 'number');
    const exit = childStatus.exitCode;
    assert.ok(exit === 42 || exit === 43, `expected AppContainer loopback denial, observed status code ${exit}`);
    console.log(`windows-contained-client-loopback=denied; code=${exit}`);
    assert.deepEqual(readdirSync(scratch).sort(), scratchEntriesBefore, 'private per-run scratch should be removed');

    const portReservation = net.createServer();
    await new Promise((resolve, reject) => {
      portReservation.once('error', reject);
      portReservation.listen(0, '127.0.0.1', resolve);
    });
    const inversePort = portReservation.address().port;
    await new Promise((resolve) => portReservation.close(resolve));
    const inverseConfig = {
      ...config,
      arguments: ['--probe-listen', String(inversePort)],
      timeoutMilliseconds: 5000,
    };
    const inverse = launchSandbox(inverseConfig);
    const outside = await connectDuringLaunch(inversePort, inverse.done);
    const inverseResult = outside.launcher ?? await inverse.done;
    assert.equal(inverseResult.error, undefined, 'inverse-direction launcher should start');
    const inverseEvents = parseEvents(inverseResult.stdout);
    assert.ok(inverseEvents.some((event) => event.type === 'started' && Number.isInteger(event.pid)));
    const inverseStatus = inverseEvents.find((event) => event.type === 'status');
    assert.ok(inverseStatus);
    assert.ok(inverseEvents.some((event) => event.type === 'cleanup' && event.ok === true));
    const listenCode = inverseStatus.exitCode;
    if (outside.connected) {
      assert.equal(listenCode, 0, 'contained listener should complete after parent connects');
      assert.equal(outside.data, 'contained\n');
      console.log('windows-inverse-loopback=parent-connected; contained-listen-code=0');
    } else {
      assert.notEqual(listenCode, 0, 'a denied listener must report a socket or bounded-accept error');
      assert.notEqual(listenCode, 124, 'the probe must finish inside its own bounded accept window');
      console.log(`windows-inverse-loopback=parent-${outside.error}; contained-listen-code=${listenCode}`);
    }
    assert.deepEqual(readdirSync(scratch).sort(), scratchEntriesBefore, 'inverse-direction scratch should be removed');

    const intraConfig = {
      ...config,
      arguments: ['--probe-intra-loopback', String(inversePort)],
      processLimit: 2,
      timeoutMilliseconds: 10000,
    };
    const intra = launchSandbox(intraConfig);
    const intraResult = await intra.done;
    assert.equal(intraResult.error, undefined, 'same-container relay probe should finish');
    const intraEvents = parseEvents(intraResult.stdout);
    assert.ok(intraEvents.some((event) => event.type === 'started' && Number.isInteger(event.pid)));
    const intraStatus = intraEvents.find((event) => event.type === 'status');
    assert.ok(intraStatus);
    assert.equal(intraStatus.termination, 'exit');
    assert.ok(intraEvents.some((event) => event.type === 'cleanup' && event.ok === true));
    assert.ok(intraStatus.exitCode < 30000, `contained descendant launch failed with probe code ${intraStatus.exitCode}`);
    if (intraStatus.exitCode === 0) {
      console.log('windows-intra-loopback=allowed; contained-processes=2; job-process-limit=2');
    } else if (intraStatus.exitCode >= 20000 && intraStatus.exitCode < 30000) {
      console.log(`windows-intra-loopback=denied; contained-client-winsock=${intraStatus.exitCode - 20000}; listener-active=true`);
    } else {
      console.log(`windows-intra-loopback=server-exit; contained-listener-code=${intraStatus.exitCode - 10000}`);
    }
    assert.deepEqual(readdirSync(scratch).sort(), scratchEntriesBefore, 'same-container probe scratch should be removed');

    const relayPortReservation = net.createServer();
    await new Promise((resolve, reject) => {
      relayPortReservation.once('error', reject);
      relayPortReservation.listen(0, '127.0.0.1', resolve);
    });
    const relayPort = relayPortReservation.address().port;
    await new Promise((resolve) => relayPortReservation.close(resolve));
    const relayConfig = {
      ...config,
      arguments: ['--probe-http-server', String(relayPort)],
      relayFile: { path: helper, sha256: config.runtimeFiles[0].sha256 },
      runtimePort: relayPort,
      processLimit: 2,
      timeoutMilliseconds: 12000,
    };
    const relay = launchSandbox(relayConfig);
    await relay.waitFor((output) => output.includes('"type":"started"'));
    relay.send({ type: 'request', id: 31, method: 'POST', path: '/completion', body: '{"prompt":"probe"}' });
    let response;
    await relay.waitFor((output) => {
      try { return parseEvents(output).some((event) => (event.type === 'response' || event.type === 'error') && event.id === 31 || event.type === 'status'); }
      catch { return false; }
    });
    const relayOutputEvents = parseEvents(relay.output());
    response = relayOutputEvents.find((event) => event.type === 'response' && event.id === 31);
    if (!response) assert.fail('relay ended without response: ' + relayOutputEvents.map((event) => `${event.type}:${event.error ?? event.termination ?? ''}/${event.exitCode ?? ''}/${event.stopReason ?? ''}`).join(','));
    assert.equal(response.status, 200);
    assert.equal(response.headers?.['content-type'], 'text/event-stream');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(parseEvents(relay.output()).some((event) => event.type === 'data' && event.id === 31), false,
      'relay must wait for a pull before reading response data');
    relay.send({ type: 'next', id: 31 });
    const data = await waitForRpcEvent(relay, 'data', 31);
    assert.equal(Buffer.from(data.data, 'base64').toString('utf8'), 'data: {"ok":true}\n\n');
    relay.send({ type: 'next', id: 31 });
    await waitForRpcEvent(relay, 'end', 31);
    relay.stop();
    const relayResult = await relay.done;
    assert.equal(relayResult.error, undefined, 'relay stop should finish normally');
    const relayEvents = parseEvents(relayResult.stdout);
    assert.equal(relayEvents.find((event) => event.type === 'status')?.termination, 'stop');
    assert.ok(relayEvents.some((event) => event.type === 'cleanup' && event.ok === true));
    console.log('windows-contained-http-pull-relay=passed; auth=allowlisted; process-limit=2');
    assert.deepEqual(readdirSync(scratch).sort(), scratchEntriesBefore, 'relay scratch should be removed');

    const boundedConfig = {
      ...config,
      arguments: ['--probe-hang'],
      timeoutMilliseconds: 500,
    };
    const boundedRun = launchSandbox(boundedConfig);
    const bounded = await boundedRun.done;
    assert.equal(bounded.error, undefined, 'bounded launcher should finish and clean up');
    const boundedEvents = parseEvents(bounded.stdout);
    assert.ok(boundedEvents.some((event) => event.type === 'started' && Number.isInteger(event.pid)));
    const boundedStatus = boundedEvents.find((event) => event.type === 'status');
    assert.equal(boundedStatus?.termination, 'timeout');
    assert.equal(boundedStatus?.exitCode, 124);
    assert.ok(boundedEvents.some((event) => event.type === 'cleanup' && event.ok === true));
    console.log('windows-timeout-cleanup=ok; peak-working-set-reported=' + Number.isInteger(boundedStatus.peakWorkingSetBytes));

    const stopRun = launchSandbox({ ...config, arguments: ['--probe-hang'], timeoutMilliseconds: 10000 });
    await stopRun.waitFor((output) => output.includes('"type":"started"'));
    stopRun.stop();
    const stopResult = await stopRun.done;
    assert.equal(stopResult.error, undefined, 'graceful stop control should finish');
    const stopEvents = parseEvents(stopResult.stdout);
    const stopStatus = stopEvents.find((event) => event.type === 'status');
    assert.equal(stopStatus?.termination, 'stop');
    assert.equal(stopStatus?.exitCode, 125);
    assert.ok(stopEvents.some((event) => event.type === 'cleanup' && event.ok === true));
    console.log('windows-stop-command-cleanup=ok');
    const aclAfter = getAclSnapshot(aclTargets);
    assert.equal(aclAfter.every((value, index) => value === aclBefore[index]), true,
      'all temporary ACL grants should be restored');
    console.log('windows-acl-restore=matched');
    assert.deepEqual(readdirSync(scratch).sort(), scratchEntriesBefore, 'bounded-run scratch should be removed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await unlinkFixture(unselectedFile);
    await unlinkFixture(selectedModel);
    await unlinkFixture(unselectedModel);
    await rmdirFixture(modelRoot);
    await unlinkFixture(helper);
    await unlinkFixture(sourceCopy);
    await rmdirFixture(runtimeRoot);
    await rmdirFixture(scratch);
    await rmdirFixture(runRoot);
  }
});
