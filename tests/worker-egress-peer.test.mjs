import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const expectedRuntime = 'v24.11.1';
const projectRoot = path.resolve(import.meta.dirname, '..');

test('Linux egress peer verifier binds the accepted socket to the paired controller namespace', {
  skip: process.platform !== 'linux' || process.version !== expectedRuntime,
}, async t => {
  const modulePath = process.env.EXCESS_EGRESS_PEER_MODULE ?? path.join(projectRoot, 'apps', 'worker', 'dist', 'egress-peer.js');
  try { await stat(modulePath); } catch { t.skip('Build the worker app before running the Linux peer verifier test'); return; }
  const { createLinuxEgressPeerValidator, verifyLinuxEgressPeer } = await import(pathToFileURL(modulePath));
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'excess-egress-peer-'));
  const socketPath = path.join(scratch, 'peer.sock');
  const nativePath = path.join(scratch, 'native');
  let controller;
  let server;
  const unrelatedHandles = [];
  try {
    execFileSync(process.execPath, [path.join(projectRoot, 'scripts', 'public-worker', 'build-linux-egress-peer.mjs'), nativePath], {
      cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const helperPath = path.join(nativePath, 'excess-egress-peer');
    const integrityPath = path.join(nativePath, 'integrity-egress-peer.json');
    for (let index = 0; index < 24; index++) unrelatedHandles.push(await open(process.execPath, 'r'));
    server = net.createServer();
    const queuedSockets = [];
    const connectionWaiters = [];
    server.on('connection', socket => {
      const waiter = connectionWaiters.shift();
      if (waiter) waiter(socket); else queuedSockets.push(socket);
    });
    server.listen(socketPath);
    await once(server, 'listening');

    const nextSocket = () => queuedSockets.length ? Promise.resolve(queuedSockets.shift()) : new Promise(resolve => connectionWaiters.push(resolve));
    const acceptAndValidate = async expectedControllerNamespace => {
      const socket = await nextSocket();
      try { return await verifyLinuxEgressPeer(socket, { helperPath, integrityPath, expectedControllerNamespace }); }
      finally { socket.destroy(); }
    };
    const connectHost = () => new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      socket.once('connect', () => resolve(socket));
      socket.once('error', reject);
    });
    const controllerSourceSequential = [
      "import net from 'node:net';",
      "import { statSync } from 'node:fs';",
      "const ns=statSync('/proc/self/ns/net',{bigint:true});",
      "console.log(JSON.stringify({dev:ns.dev.toString(),ino:ns.ino.toString()}));",
      "function connect(){ const socket=net.createConnection(process.argv[1]); socket.once('error',()=>process.exit(2)); socket.once('close',()=>{ if (--remaining > 0) setTimeout(connect,100); else process.exit(0); }); }",
      "let remaining=2; setTimeout(connect,500);",
    ].join('\n');
    controller = spawn('unshare', ['-Urn', process.execPath, '--input-type=module', '-e', controllerSourceSequential, socketPath], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let controllerOutput = '';
    controller.stdout.setEncoding('utf8');
    const metadataPromise = new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('CONTROLLER_NAMESPACE_TIMEOUT')), 3000);
      controller.stdout.on('data', chunk => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline >= 0) {
          clearTimeout(timer);
          controllerOutput = buffer.slice(0, newline);
          try { resolve(JSON.parse(controllerOutput)); } catch { reject(new Error('CONTROLLER_NAMESPACE_INVALID')); }
        }
      });
      controller.once('error', () => { clearTimeout(timer); reject(new Error('CONTROLLER_START_FAILED')); });
      controller.once('exit', code => { if (code !== 0) { clearTimeout(timer); reject(new Error('CONTROLLER_EXITED')); } });
    });
    const namespace = await metadataPromise;
    assert.match(namespace.dev, /^(?:0|[1-9][0-9]{0,19})$/);
    assert.match(namespace.ino, /^(?:0|[1-9][0-9]{0,19})$/);

    const hostResultPromise = acceptAndValidate(namespace);
    const hostSocket = await connectHost();
    const hostResult = await hostResultPromise;
    hostSocket.destroy();
    assert.equal(hostResult.accepted, false);
    assert.equal(hostResult.code, 'PEER_NAMESPACE_MISMATCH');

    const mismatchedExpected = { dev: namespace.dev, ino: namespace.ino === '0' ? '1' : String(BigInt(namespace.ino) + 1n) };
    const mismatchResultPromise = acceptAndValidate(mismatchedExpected);
    const mismatchResult = await mismatchResultPromise;
    assert.equal(mismatchResult.accepted, false);
    assert.equal(mismatchResult.code, 'PEER_NAMESPACE_MISMATCH');

    const exactResultPromise = acceptAndValidate(namespace);
    const exactResult = await exactResultPromise;
    assert.equal(exactResult.accepted, true);
    assert.equal(exactResult.code, 'ACCEPT');
    assert.equal(exactResult.peerNetDev, namespace.dev);
    assert.equal(exactResult.peerNetIno, namespace.ino);

    if (controller.exitCode === null) await once(controller, 'exit');
    await new Promise(resolve => server.close(resolve));
    server = undefined;
  } finally {
    if (controller && controller.exitCode === null) controller.kill('SIGKILL');
    if (server) await new Promise(resolve => server.close(resolve));
    await Promise.all(unrelatedHandles.map(handle => handle.close()));
    await rm(scratch, { recursive: true, force: true });
  }
});
