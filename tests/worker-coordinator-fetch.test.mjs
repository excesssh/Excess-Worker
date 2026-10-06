import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { once } from 'node:events';
import { __testOnlyCreateCoordinatorFetcher, createCoordinatorFetcher } from '../apps/worker/dist/coordinator-fetch.js';
import { makeEphemeralTlsFixture } from './helpers/egress-tls.mjs';

async function fixture(t, options = {}) {
  const { key, cert } = makeEphemeralTlsFixture(); const hits = [];
  const server = https.createServer({ key, cert }, (request, response) => {
    hits.push(request.url);
    if (request.url === '/v1/public-config') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"product":"EXCESS"}'); }
    else if (request.url === '/v1/worker/heartbeat') { let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(body); }); }
    else if (request.url === '/downloads/release.json') { response.writeHead(302, { location: '/v1/public-config' }); response.end(); }
    else if (request.url === '/v1/market') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('x'.repeat(2 * 1024 * 1024 + 1)); }
    else if (request.url === '/v1/worker/command') { request.resume(); response.writeHead(200, { 'content-type': 'application/json' }); response.write('pending'); }
    else { response.writeHead(404); response.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = 'https://coordinator.test:' + server.address().port;
  let resolves = 0;
  const fetcher = __testOnlyCreateCoordinatorFetcher({ origin, ca: options.badCa ? 'invalid fixture CA' : cert,
    resolver: async hostname => { assert.equal(hostname, 'coordinator.test'); resolves++; return options.addresses ?? ['127.0.0.1']; } });
  return { origin, fetcher, hits, resolves: () => resolves };
}

test('trusted host fetch pins DNS once and authenticates the paired TLS hostname', async t => {
  const f = await fixture(t);
  const response = await f.fetcher(f.origin + '/v1/public-config', { redirect: 'error' });
  assert.deepEqual(await response.json(), { product: 'EXCESS' }); assert.equal(f.resolves(), 1);
  const reply = await f.fetcher(new URL('/v1/worker/heartbeat', f.origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"test":true}' });
  assert.deepEqual(await reply.json(), { test: true }); assert.equal(f.resolves(), 2);
});

test('host input cannot choose another origin, route, header, method or trust override', async t => {
  const f = await fixture(t);
  for (const [target, init] of [
    ['invalid URL fixture', {}], ['https://other.invalid/v1/public-config', {}], [f.origin + '/v1/unknown', {}],
    [f.origin + '/v1/public-config?next=x', {}], [f.origin + '/v1/public-config', { method: 'DELETE' }],
    [f.origin + '/v1/public-config', { headers: { authorization: 'fixture' } }],
    [f.origin + '/v1/public-config', { redirect: 'follow' }],
    [f.origin + '/v1/public-config', { ca: 'child-controlled' }],
    [f.origin + '/v1/worker/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(32769) }],
  ]) await assert.rejects(f.fetcher(target, init), /COORDINATOR_TRANSPORT_UNAVAILABLE/);
  assert.deepEqual(f.hits, []); assert.equal(f.resolves(), 0);
  await assert.rejects(f.fetcher(new Request(f.origin + '/v1/public-config')), /COORDINATOR_TRANSPORT_UNAVAILABLE/);
  await assert.rejects(f.fetcher(f.origin + '/v1/worker/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blocked: ['aa', 'ron'].join('').toUpperCase() }) }), /COORDINATOR_TRANSPORT_UNAVAILABLE/);
  assert.deepEqual(f.hits, []);
  assert.throws(() => createCoordinatorFetcher('http://127.0.0.1'));
});

test('unconsumed response streams count against the host budget and cancellation frees it', async t => {
  const f = await fixture(t);
  const requests = await Promise.all(Array.from({ length: 8 }, () => f.fetcher(f.origin + '/v1/worker/command', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })));
  await assert.rejects(f.fetcher(f.origin + '/v1/public-config'), /COORDINATOR_TRANSPORT_UNAVAILABLE/);
  assert.equal(f.hits.length, 8);
  await Promise.all(requests.map(response => response.body.cancel()));
  assert.equal((await f.fetcher(f.origin + '/v1/public-config')).status, 200);
});

test('a mixed private DNS answer and untrusted fixture CA fail before application data', async t => {
  const mixed = await fixture(t, { addresses: ['127.0.0.1', '10.0.0.1'] });
  await assert.rejects(mixed.fetcher(mixed.origin + '/v1/public-config'), /COORDINATOR_TRANSPORT_UNAVAILABLE/); assert.deepEqual(mixed.hits, []);
  const wrong = await fixture(t, { badCa: true });
  await assert.rejects(wrong.fetcher(wrong.origin + '/v1/public-config'), /COORDINATOR_TRANSPORT_UNAVAILABLE/); assert.deepEqual(wrong.hits, []);
});

test('redirect and oversized responses are refused, and abort prevents a connection', async t => {
  const f = await fixture(t);
  await assert.rejects(f.fetcher(f.origin + '/downloads/release.json'), /COORDINATOR_TRANSPORT_UNAVAILABLE/);
  const oversized = await f.fetcher(f.origin + '/v1/market');
  await assert.rejects(oversized.text(), /COORDINATOR_TRANSPORT_UNAVAILABLE/);
  const controller = new AbortController(); controller.abort();
  const before = f.hits.length;
  await assert.rejects(f.fetcher(f.origin + '/v1/public-config', { signal: controller.signal }), /COORDINATOR_TRANSPORT_UNAVAILABLE/);
  assert.equal(f.hits.length, before);
});
