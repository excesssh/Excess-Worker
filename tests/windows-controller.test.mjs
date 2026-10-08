import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, unlink, rmdir, writeFile } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPublicBytes } from '../scripts/public-worker/privacy.mjs';
import { startWindowsControllerTestFixture } from '../apps/worker/dist/windows-controller.js';

const configuredNeutralRoot = process.env.EXCESS_WINDOWS_CONTROLLER_TEST_ROOT ?? '';
const configuredToolchain = process.env.EXCESS_WINDOWS_CONTROLLER_TOOLCHAIN ?? '';
if (configuredNeutralRoot) assertPublicBytes(Buffer.from(configuredNeutralRoot));
if (configuredToolchain) assertPublicBytes(Buffer.from(configuredToolchain));
const neutralRoot = configuredNeutralRoot ? path.resolve(configuredNeutralRoot) : '';
const toolchain = configuredToolchain ? path.resolve(configuredToolchain) : '';
if (neutralRoot) assertPublicBytes(Buffer.from(neutralRoot));
if (toolchain) assertPublicBytes(Buffer.from(toolchain));
const expectedNodeSha256 = process.env.EXCESS_WINDOWS_CONTROLLER_TEST_NODE_SHA256 ?? '';
function isWithin(base, target) { const rel = path.relative(path.resolve(base), path.resolve(target)); return !rel || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)); }
const systemRoot = process.env.SystemRoot ?? 'C:/Windows';
const neutralRootSafe = Boolean(neutralRoot) && !isWithin(homedir(), neutralRoot) && !isWithin(systemRoot, neutralRoot);
const nativeFixtureReady = process.platform === 'win32' && process.arch === 'x64' && process.version === 'v24.11.1' &&
  Boolean(toolchain && expectedNodeSha256) && /^[0-9a-f]{64}$/.test(expectedNodeSha256) && neutralRootSafe &&
  existsSync(path.join(toolchain, 'inputs.json')) && existsSync(path.join(neutralRoot, 'runtime', 'node.exe')) &&
  existsSync(path.join(neutralRoot, 'sibling', 'ungranted.txt'));
const testRoot = path.dirname(fileURLToPath(import.meta.url));
const buildScript = path.join(testRoot, '..', 'scripts', 'public-worker', 'build-windows-controller.mjs');

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

test('production controller has no state mount and receives read-only scratch', async () => {
  const source = await readFile(path.join(testRoot, '..', 'native', 'windows', 'ExcessController.cs'), 'utf8');
  assert.match(source, /"entrySha256,mode,nodeSha256,origin,packageDir,packageInventorySha256,scratchRoot"/);
  assert.match(source, /if \(fixture\) \{ acl\.GrantDirectory\(StateDir, sid, FileSystemRights\.Traverse, false\); acl\.GrantFile\(statePath, sid, FileSystemRights\.Read\);/);
  assert.match(source, /GrantDirectory\(dir, sid, FileSystemRights\.Traverse \| FileSystemRights\.ReadAttributes, false\)/);
  assert.match(source, /acl\.GrantDirectory\(ScratchSession, sid, fixture \? FileSystemRights\.Modify : FileSystemRights\.ReadAndExecute, true\)/);
});

function powershell(script, env = {}) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 20000, windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, ...env },
  });
  if (result.status !== 0) throw Error('CONTROLLER_TEST_ACL_SETUP_FAILED');
  return result.stdout.trim().split(/\r?\n/).filter(Boolean);
}

function snapshotAcl(targets) {
  const result = powershell("$targets=ConvertFrom-Json -InputObject $env:EXCESS_CONTROLLER_TEST_TARGETS;foreach($p in $targets){[Console]::WriteLine((Get-Acl -LiteralPath $p).Sddl)}", {
    EXCESS_CONTROLLER_TEST_TARGETS: JSON.stringify(targets),
  });
  return result;
}

