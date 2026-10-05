import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const NODE_HASH = '5796fd9700e83170bc7ddfdf7f18858c794a9f91cb39dd6f9e95060b292f2563';
const CONTROLLER_PROFILE = 'linux-controller-namespaces-v1';
const EGRESS_PROFILE = 'linux-af-unix-peercred-v1';
const projectRoot = path.resolve(import.meta.dirname, '..');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function safeBytes(bytes) {
  const ownerMarker = Buffer.from([97, 97, 114, 111, 110]);
  const ownerMarkerWide = Buffer.from([97, 0, 97, 0, 114, 0, 111, 0, 110, 0]);
  const lowered = Buffer.from(bytes.toString('latin1').toLowerCase(), 'latin1');
  const markerLowered = Buffer.from([97, 97, 114, 111, 110]);
  if (lowered.includes(markerLowered) || bytes.includes(ownerMarker) || bytes.includes(ownerMarkerWide)) throw new Error('FIXTURE_PRIVACY_BLOCKED');
  const text = bytes.toString('latin1');
  if (/[A-Z]:[\\/]Users[\\/][^\s/\\]+/i.test(text) || /\/mnt\/[a-z]\/Users\/[^\s/]+/i.test(text)) {
    throw new Error('FIXTURE_PRIVACY_BLOCKED');
  }
}

function makeDirectory(pathname) {
  mkdirSync(pathname, { recursive: true, mode: 0o700 });
  chmodSync(pathname, 0o700);
}

