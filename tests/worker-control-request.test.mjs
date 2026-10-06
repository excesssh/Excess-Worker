import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setWorkerControl, readWorkerControl, readWorkerControlRequest, stopWorkerControlAfterReap, startWorkerUpdate } from '../apps/worker/dist/control.js';

test('host request revisions preserve legacy controls and veto stop/resume races before installation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'excess-control-request-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await setWorkerControl(dir, 'run'); const initial = await readWorkerControlRequest(dir);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'control.json'), 'utf8')), { version: 1, mode: 'run' });
  await stopWorkerControlAfterReap(dir);
  assert.deepEqual(await readWorkerControlRequest(dir), { mode: 'stop', revision: initial.revision });
  let starts = 0;
  await setWorkerControl(dir, 'stop'); await setWorkerControl(dir, 'run');
  assert.notEqual((await readWorkerControlRequest(dir)).revision, initial.revision);
  assert.equal(await startWorkerUpdate(dir, initial.revision, async () => { starts++; return 0; }), undefined);
  assert.equal(starts, 0);
  const latest = await readWorkerControlRequest(dir); await stopWorkerControlAfterReap(dir);
  let finish; const pending = new Promise(resolve => { finish = resolve; });
  const installation = startWorkerUpdate(dir, latest.revision, () => { starts++; return pending; });
  for (let i = 0; i < 100 && !starts; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(starts, 1);
  // The installer is running: control remains responsive, and this new request
  // is ordered after its protected start rather than vetoing an earlier start.
  await setWorkerControl(dir, 'stop'); assert.equal(await readWorkerControl(dir), 'stop');
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'control-update.json'), 'utf8')), { version: 1, revision: latest.revision, phase: 'started' });
  finish(0); assert.equal(await installation, 0);
});

test('separate CLI processes serialize request revisions with matching legacy control bytes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'excess-control-process-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const module = fileURLToPath(new URL('../apps/worker/dist/control.js', import.meta.url));
  const program = "const {pathToFileURL}=await import('node:url');const {setWorkerControl}=await import(pathToFileURL(process.argv[1]));for(let i=0;i<8;i++)await setWorkerControl(process.argv[2],process.argv[3]);";
  const child = mode => new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, ['--input-type=module', '-e', program, module, dir, mode], { stdio: 'ignore', windowsHide: true });
    processChild.once('error', () => reject(Error('CONTROL_FIXTURE_SPAWN_FAILED')));
    processChild.once('exit', code => code === 0 ? resolve() : reject(Error('CONTROL_FIXTURE_FAILED')));
  });
  await Promise.all([child('run'), child('stop')]);
  const request = JSON.parse(await readFile(join(dir, 'control-request.json'), 'utf8'));
  assert.equal(request.mode, await readWorkerControl(dir));
  assert.equal((await readWorkerControlRequest(dir)).revision, request.revision);
  await writeFile(join(dir, 'control-request.json'), JSON.stringify({ version: 1, mode: 'run', revision: 'invalid' }));
  await assert.rejects(() => readWorkerControlRequest(dir), /CONTROL_REQUEST_INVALID/);
});

test('Windows concurrent control bursts preserve the final request and legacy bytes', { skip: process.platform !== 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'excess-control-bursts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const module = fileURLToPath(new URL('../apps/worker/dist/control.js', import.meta.url));
  const program = "const {pathToFileURL}=await import('node:url');const {setWorkerControl}=await import(pathToFileURL(process.argv[1]));try{for(let i=0;i<8;i++)await setWorkerControl(process.argv[2],process.argv[3]);}catch(error){process.stderr.write(/^[A-Z_]{1,80}$/.test(error.code??'')?error.code:'CONTROL_FAILED');process.exitCode=1;}";
  const child = mode => new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, ['--input-type=module', '-e', program, module, dir, mode], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let code = ''; processChild.stderr.setEncoding('utf8');
    processChild.stderr.on('data', value => { if (code.length < 128) code += value; });
    processChild.once('error', () => reject(Error('CONTROL_FIXTURE_SPAWN_FAILED')));
    processChild.once('close', status => status === 0 ? resolve() : reject(Error('CONTROL_FIXTURE_FAILED:' + (/^[A-Z_]{1,80}$/.test(code) ? code : 'UNKNOWN'))));
  });
  for (let round = 0; round < 32; round++) {
    await Promise.all([child('run'), child('stop'), child('drain'), child('run')]);
    const request = JSON.parse(await readFile(join(dir, 'control-request.json'), 'utf8'));
    assert.equal(request.mode, await readWorkerControl(dir));
    assert.equal((await readWorkerControlRequest(dir)).revision, request.revision);
  }
});