function controllerProfileCount() {
  const result = powershell("$p='HKCU:\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings';$n=0;foreach($k in Get-ChildItem -LiteralPath $p){$m=(Get-ItemProperty -LiteralPath $k.PSPath -ErrorAction SilentlyContinue).Moniker;if($m -like 'Excess.Worker.Controller.*'){$n++}};[Console]::WriteLine($n)");
  const count = Number(result[0]);
  if (!Number.isInteger(count) || count < 0) throw Error('CONTROLLER_TEST_PROFILE_CHECK_FAILED');
  return count;
}

function expectBuild(output) {
  const result = spawnSync(process.execPath, [buildScript, output, toolchain], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot },
  });
  if (result.status !== 0 || result.error) throw Error('CONTROLLER_TEST_BUILD_FAILED');
  const rows = result.stdout.trim().split(/\r?\n/);
  const summary = JSON.parse(rows[rows.length - 1]);
  if (summary.profile !== 'windows-appcontainer-controller-v1' || summary.privacy !== 'passed') throw Error('CONTROLLER_TEST_BUILD_FAILED');
  return summary;
}

async function prepare() {
  const writeOwnedFixture = async (file, source) => {
    try {
      const existing = await readFile(file, 'utf8');
      if (existing !== source) throw Error('CONTROLLER_UNEXPECTED_FIXTURE_RESIDUE');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await writeFile(file, source, { flag: 'wx' });
    }
  };
  const runtime = path.join(neutralRoot, 'runtime');
  const probeDir = path.join(runtime, 'modules');
  const probeFile = path.join(probeDir, 'probe.mjs');
  const dependencyFile = path.join(probeDir, 'dependency.mjs');
  const nodeModules = path.join(runtime, 'node_modules');
  const scopeDir = path.join(nodeModules, '@excess');
  const protocolDir = path.join(scopeDir, 'protocol');
  const protocolPackage = path.join(protocolDir, 'package.json');
  const protocolEntry = path.join(protocolDir, 'index.mjs');
  await mkdir(probeDir, { recursive: true });
  await mkdir(protocolDir, { recursive: true });
  const probeSource = `import { fixtureProbe } from './dependency.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = process.env.EXCESS_CONTROLLER_PACKAGE;
const target = fileURLToPath(import.meta.url);
const missing = path.join(root, 'modules', 'missing.mjs');
const steps = ['static-import:' + (fixtureProbe === 'ready' ? 'OK' : 'FAILED')];
const classify = error => ['EACCES', 'EPERM'].includes(error.code) ? 'DENIED' : error.code === 'ENOENT' ? 'MISSING' : 'FAILED';
const mark = (name, run) => { try { run(); steps.push(name + ':OK'); } catch (error) { steps.push(name + ':' + classify(error)); } };
mark('cwd', () => process.cwd());
mark('stat', () => fs.statSync(target));
mark('realpath', () => fs.realpathSync(target));
mark('open', () => { const fd = fs.openSync(target, 'r'); fs.closeSync(fd); });
mark('list', () => fs.readdirSync(path.dirname(target)));
mark('missing-stat', () => fs.statSync(missing));
mark('missing-open', () => { const fd = fs.openSync(missing, 'r'); fs.closeSync(fd); });
try { await import(pathToFileURL(missing).href); steps.push('missing-import:OK'); } catch (error) { steps.push('missing-import:' + (error.code === 'ERR_MODULE_NOT_FOUND' ? 'MISSING' : classify(error))); }
try { await import('@excess/protocol'); steps.push('package-import:OK'); } catch (error) { steps.push('package-import:' + classify(error)); }
try { await import(pathToFileURL(target).href); steps.push('import:OK'); } catch (error) { steps.push('import:' + classify(error)); }
process.stdout.write(JSON.stringify({ type: 'request', id: 1, op: 'adapter', payload: { text: steps.join(',') } }) + '\\n');
let buffer = '';
process.stdin.on('data', chunk => { buffer += chunk.toString(); const index = buffer.indexOf('\\n'); if (index < 0) return; const reply = JSON.parse(buffer.slice(0, index)); if (reply.type !== 'response' || reply.id !== 1 || reply.ok !== true || reply.payload !== 'probe-ack') process.exit(3); process.stdout.write(JSON.stringify({ type: 'done' }) + '\\n', () => process.exit(0)); });
`;
  try {
    const existing = await readFile(probeFile, 'utf8');
    const priorHash = digest(Buffer.from(existing, 'utf8'));
    if (!['0176d18110037b413bf0c06edcf301cf77a881aec70b7ade4004f830b87d052e', 'de68b68b07ca750e77b2c6f3411da6f0cb44b315cd8fb2aef971f44bfa30eec5', 'efee6306fce2bb45efc8ee6617396a780eb0027f84b0ff4d8ddf0aa63f8b9404', '9671c46879ef0e37caf017269a275fdf4d37397414d3eb50bf689156b85ff9df'].includes(priorHash) && existing !== "export const fixtureProbe = 'ready';\n") throw Error('CONTROLLER_UNEXPECTED_PROBE_RESIDUE');
    await writeFile(probeFile, probeSource);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await writeFile(probeFile, probeSource, { flag: 'wx' });
  }
  await writeOwnedFixture(dependencyFile, "export const fixtureProbe = 'ready';\n");
  await writeOwnedFixture(protocolPackage, '{"name":"@excess/protocol","type":"module","exports":"./index.mjs"}\n');
  await writeOwnedFixture(protocolEntry, "export const packageProbe = 'ready';\n");
  const sibling = path.join(neutralRoot, 'sibling', 'ungranted.txt');
  const nodePath = path.join(runtime, 'node.exe');
  const moduleRoot = path.join(neutralRoot, 'module-' + randomUUID().replaceAll('-', ''));
  const stateDir = path.join(moduleRoot, 'state');
  const scratchRoot = path.join(moduleRoot, 'scratch');
  const outputA = path.join(moduleRoot, 'build-a');
  const outputB = path.join(moduleRoot, 'build-b');
  await mkdir(moduleRoot, { recursive: false });
  for (const dir of [stateDir, scratchRoot, outputA, outputB]) await mkdir(dir, { recursive: false });
  const identity = path.join(stateDir, 'identity.json');
  await writeFile(identity, 'fixture-state', { flag: 'wx' });
  const helperA = path.join(outputA, 'ExcessController.exe');
  const helperB = path.join(outputB, 'ExcessController.exe');
  const first = expectBuild(outputA);
  const second = expectBuild(outputB);
  if (first.sha256 !== second.sha256 || first.sourceSha256 !== second.sourceSha256) throw Error('CONTROLLER_BUILD_NOT_DETERMINISTIC');
  const helperHash = digest(await readFile(helperA));
  if (helperHash !== first.sha256 || digest(await readFile(helperB)) !== helperHash) throw Error('CONTROLLER_BUILD_PIN_INVALID');
  const nodeHash = digest(await readFile(nodePath));
  if (nodeHash !== expectedNodeSha256) throw Error('CONTROLLER_TEST_NODE_PIN_MISMATCH');
  const nodeVersion = spawnSync(nodePath, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true, env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot } });
  if (nodeVersion.status !== 0 || nodeVersion.stdout.trim() !== 'v24.11.1') throw Error('CONTROLLER_TEST_NODE_VERSION_INVALID');
  const aclTargets = [runtime, nodePath, path.join(runtime, 'LICENSE'), probeDir, probeFile, dependencyFile, nodeModules, scopeDir, protocolDir, protocolPackage, protocolEntry, stateDir, identity, scratchRoot];
  const before = snapshotAcl(aclTargets);
  return { moduleRoot, runtime, probeDir, probeFile, dependencyFile, nodeModules, scopeDir, protocolDir, protocolPackage, protocolEntry, sibling, nodePath, nodeHash, stateDir, scratchRoot, outputA, outputB, helperA, helperHash, aclTargets, before, phases: [], runs: [] };
}