function createFixture({ runtime = true, peerValidator = true } = {}) {
  const directory = path.join(os.tmpdir(), `excess-controller-hostile-${process.pid}-${Date.now()}`);
  makeDirectory(directory);
  const paths = Object.fromEntries(['root', 'app', 'ai', 'state', 'scratch', 'broker'].map(name => [name, path.join(directory, name)]));
  for (const pathname of Object.values(paths)) makeDirectory(pathname);
  let appNode;
  if (runtime) {
    const nodeBytes = readFileSync(process.execPath);
    safeBytes(nodeBytes);
    if (createHash('sha256').update(nodeBytes).digest('hex') !== NODE_HASH || process.version !== 'v24.11.1') {
      throw new Error('FIXTURE_NODE_RUNTIME_INVALID');
    }
    const nodeDirectory = path.join(paths.app, 'node', 'bin');
    makeDirectory(path.join(paths.app, 'node'));
    makeDirectory(nodeDirectory);
    appNode = path.join(nodeDirectory, 'node');
    writeFileSync(appNode, nodeBytes, { mode: 0o700, flag: 'wx' });
    chmodSync(appNode, 0o700);
  } else {
    const probeSource = path.join(directory, 'start-probe.c');
    writeFileSync(probeSource, 'int main(void) { return 42; }\n', { flag: 'wx' });
    execFileSync('gcc', ['-O2', probeSource, '-o', path.join(paths.app, 'start-probe')], { stdio: ['ignore', 'ignore', 'pipe'] });
  }
  const appSentinel = path.join(paths.app, 'synthetic-app.txt');
  const aiModels = path.join(paths.ai, 'models');
  const aiRuntimes = path.join(paths.ai, 'runtimes');
  makeDirectory(aiModels);
  makeDirectory(aiRuntimes);
  const aiSentinel = path.join(aiModels, 'synthetic-model-fixture.txt');
  const runtimeSentinel = path.join(aiRuntimes, 'synthetic-runtime-fixture.txt');
  const aiUnrelated = path.join(paths.ai, 'unrelated-host-only.txt');
  writeFileSync(appSentinel, 'synthetic-app-fixture', { flag: 'wx' });
  writeFileSync(aiSentinel, 'synthetic-ai-fixture-only', { flag: 'wx' });
  writeFileSync(runtimeSentinel, 'synthetic-runtime-fixture-only', { flag: 'wx' });
  writeFileSync(aiUnrelated, 'must-not-be-mounted', { flag: 'wx' });
  const appDigest = createHash('sha256').update(readFileSync(appSentinel)).digest('hex');
  const aiDigest = createHash('sha256').update(readFileSync(aiSentinel)).digest('hex');
  const runtimeDigest = createHash('sha256').update(readFileSync(runtimeSentinel)).digest('hex');
  const unrelatedDigest = createHash('sha256').update(readFileSync(aiUnrelated)).digest('hex');

  const nativeController = path.join(directory, 'excess-controller');
  execFileSync('gcc', [
    '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-Wno-misleading-indentation',
    '-fPIE', '-pie', '-fstack-protector-strong', '-D_FORTIFY_SOURCE=2',
    '-Wl,-z,relro,-z,now', '-s', '-ffile-prefix-map=' + projectRoot + '=.',
    path.join(projectRoot, 'native/linux/excess-controller.c'), '-o', nativeController,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  chmodSync(nativeController, 0o700);
  let peerNative;
  if (peerValidator) {
    peerNative = path.join(directory, 'peer-native');
    execFileSync(process.execPath, [path.join(projectRoot, 'scripts/public-worker/build-linux-egress-peer.mjs'), peerNative], {
      cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  const peerModulePath = path.join(projectRoot, 'apps/worker/dist/egress-peer.js');
  if (peerValidator && !existsSync(peerModulePath)) throw new Error('FIXTURE_PEER_MODULE_REQUIRED');
  return {
    directory, paths, appNode, appSentinel, aiSentinel, runtimeSentinel, aiUnrelated,
    appDigest, aiDigest, runtimeDigest, unrelatedDigest, nativeController,
    peerNative, peerModulePath,
  };
}

function namespaceOf(pid) {
  const info = statSync(`/proc/${pid}/ns/net`, { bigint: true });
  return { dev: info.dev.toString(), ino: info.ino.toString() };
}

function mountPresent(mountpoint) {
  const escaped = mountpoint.replaceAll('\\', '\\134').replaceAll(' ', '\\040').replaceAll('\t', '\\011').replaceAll('\n', '\\012');
  return readFileSync('/proc/self/mountinfo', 'utf8').split('\n').some(line => line.split(' ')[4] === escaped);
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('FIXTURE_WAIT_TIMEOUT');
    await delay(20);
  }
}

async function makeBroker(fixture, validatePeer) {
  const socketPath = path.join(fixture.paths.broker, 'socket');
  const server = net.createServer();
  server.listen(socketPath);
  await once(server, 'listening');
  chmodSync(socketPath, 0o600);
  const messages = [];
  const records = [];
  const connections = new Set();
  const closedPeers = [];
  const socketErrors = [];
  server.on('connection', socket => {
    connections.add(socket);
    let validation;
    socket.on('error', error => socketErrors.push({ code: error.code, accepted: validation?.accepted === true }));
    void (async () => {
      let result;
      try { result = await validatePeer(socket); }
      catch { result = { accepted: false, code: 'VALIDATOR_ERROR', peerPid: null }; }
      validation = result;
      records.push(result);
      if (!result.accepted) { socket.destroy(); return; }
      let bytes = Buffer.alloc(0);
      socket.on('data', data => {
        bytes = Buffer.concat([bytes, data]);
        if (bytes.length > 65536 || messages.length > 1024) { socket.destroy(); return; }
        let end;
        while ((end = bytes.indexOf(10)) >= 0) {
          messages.push(bytes.subarray(0, end).toString('utf8')); bytes = bytes.subarray(end + 1);
          socket.write('ACK\n');
        }
      });
      socket.once('close', () => closedPeers.push(result.peerPid));
    })();
    socket.once('close', () => connections.delete(socket));
  });
  return { socketPath, server, messages, records, connections, closedPeers, socketErrors };
}

function spawnController(fixture, broker, command, arguments_ = []) {
  const directories = ['root', 'app', 'ai', 'state', 'scratch'].map(name => fixture.paths[name]);
  return spawn(fixture.nativeController, [
    ...directories, broker.socketPath, broker.socketPath, '--',
    ...(command[0] === '--native-probe' ? ['/app/start-probe'] : ['/app/node/bin/node', ...command]), ...arguments_,
  ], { cwd: '/', env: {}, stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
}

function readStartup(child) {
  return new Promise((resolve, reject) => {
    const channel = child.stdio[3];
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.removeListener('data', onData);
      child.removeListener('close', onClose);
      if (error) reject(error); else resolve(value);
    };
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 256) { finish(new Error('FIXTURE_STARTUP_FRAME_INVALID')); return; }
      if (!buffer.includes(10)) return;
      try {
        if (buffer[buffer.length - 1] !== 10 || buffer.subarray(0, -1).includes(10)) throw new Error('frame');
        const event = JSON.parse(buffer.toString('utf8'));
        assert.deepEqual(Object.keys(event).sort(), ['netDev', 'netIno', 'profile']);
        assert.equal(event.profile, CONTROLLER_PROFILE);
        assert.match(event.netDev, /^(?:0|[1-9][0-9]{0,19})$/);
        assert.match(event.netIno, /^(?:0|[1-9][0-9]{0,19})$/);
        finish(undefined, { channel, event: { dev: event.netDev, ino: event.netIno }, channelErrors });
      } catch { finish(new Error('FIXTURE_STARTUP_FRAME_INVALID')); }
    };
    const onClose = () => finish(new Error('FIXTURE_CLOSED_BEFORE_STARTUP'));
    // Keep an error listener after the handshake: native FD3 closure may reset
    // the pipe, while executable and lifecycle assertions prove startup success.
    const channelErrors = [];
    channel.on('error', error => {
      channelErrors.push(error.code);
      if (!settled) finish(new Error('FIXTURE_STARTUP_CHANNEL_' + error.code));
    });
    const timer = setTimeout(() => finish(new Error('FIXTURE_STARTUP_TIMEOUT')), 10000);
    channel.on('data', onData);
    child.once('close', onClose);
  });
}

async function waitClose(child, timeoutMs = 10000) {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return Promise.race([
    once(child, 'close').then(([code, signal]) => ({ code, signal })),
    delay(timeoutMs).then(() => { throw new Error('FIXTURE_PROCESS_DID_NOT_STOP'); }),
  ]);
}

async function assertNoMountLeak(fixture) {
  assert.deepEqual(readdirSync(fixture.paths.root), []);
  assert.deepEqual(readdirSync(fixture.paths.scratch), []);
  assert.equal(mountPresent(fixture.paths.root), false);
  assert.equal(mountPresent(fixture.paths.scratch), false);
}

function startHostProbeServers(fixture) {
  const hostPath = path.join(fixture.directory, 'host-only.sock');
  const abstractName = `excess-controller-hostile-${process.pid}`;
  let hostPathHits = 0, abstractHits = 0, loopbackHits = 0;
  const pathname = net.createServer(socket => { hostPathHits++; socket.destroy(); });
  const abstract = net.createServer(socket => { abstractHits++; socket.destroy(); });
  const loopback = net.createServer(socket => { loopbackHits++; socket.destroy(); });
  return new Promise((resolve, reject) => {
    let pending = 3;
    const finish = error => {
      if (error) { reject(error); return; }
      if (--pending !== 0) return;
      const address = loopback.address();
      resolve({ hostPath, abstractName, pathname, abstract, loopback, port: address.port,
        hits: () => ({ hostPathHits, abstractHits, loopbackHits }) });
    };
    pathname.once('error', finish); pathname.listen(hostPath, () => finish());
    abstract.once('error', finish); abstract.listen({ path: `\0${abstractName}` }, () => finish());
    loopback.once('error', finish); loopback.listen(0, '127.0.0.1', () => finish());
  });
}

async function closeHostProbeServers(servers) {
  for (const server of [servers.pathname, servers.abstract, servers.loopback]) {
    await new Promise(resolve => server.close(() => resolve()));
  }
}

const grandchildProgram = [
  "const fs=require('node:fs'),net=require('node:net');",
  "const socket=net.createConnection('/broker/socket');",
  "socket.once('connect',()=>socket.write('GRANDCHILD_READY\\n'));",
  "socket.once('data',()=>{fs.writeFileSync('/scratch/grandchild.ready','ready');setInterval(()=>socket.write('TICK\\n'),50)});",
  "socket.once('error',()=>process.exit(71));setInterval(()=>{},1000);",
].join('\n');

const controllerProgram = String.raw`
const fs=require('node:fs'),net=require('node:net'),https=require('node:https'),{spawn}=require('node:child_process');
const [hostPid,loopPort,hostPath,abstractName]=process.argv.slice(1);
const connectError=options=>new Promise(resolve=>{const socket=net.createConnection(options);const timer=setTimeout(()=>{socket.destroy();resolve('TIMEOUT')},1200);socket.once('connect',()=>{clearTimeout(timer);socket.destroy();resolve('CONNECTED')});socket.once('error',error=>{clearTimeout(timer);resolve(error.code||'OTHER')})});
const httpsError=()=>new Promise(resolve=>{const request=https.get({hostname:'203.0.113.1',port:443,timeout:1200},response=>{response.resume();resolve('CONNECTED')});request.once('error',error=>resolve(error.code||'OTHER'));request.setTimeout(1200,()=>request.destroy(Object.assign(new Error('timeout'),{code:'TIMEOUT'})))});
const openBroker=message=>new Promise((resolve,reject)=>{const socket=net.createConnection('/broker/socket');socket.once('error',reject);socket.once('connect',()=>{socket.once('data',data=>data.toString('utf8').trim()==='ACK'?resolve(socket):reject(new Error('broker-ack')));socket.write(message+'\n')})});
const grandchild=${JSON.stringify(grandchildProgram)};
(async()=>{
 const hostPathCode=await connectError({path:hostPath});
 const abstractCode=await connectError({path:'\0'+abstractName});
 const loopbackCode=await connectError({host:'127.0.0.1',port:Number(loopPort)});
 const httpsCode=await httpsError();
 let appWrite='allowed',modelsWrite='allowed',runtimesWrite='allowed',aiRootWrite='allowed',stateWrite='allowed';
 try{fs.writeFileSync('/app/forbidden-write','x')}catch(error){appWrite=error.code||'OTHER'}
 try{fs.writeFileSync('/ai/models/forbidden-write','x')}catch(error){modelsWrite=error.code||'OTHER'}
 try{fs.writeFileSync('/ai/runtimes/forbidden-write','x')}catch(error){runtimesWrite=error.code||'OTHER'}
 try{fs.writeFileSync('/ai/forbidden-write','x')}catch(error){aiRootWrite=error.code||'OTHER'}
 try{fs.writeFileSync('/state/forbidden-write','x')}catch(error){stateWrite=error.code||'OTHER'}
 const scratchStat=fs.statfsSync('/scratch');
 const scratchCapacity=Number(scratchStat.blocks)*Number(scratchStat.bsize);
 const scratchLine=fs.readFileSync('/proc/self/mountinfo','utf8').split('\n').find(line=>line.split(' ')[4]==='/scratch');
 const scratchParts=scratchLine?.split(' - ');
 const scratchType=scratchParts?.[1]?.split(' ')[0]||'';
 const scratchOptions=scratchParts?.[1]?.split(' ').slice(2).join(' ')||'';
 const scratchSizeMatch=/(?:^|,)size=(\d+)([kKmMgG]?)(?:,|$)/.exec(scratchOptions);
 const scratchMultiplier=scratchSizeMatch?({k:1024,m:1024**2,g:1024**3}[scratchSizeMatch[2].toLowerCase()]||1):0;
 const scratchBound=Boolean(scratchSizeMatch)&&Number(scratchSizeMatch[1])*scratchMultiplier<=256*1024*1024;
 const results={hostPathCode,abstractCode,loopbackCode,httpsCode,appWrite,modelsWrite,runtimesWrite,aiRootWrite,stateWrite,
   unrelatedAiVisible:fs.existsSync('/ai/unrelated-host-only.txt'),scratchCapacity,scratchType,scratchBound,
   hostProcessVisible:fs.existsSync('/proc/'+hostPid),numericProcEntries:fs.readdirSync('/proc').filter(name=>/^\d+$/.test(name))};
 const mainSocket=await openBroker('MAIN_READY');
 mainSocket.write('RESULTS:'+JSON.stringify(results)+'\n');
 process.on('SIGTERM',()=>{mainSocket.write('GRACEFUL:SIGTERM\n',()=>{mainSocket.end();process.exit(0)})});
 process.on('SIGINT',()=>{mainSocket.write('GRACEFUL:SIGINT\n',()=>{mainSocket.end();process.exit(0)})});
 const child=spawn(process.execPath,['-e',grandchild],{stdio:'ignore'});
 child.once('error',()=>process.exit(72));
 fs.writeFileSync('/scratch/controller.ready',String(process.pid));
 setInterval(()=>{},1000);
})().catch(()=>process.exit(70));
`;

test('pinned Node controller is peer-authenticated, hostile-boundary constrained and reaped on graceful/hard stop', {
  skip: process.platform !== 'linux' || process.arch !== 'x64' || process.version !== 'v24.11.1' || process.getuid?.() === 0,
  timeout: 45000,
}, async t => {
  const fixture = createFixture();
  const nativeBytes = readFileSync(path.join(projectRoot, 'native/linux/excess-controller.c'));
  const controllerHash = createHash('sha256').update(nativeBytes).digest('hex');
  const { verifyLinuxEgressPeer } = await import(pathToFileURL(fixture.peerModulePath));
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }));

  const runHostile = async stopSignal => {
    for (const file of readdirSync(fixture.paths.state)) rmSync(path.join(fixture.paths.state, file), { recursive: true, force: true });
    const expected = { current: undefined };
    const validator = async socket => expected.current
      ? verifyLinuxEgressPeer(socket, { helperPath: path.join(fixture.peerNative, 'excess-egress-peer'), expectedControllerNamespace: expected.current })
      : { accepted: false, code: 'NO_STARTUP_NAMESPACE', peerPid: null };
    const broker = await makeBroker(fixture, validator);
    const probes = await startHostProbeServers(fixture);
    let controller;
    try {
      controller = spawnController(fixture, broker, ['-e', controllerProgram], [
        String(process.pid), String(probes.port), probes.hostPath, probes.abstractName,
      ]);
      const { channel, event, channelErrors } = await readStartup(controller);
      const actual = namespaceOf(controller.pid);
      const host = namespaceOf(process.pid);
      assert.deepEqual(event, actual, 'FD3 namespace event must match the native supervisor namespace');
      assert.notDeepEqual(event, host, 'controller must not share the host network namespace');
      expected.current = Object.freeze({ ...event });
      const ackCountBefore = broker.records.length;
      const hostSocket = net.createConnection(broker.socketPath);
      const deniedSocketErrors = [];
      hostSocket.on('error', error => deniedSocketErrors.push(error.code));
      await once(hostSocket, 'connect');
      await waitUntil(() => broker.records.length > ackCountBefore);
      assert.equal(broker.records[ackCountBefore].accepted, false, 'host namespace peer must fail the production peer validator');
      assert.equal(broker.records[ackCountBefore].code, 'PEER_NAMESPACE_MISMATCH');
      hostSocket.destroy();
      channel.write('OK'); channel.end();

      await waitUntil(() => broker.messages.includes('MAIN_READY') && broker.messages.includes('GRANDCHILD_READY') &&
        broker.messages.includes('TICK') && broker.messages.some(message => message.startsWith('RESULTS:')), 12000);
      const results = JSON.parse(broker.messages.find(message => message.startsWith('RESULTS:')).slice(8));
      assert.equal(results.hostPathCode, 'ENOENT');
      assert.equal(results.abstractCode, 'ECONNREFUSED');
      assert.equal(results.loopbackCode, 'ECONNREFUSED');
      assert.equal(results.httpsCode, 'ENETUNREACH');
      assert.equal(results.appWrite, 'EROFS');
      assert.equal(results.modelsWrite, 'EROFS');
      assert.equal(results.runtimesWrite, 'EROFS');
      assert.equal(results.aiRootWrite, 'EROFS');
      assert.equal(results.stateWrite, 'EROFS');
      assert.deepEqual(readdirSync(fixture.paths.state), [], 'private controller cannot create unbounded host state');
      assert.equal(results.unrelatedAiVisible, false, 'unrelated files at the host AI root must not be mounted');
      assert.equal(results.scratchType, 'tmpfs');
      assert.equal(results.scratchBound, true);
      assert.ok(results.scratchCapacity > 0 && results.scratchCapacity <= 256 * 1024 * 1024);
      assert.equal(results.hostProcessVisible, false);
      assert.deepEqual(results.numericProcEntries, ['1']);
      assert.equal(broker.records.filter(record => record.accepted).length, 2);
      assert.ok(broker.records.filter(record => record.accepted).every(record =>
        record.peerNetDev === event.dev && record.peerNetIno === event.ino));
      assert.deepEqual(probes.hits(), { hostPathHits: 0, abstractHits: 0, loopbackHits: 0 });
      assert.deepEqual(readFileSync(fixture.appSentinel), Buffer.from('synthetic-app-fixture'));
      assert.deepEqual(readFileSync(fixture.aiSentinel), Buffer.from('synthetic-ai-fixture-only'));
      assert.deepEqual(readFileSync(fixture.runtimeSentinel), Buffer.from('synthetic-runtime-fixture-only'));
      assert.deepEqual(readFileSync(fixture.aiUnrelated), Buffer.from('must-not-be-mounted'));
      assert.equal(createHash('sha256').update(readFileSync(fixture.appSentinel)).digest('hex'), fixture.appDigest);
      assert.equal(createHash('sha256').update(readFileSync(fixture.aiSentinel)).digest('hex'), fixture.aiDigest);
      assert.equal(createHash('sha256').update(readFileSync(fixture.runtimeSentinel)).digest('hex'), fixture.runtimeDigest);
      assert.equal(createHash('sha256').update(readFileSync(fixture.aiUnrelated)).digest('hex'), fixture.unrelatedDigest);
      await assertNoMountLeak(fixture);
      assert.equal(broker.socketErrors.some(error => error.accepted), false, 'live accepted peers must have no read errors');

      await delay(150);
      if (stopSignal === 'SIGTERM') controller.kill('SIGTERM');
      else controller.kill('SIGKILL');
      const closed = await waitClose(controller, 7000);
      const acceptedPids = broker.records.filter(record => record.accepted).map(record => record.peerPid);
      assert.equal(acceptedPids.length, 2);
      await waitUntil(() => broker.connections.size === 0 && acceptedPids.every(pid => {
        try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
      }), 3000);
      assert.equal(broker.connections.size, 0, 'controller and grandchild broker peers must close');
      assert.ok(broker.socketErrors.every(error => error.code === 'ECONNRESET'), 'only a teardown reset is expected');
      assert.ok(deniedSocketErrors.every(code => code === 'ECONNRESET'), 'denied peer may receive a reset');
      assert.ok(channelErrors.every(code => code === 'ECONNRESET'), 'closed startup pipe may receive a reset');
      const tickLength = broker.messages.filter(message => message === 'TICK').length;
      await delay(150);
      assert.equal(broker.messages.filter(message => message === 'TICK').length, tickLength, 'grandchild IPC heartbeat must stop after supervisor termination');
      if (stopSignal === 'SIGTERM') {
        assert.equal(closed.code, 0);
        assert.equal(broker.messages.includes('GRACEFUL:SIGTERM'), true);
      } else {
        assert.equal(closed.signal, 'SIGKILL');
        assert.equal(broker.messages.some(message => message.startsWith('GRACEFUL:')), false);
      }
      await assertNoMountLeak(fixture);
      return { event, acceptedPeers: acceptedPids.length, hostDenied: true, closed, controllerHash };
    } finally {
      if (controller && controller.exitCode === null && controller.signalCode === null) {
        controller.kill('SIGKILL');
        await waitClose(controller, 7000);
      }
      await closeHostProbeServers(probes);
      for (const socket of broker.connections) socket.destroy();
      await new Promise(resolve => broker.server.close(resolve));
    }
  };

  const graceful = await runHostile('SIGTERM');
  const hard = await runHostile('SIGKILL');
  assert.notDeepEqual(graceful.event, namespaceOf(process.pid));
  assert.notDeepEqual(hard.event, namespaceOf(process.pid));
  assert.deepEqual(readdirSync(fixture.paths.ai).sort(), ['models', 'runtimes', 'unrelated-host-only.txt']);
  assert.deepEqual(readdirSync(path.join(fixture.paths.ai, 'models')), ['synthetic-model-fixture.txt']);
  assert.deepEqual(readdirSync(path.join(fixture.paths.ai, 'runtimes')), ['synthetic-runtime-fixture.txt']);
  assert.deepEqual(readdirSync(fixture.paths.app).sort(), ['node', 'synthetic-app.txt']);
  t.diagnostic(JSON.stringify({ controllerSha256: controllerHash, gracefulSignalForwarded: true, hardKillReapedTree: true,
    exactPeerNamespaceValidated: true, appAndAiReadonly: true, syntheticAiBytesOnly: true }));
});

