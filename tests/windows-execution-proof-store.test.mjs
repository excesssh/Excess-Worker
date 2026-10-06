import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { createWindowsExecutionProofStore } from '../apps/worker/dist/windows-execution-proof-store.js';
import { createControllerStateStore } from '../apps/worker/dist/controller-state.js';
import { requestDigest, TEXT_LIMITS } from '../packages/protocol/dist/index.js';

async function fixture(t) {
  const base = process.platform === 'win32' ? 'C:/ExcessBuilds/test-temp' : '/tmp';
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'excess-execution-proof-'));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(base) + sep));
    return rm(root, { recursive: true, force: true });
  });
  return root;
}
function proof() {
  const output = { text: 'Ready.', generatedTokens: 3 };
  return { assignment: { jobId: randomUUID(), attemptId: randomUUID(), deviceId: randomUUID(), fence: '1',
    leaseExpiresAt: '2030-01-01T00:01:00.000Z', runDeadlineAt: '2030-01-01T00:02:00.000Z',
    offerId: randomUUID(), capabilityDigest: 'a'.repeat(64), requestDigest: 'b'.repeat(64), maxUnits: '8' },
  inputDigest: 'c'.repeat(64), output, outputDigest: requestDigest(output), completedAt: '2030-01-01T00:00:30.000Z' };
}
test('host proof survives restart, retains receipt and cannot overwrite pending work', async t => {
  const root = await fixture(t), value = proof();
  let store = await createWindowsExecutionProofStore(root);
  assert.equal(await store.load(), null);
  await store.save(value); await store.close();
  store = await createWindowsExecutionProofStore(root);
  assert.deepEqual(await store.load(), value);
  await store.save({ ...value, receiptAccepted: true });
  await assert.rejects(store.save(value), /RECEIPT_REGRESSION/);
  await assert.rejects(store.save(proof()), /RECEIPT_PENDING/);
  await assert.rejects(store.save({ ...value, receiptAccepted: true, output: { text: 'Different', generatedTokens: 3 } }), /PROOF_CHANGED/);
  await assert.rejects(store.clear(randomUUID()), /ATTEMPT_MISMATCH/);
  await store.close();
  store = await createWindowsExecutionProofStore(root);
  assert.equal((await store.load()).receiptAccepted, true);
  await store.clear(value.assignment.attemptId); assert.equal(await store.load(), null); await store.close();
});
test('host proof rejects private content and bounds bytes before creating a file', async t => {
  const root = await fixture(t), store = await createWindowsExecutionProofStore(root), value = proof();
  for (const text of [['aa', 'ron'].join(''), 'C:' + '/' + 'Users' + '/' + 'private' + '/secret', 'X'.repeat(TEXT_LIMITS.maxOutputBytes * 5)]) {
    await assert.rejects(store.save({ ...value, output: { text, generatedTokens: 1 } }), /PROOF_(PRIVACY|LIMIT)/);
  }
  assert.deepEqual(await readdir(join(root, 'host-execution-proof')), []);
  const saving = store.save(value); value.output.text = 'Mutated after call'; await saving;
  assert.equal((await store.load()).output.text, 'Ready.');
  await store.close(); await assert.rejects(store.load(), /PROOF_CLOSED/);
});
test('hard links and unresolved staging refuse recovery without discarding evidence', async t => {
  const root = await fixture(t), store = await createWindowsExecutionProofStore(root), value = proof();
  await store.save(value); await store.close();
  const path = join(root, 'host-execution-proof', 'proof.json');
  await link(path, join(root, 'shared-proof.json'));
  const again = await createWindowsExecutionProofStore(root);
  await assert.rejects(again.load(), /PROOF_INVALID/); await again.close();
  assert.equal(JSON.parse(await readFile(path, 'utf8')).proof.output.text, 'Ready.');
  await writeFile(join(root, 'host-execution-proof', '.proof-uncertain.tmp'), '{}');
  await assert.rejects(createWindowsExecutionProofStore(root), /RECOVERY_REQUIRED/);
});
test('host proof is absent from child state selectors and link traversal is denied', async t => {
  const root = await fixture(t), store = await createWindowsExecutionProofStore(root), value = proof();
  await store.save(value);
  const state = await createControllerStateStore({ stateDir: root, markShutdownUnverified: async () => {} });
  await assert.rejects(state.replace('host-execution-proof/proof.json', Buffer.from('{}')), /CONTROLLER_STATE_INVALID/);
  assert.deepEqual(await store.load(), value); await state.close(); await store.close();
  const other = join(root, 'other'); await mkdir(other, { mode: 0o700 });
  const linked = join(root, 'linked'); await symlink(other, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createWindowsExecutionProofStore(linked), /PROOF_INVALID/);
});
test('close drains accepted saves and preserves bounded proof without leftover stages', async t => {
  const root = await fixture(t), store = await createWindowsExecutionProofStore(root), value = proof();
  const first = store.save(value), second = store.save({ ...value, receiptAccepted: true });
  await store.close(); await first; await second;
  assert.deepEqual(await readdir(join(root, 'host-execution-proof')), ['proof.json']);
  const again = await createWindowsExecutionProofStore(root);
  assert.equal((await again.load()).receiptAccepted, true); await again.close();
});