async function launch(fixture, scenario, handleRequest, extra = {}) {
  const run = await startWindowsControllerTestFixture({
    packageDir: fixture.runtime,
    stateDir: fixture.stateDir,
    origin: 'https://controller.invalid',
    handleRequest,
    helperPath: fixture.helperA,
    helperSha256: fixture.helperHash,
    nodePath: fixture.nodePath,
    nodeSha256: fixture.nodeHash,
    scratchRoot: fixture.scratchRoot,
    siblingPath: fixture.sibling,
    scenario,
    sessionTimeoutMs: 8000,
    onPhase: phase => {
      fixture.phases.push(phase);
      if (!phase.startsWith('request-accepted-') && !phase.startsWith('handler-resolved-') && !phase.startsWith('response-queued-')) {
        writeFileSync(path.join(fixture.moduleRoot, 'phases.txt'), fixture.phases.join('\n') + '\n');
      }
    },
    ...extra,
  });
  fixture.runs.push(run);
  return run;
}

async function boundedClose(run, fixture, timeoutMs = 12000) {
  let timer;
  const timed = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('CONTROLLER_TEST_DEADLINE')), timeoutMs); });
  try { return await Promise.race([run.closed, timed]); }
  catch {
    await run.stop().catch(() => undefined);
    throw Error('CONTROLLER_TEST_DID_NOT_CLOSE:' + fixture.phases.join(','));
  } finally { if (timer) clearTimeout(timer); }
}