test('native controller rejects an explicit startup ACK refusal before executing app code', {
  skip: process.platform !== 'linux' || process.arch !== 'x64' || process.version !== 'v24.11.1' || process.getuid?.() === 0,
  timeout: 15000,
}, async t => {
  const fixture = createFixture({ runtime: false, peerValidator: false });
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }));
  const broker = await makeBroker(fixture, async () => ({ accepted: false, code: 'DENY', peerPid: null }));
  let child;
  try {
    child = spawnController(fixture, broker, ['--native-probe']);
    const { channel } = await readStartup(child);
    channel.write('NO'); channel.end();
    const closed = await waitClose(child, 7000);
    assert.equal(closed.code, 126);
    assert.equal(existsSync(path.join(fixture.paths.state, 'should-not-run')), false);
    await assertNoMountLeak(fixture);
    // A real executable control distinguishes handshake refusal from ENOENT.
    child = spawnController(fixture, broker, ['--native-probe']);
    const accepted = await readStartup(child); accepted.channel.write('OK'); accepted.channel.end();
    assert.equal((await waitClose(child, 7000)).code, 42);
    await assertNoMountLeak(fixture);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    for (const socket of broker.connections) socket.destroy();
    await new Promise(resolve => broker.server.close(resolve));
  }
});

test('native controller startup ACK wait is bounded and leaves no private mount behind', {
  skip: process.platform !== 'linux' || process.arch !== 'x64' || process.version !== 'v24.11.1' || process.getuid?.() === 0,
  timeout: 15000,
}, async t => {
  const fixture = createFixture({ runtime: false, peerValidator: false });
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }));
  const broker = await makeBroker(fixture, async () => ({ accepted: false, code: 'DENY', peerPid: null }));
  let child;
  try {
    child = spawnController(fixture, broker, ['--native-probe']);
    await readStartup(child);
    const started = Date.now();
    const closed = await waitClose(child, 8000);
    const elapsed = Date.now() - started;
    assert.equal(closed.code, 126);
    assert.ok(elapsed >= 4500 && elapsed < 7500, 'startup ACK polling must be bounded near its native timeout');
    assert.equal(existsSync(path.join(fixture.paths.state, 'should-not-run')), false);
    await assertNoMountLeak(fixture);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    for (const socket of broker.connections) socket.destroy();
    await new Promise(resolve => broker.server.close(resolve));
  }
});

test('peer validator abort kills and reaps its running native helper promptly', {
  skip: process.platform !== 'linux' || process.arch !== 'x64' || process.version !== 'v24.11.1' || process.getuid?.() === 0,
  timeout: 5000,
}, async t => {
  const directory = path.join(os.tmpdir(), `excess-peer-abort-${process.pid}-${Date.now()}`);
  makeDirectory(directory);
  const marker = `/tmp/excess-peer-abort-marker-${process.pid}`;
  const source = path.join(directory, 'slow-helper.c');
  const helperPath = path.join(directory, 'slow-helper');
  const integrityPath = path.join(directory, 'integrity-egress-peer.json');
  const serverPath = path.join(directory, 'peer.sock');
  const sourceText = String.raw`
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <time.h>
#include <unistd.h>
int main(void) {
  char marker[96];
  snprintf(marker, sizeof(marker), "/tmp/excess-peer-abort-marker-%ld", (long)getppid());
  int fd = open(marker, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (fd < 0) return 2;
  dprintf(fd, "%ld", (long)getpid());
  close(fd);
  struct timespec wait = { 10, 0 };
  nanosleep(&wait, NULL);
  return 0;
}
`;
  writeFileSync(source, sourceText, { flag: 'wx', mode: 0o600 });
  const compiled = execFileSync('gcc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', helperPath], { encoding: 'buffer' });
  safeBytes(compiled);
  chmodSync(helperPath, 0o700);
  const helperHash = createHash('sha256').update(readFileSync(helperPath)).digest('hex');
  writeFileSync(integrityPath, JSON.stringify({ profile: EGRESS_PROFILE, sha256: helperHash }), { flag: 'wx', mode: 0o600 });
  chmodSync(integrityPath, 0o600);
  rmSync(marker, { force: true });
  t.after(() => { rmSync(marker, { force: true }); rmSync(directory, { recursive: true, force: true }); });

  const { createLinuxEgressPeerValidator } = await import(pathToFileURL(path.join(projectRoot, 'apps/worker/dist/egress-peer.js')));
  const server = net.createServer();
  server.listen(serverPath);
  await once(server, 'listening');
  chmodSync(serverPath, 0o600);
  let accepted;
  server.once('connection', socket => { accepted = socket; });
  const client = net.createConnection(serverPath);
  await once(client, 'connect');
  await waitUntil(() => accepted !== undefined);

  const abort = new AbortController();
  const validator = createLinuxEgressPeerValidator({
    helperPath,
    integrityPath,
    expectedControllerNamespace: { dev: '1', ino: '2' },
  });
  const started = Date.now();
  const validation = validator(accepted, abort.signal);
  await waitUntil(() => existsSync(marker), 1500);
  const helperPid = Number(readFileSync(marker, 'utf8'));
  assert.ok(Number.isSafeInteger(helperPid) && helperPid > 0);
  abort.abort();
  assert.equal(await validation, false);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 700, 'abort must kill and reap the helper before the 900 ms deadline');
  assert.throws(() => process.kill(helperPid, 0), error => error.code === 'ESRCH');

  client.destroy();
  accepted.destroy();
  await new Promise(resolve => server.close(resolve));
});