async function assertClosed(run, expectedTermination) {
  const result = await run.closed;
  assert.equal(result.type, 'close');
  assert.equal(result.termination, expectedTermination);
  assert.equal(result.reaped, true);
  assert.equal(result.cleaned, true);
  assert.ok(Number.isInteger(result.pid) && result.pid > 0);
  assert.ok(Number.isInteger(result.peakInFlightRequests) && result.peakInFlightRequests >= 0 && result.peakInFlightRequests <= 4);
  assert.ok(Number.isInteger(result.peakInFlightBytes) && result.peakInFlightBytes >= 0 && result.peakInFlightBytes <= 4 * 1024 * 1024);
  return result;
}

async function waitForCount(values, count) {
  const deadline = Date.now() + 5000;
  while (values.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(values.length, count);
}

test('Windows controller is a bounded, fail-closed host RPC boundary', {
  skip: !nativeFixtureReady ? 'Windows x64 Node 24.11.1, the exact pinned Roslyn toolchain, and an explicit neutral fixture root are required' : false,
}, async (t) => {
  const fixture = await prepare();
  const profilesBefore = controllerProfileCount();
  t.after(async () => {
    for (const run of fixture.runs) await run.stop();
    assert.deepEqual(snapshotAcl(fixture.aclTargets), fixture.before, 'fixture stop must restore every ACL');
    assert.deepEqual(await readdir(fixture.scratchRoot), [], 'fixture stop must remove owned sessions');
    assert.equal(controllerProfileCount(), profilesBefore);
    for (const file of [path.join(fixture.stateDir, 'identity.json'), path.join(fixture.runtime, 'controller-marker.txt'), fixture.probeFile, fixture.dependencyFile, fixture.protocolPackage, fixture.protocolEntry]) {
      try { await unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw Error('CONTROLLER_FIXTURE_FILE_CLEANUP_FAILED'); }
    }
    for (const dir of [fixture.protocolDir, fixture.scopeDir, fixture.nodeModules, fixture.probeDir, fixture.stateDir, fixture.scratchRoot, fixture.outputA, fixture.outputB]) {
      if (dir === fixture.outputA || dir === fixture.outputB) for (const name of await readdir(dir)) await unlink(path.join(dir, name));
      await rmdir(dir);
    }
    try { await unlink(path.join(fixture.moduleRoot, 'phases.txt')); } catch (error) { if (error.code !== 'ENOENT') throw Error('CONTROLLER_FIXTURE_PHASE_CLEANUP_FAILED'); }
    await rmdir(fixture.moduleRoot);
  });
  let observedRequest;
  const echo = await launch(fixture, 'echo', async request => {
    observedRequest = { op: request.op, text: request.payload.text, checks: request.payload.checks };
    return 'pong';
  });
  const success = await boundedClose(echo, fixture);
  assert.equal(success.type, 'close');
  assert.equal(success.termination, 'none', JSON.stringify(success));
  assert.equal(success.reaped, true);
  assert.equal(success.cleaned, true);
  assert.equal(success.exitCode, 0);
  assert.deepEqual(observedRequest, { op: 'adapter', text: 'ping', checks: true });
  assert.equal(success.peakInFlightRequests, 1);

  let moduleProbe;
  const moduleRun = await launch(fixture, 'module-probe', async request => { moduleProbe = String(request.payload.text); return 'probe-ack'; });
  const moduleResult = await boundedClose(moduleRun, fixture);
  assert.equal(moduleResult.termination, 'none');
  assert.equal(moduleResult.reaped, true);
  assert.equal(moduleResult.cleaned, true);
  if (moduleProbe === undefined) assert.equal(moduleResult.errorCode, 'NODE_ACCESS_DENIED', JSON.stringify(moduleResult));
  else assert.equal(moduleProbe, 'static-import:OK,cwd:OK,stat:OK,realpath:DENIED,open:OK,list:DENIED,missing-stat:MISSING,missing-open:MISSING,missing-import:MISSING,package-import:DENIED,import:DENIED', JSON.stringify(moduleResult));

  for (const scenario of ['malformed', 'oversized', 'duplicate-id']) {
    const run = await launch(fixture, scenario, async () => 'unused');
    const result = await boundedClose(run, fixture);
    assert.equal(result.reaped, true);
    assert.equal(result.cleaned, true);
    assert.equal(result.termination, 'protocol-error');
  }

  const completionOrder = [];
  const four = await launch(fixture, 'four-inflight', async request => {
    await new Promise(resolve => setTimeout(resolve, (5 - request.id) * 45));
    completionOrder.push(request.id);
    return { accepted: request.id };
  });
  const fourResult = await boundedClose(four, fixture);
  assert.equal(fourResult.termination, 'none', JSON.stringify(fourResult));
  assert.equal(fourResult.exitCode, 0);
  assert.equal(fourResult.peakInFlightRequests, 4);
  assert.deepEqual(completionOrder, [4, 3, 2, 1]);

  const unknown = await launch(fixture, 'echo', async () => 'pong', { responseIdDelta: 1 });
  const unknownResult = await boundedClose(unknown, fixture);
  assert.equal(unknownResult.termination, 'protocol-error');

  const replayed = await launch(fixture, 'echo', async () => 'pong', { duplicateResponse: true });
  const replayedResult = await boundedClose(replayed, fixture);
  assert.equal(replayedResult.termination, 'protocol-error');

  const fifthSeen = [], fifthAborted = [];
  const fifth = await launch(fixture, 'five-inflight', (request, signal) => {
    fifthSeen.push(request.id);
    return new Promise(resolve => {
      const abort = () => { fifthAborted.push(request.id); resolve('cancelled'); };
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
  });
  const fifthResult = await boundedClose(fifth, fixture);
  assert.equal(fifthResult.termination, 'protocol-error');
  assert.equal(fifthResult.reaped, true);
  assert.equal(fifthResult.cleaned, true);
  // The bounded input queue may reject the burst before all four requests
  // reach dispatch. The four-request positive control above proves capacity.
  assert.ok(['IN_FLIGHT_LIMIT', 'CHILD_QUEUE_FULL'].includes(fifthResult.errorCode), JSON.stringify(fifthResult));
  assert.ok(fifthResult.peakInFlightRequests <= 4, JSON.stringify(fifthResult));
  assert.ok(fifthSeen.length <= fifthResult.peakInFlightRequests);
  assert.deepEqual(fifthSeen, Array.from({ length: fifthSeen.length }, (_, index) => index + 1));
  assert.deepEqual([...fifthAborted].sort(), fifthSeen);

  let longBytesObserved = 0, longRequestCount = 0;
  const longSession = await launch(fixture, 'long-session', async request => {
    longRequestCount++;
    longBytesObserved += Buffer.byteLength(String(request.payload.text), 'utf8');
    return 'ok';
  }, { sessionTimeoutMs: 120000 });
  let longResult;
  try { longResult = await boundedClose(longSession, fixture, 120000); }
  catch {
    const acceptedIds = fixture.phases.filter(value => value.startsWith('request-accepted-')).map(value => Number(value.slice(17)));
    const queuedIds = fixture.phases.filter(value => value.startsWith('response-queued-')).map(value => Number(value.slice(16)));
    const resolvedIds = fixture.phases.filter(value => value.startsWith('handler-resolved-')).map(value => Number(value.slice(17)));
    const denied = fixture.phases.filter(value => value.startsWith('control-') && value.endsWith('denied')).length;
    const stopped = await longSession.stop().catch(() => undefined);
    throw Error('CONTROLLER_LONG_SESSION_DID_NOT_CLOSE:' + JSON.stringify({ longRequestCount, longBytesObserved, acceptedIds, resolvedIds, queuedIds, denied,
      termination: stopped?.termination ?? 'unconfirmed', reaped: stopped?.reaped ?? false, cleaned: stopped?.cleaned ?? false }));
  }
  assert.equal(longResult.termination, 'none', JSON.stringify(longResult));
  assert.equal(longResult.exitCode, 0);
  assert.equal(longRequestCount, 84);
  assert.ok(longBytesObserved > 16 * 1024 * 1024);
  assert.ok(longResult.peakInFlightBytes < 1024 * 1024);

  const timeoutRun = await launch(fixture, 'echo', async () => new Promise(() => undefined), { operationTimeoutMs: 700 });
  const timeoutResult = await boundedClose(timeoutRun, fixture);
  assert.equal(timeoutResult.reaped, true);
  assert.equal(timeoutResult.cleaned, true);
  assert.ok(['stop', 'timeout'].includes(timeoutResult.termination));

  const hanging = await launch(fixture, 'hang', async () => 'unused');
  const stopped = await hanging.stop();
  assert.equal(stopped.reaped, true);
  assert.equal(stopped.cleaned, true);
  assert.equal(stopped.termination, 'stop');

  const stalledIds = [], cancelledIds = [];
  const concurrent = await launch(fixture, 'four-inflight', (request, signal) => {
    stalledIds.push(request.id);
    return new Promise(resolve => {
      const abort = () => { cancelledIds.push(request.id); resolve('cancelled'); };
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
  });
  await waitForCount(stalledIds, 4);
  const concurrentStopped = await concurrent.stop();
  assert.equal(concurrentStopped.reaped, true);
  assert.equal(concurrentStopped.cleaned, true);
  assert.equal(concurrentStopped.termination, 'stop');
  assert.deepEqual([...cancelledIds].sort(), [1, 2, 3, 4]);

  const startupAbort = new AbortController();
  const pendingStart = launch(fixture, 'hang', async () => 'unused', {
    signal: startupAbort.signal,
    onPhase: phase => { if (phase === 'parent-config-written') startupAbort.abort(); },
  });
  await assert.rejects(pendingStart, error => error instanceof Error && error.message === 'CONTROLLER_CANCELLED');

  const nonreader = await launch(fixture, 'flood', async () => 'unused', { pauseOutputMs: 1000 });
  const floodResult = await boundedClose(nonreader, fixture);
  assert.equal(floodResult.reaped, true);
  assert.equal(floodResult.cleaned, true);
  assert.equal(floodResult.termination, 'output-backpressure');

  const after = snapshotAcl(fixture.aclTargets);
  assert.deepEqual(after, fixture.before);
  assert.deepEqual(await readdir(fixture.scratchRoot), []);
  assert.deepEqual(await readdir(fixture.stateDir), ['identity.json']);
  assert.equal(controllerProfileCount(), profilesBefore);

});
