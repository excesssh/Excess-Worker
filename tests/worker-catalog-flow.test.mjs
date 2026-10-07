import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, join, dirname, basename } from "node:path";
import { MODEL_CATALOG, textProbeTokens } from "../packages/adapters/dist/index.js";
import { requestDigest } from "../packages/protocol/dist/index.js";
import { runWorker } from "../apps/worker/dist/runtime.js";
import { runLocalProbe } from "../apps/worker/dist/probe.js";
import { readWorkerPolicy, writeWorkerPolicy } from "../apps/worker/dist/policy.js";
import { readWorkerOffers, automaticWorkerPrices } from "../apps/worker/dist/offer.js";
import { setWorkerControl, readWorkerStatus } from "../apps/worker/dist/control.js";

// Every catalog text model through the worker's own commands and loop, with a SYNTHETIC adapter and coordinator. It checks that
// a supplier can choose, plan, price, probe and serve each entry; no model runs, nothing is downloaded and no token is real.
const ready = async () => ({ freeMemoryMb: 270000, idleSeconds: 3600 });
const timings = { pollMs: 20, heartbeatMs: 20, renewMs: 20, monitorMs: 10 };
async function temporary(run) {
  const parent = resolve(".cache"); await mkdir(parent, { recursive: true }); const dir = await mkdtemp(join(parent, "worker-catalog-flow-"));
  try { return await run(dir); } finally { assert.equal(dirname(dir), parent); assert.ok(basename(dir).startsWith("worker-catalog-flow-")); await rm(dir, { recursive: true, force: true }); }
}
const cli = (home, models, ...args) => spawnSync(process.execPath, [resolve("apps/worker/dist/main.js"), ...args], { encoding: "utf8", timeout: 60000,
  env: { ...process.env, EXCESS_WORKER_HOME: home, EXCESS_MODEL_DIR: models } });
const json = (home, models, ...args) => { const result = cli(home, models, ...args); assert.equal(result.status, 0, args.join(" ") + ": " + result.stderr); return JSON.parse(result.stdout); };
const cliOnPlatform = (platform, home, models, ...args) => {
  const main = "apps/worker/dist/main.js";
  const source = `Object.defineProperty(process,"platform",{value:${JSON.stringify(platform)}});process.argv=[process.argv[0],${JSON.stringify(main)},...${JSON.stringify(args)}];await import(${JSON.stringify("./" + main)});`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", timeout: 60000,
    env: { ...process.env, EXCESS_WORKER_HOME: home, EXCESS_MODEL_DIR: models } });
};
const jsonOnPlatform = (platform, home, models, ...args) => {
  const result = cliOnPlatform(platform, home, models, ...args);
  assert.equal(result.status, 0, `${platform} ${args.join(" ")}: ${result.stderr}`);
  return JSON.parse(result.stdout);
};
function syntheticAdapter(entry, policy) {
  return {
    supportsStreaming: true,
    async probe() {
      return { ok: true, capabilityDigest: entry.capabilityDigest, backend: policy.backend, modelId: entry.id, model: entry.capability.model, runtime: entry.capability.runtime,
        threads: policy.threads, maxMemoryMb: policy.maxMemoryMb, probedAt: new Date().toISOString(), generatedTokens: textProbeTokens(entry), peakRssMb: 128, nativePid: 700001, guardianPid: 700002 };
    },
    async execute(request, { onChunk }) {
      // A reasoning model's hidden tokens arrive as a chunk with an empty delta before its answer.
      const chunks = [{ sequence: 1, delta: entry.info.reasoning ? "" : "SYNTHETIC ", tokenIds: [1, 2, 3, 4, 5, 6, 7, 8] }, { sequence: 2, delta: "ANSWER", tokenIds: [9] }];
      for (const chunk of chunks) await onChunk({ ...chunk, chunkDigest: requestDigest(chunk) });
      return { text: chunks.map(chunk => chunk.delta).join(""), generatedTokens: 9, finishReason: "stop" };
    },
    async stop() {},
  };
}

test("every text model can be chosen, planned, priced, probed and served through the worker", async () => temporary(async dir => {
  for (const entry of MODEL_CATALOG) {
    const home = join(dir, entry.id, "worker"), models = join(dir, entry.id, "ai");
    // The test explicitly configures enough host memory before selecting the model; use never raises the cap itself.
    const explicitMemoryMb = Math.max(4096, entry.minMemoryMb);
    await writeWorkerPolicy(home, { ...(await readWorkerPolicy(home)), maxMemoryMb: explicitMemoryMb });
    const chosen = json(home, models, "use", entry.id);
    assert.deepEqual([chosen.policy.model, chosen.policy.backend, chosen.policy.maxMemoryMb], [entry.id, "cpu", explicitMemoryMb], entry.id);
    const plan = json(home, models, "model-plan");
    assert.deepEqual([plan.modelId, plan.capabilityDigest, plan.licences.model, plan.model.files], [entry.id, entry.capabilityDigest, entry.capability.modelLicence,
      entry.artifacts.filter(item => item.name.endsWith(".gguf")).length], entry.id);
    assert.ok(entry.artifacts.every(item => plan.artifacts.some(planned => planned.name === item.name && planned.sha256 === item.sha256)), entry.id);
    assert.ok(plan.disk.requiredBytes >= entry.artifacts.reduce((sum, item) => sum + item.bytes, 0) && typeof plan.disk.sufficient === "boolean", "nothing is installed yet, so every file counts");
    assert.equal(json(home, models, "policy").policy.model, entry.id);
    // One model priced in two assets: setting a price again replaces only that asset's price; "off" withdraws one.
    const assetId = randomUUID(), second = randomUUID(), third = randomUUID();
    assert.deepEqual(json(home, models, "offer", assetId, "4").offer, { assetId, netUnits: "4" });
    assert.deepEqual(json(home, models, "offer", second, "7").offers, [{ assetId, netUnits: "4" }, { assetId: second, netUnits: "7" }]);
    assert.deepEqual(json(home, models, "offer", assetId, "5").offers, [{ assetId: second, netUnits: "7" }, { assetId, netUnits: "5" }]);
    assert.deepEqual(json(home, models, "offer", third, "9").offers.length, 3);
    assert.deepEqual(json(home, models, "offer", third, "off").offers, [{ assetId: second, netUnits: "7" }, { assetId, netUnits: "5" }]);
    assert.deepEqual(await readWorkerOffers(home, entry.id), [{ assetId: second, netUnits: "7" }, { assetId, netUnits: "5" }]);

    const policy = { ...await readWorkerPolicy(home), idleOnly: false, threads: 1 };
    await writeWorkerPolicy(home, policy);
    const proof = await runLocalProbe({ stateDir: home, installDir: models, telemetry: ready, adapter: syntheticAdapter(entry, policy) });
    assert.equal(proof.capabilityDigest, entry.capabilityDigest);
    assert.deepEqual([(await readWorkerStatus(home)).reason, (await readWorkerStatus(home)).capabilityDigest], ["probe_completed", entry.capabilityDigest]);

    const deviceId = randomUUID(), request = { prompt: "SYNTHETIC REQUEST", maxTokens: Math.max(16, entry.capability.minOutputTokens ?? 1), seed: 1 };
    const a = { jobId: randomUUID(), attemptId: randomUUID(), deviceId, fence: "1", offerId: randomUUID(), capabilityDigest: entry.capabilityDigest, requestDigest: requestDigest(request),
      maxUnits: String(request.maxTokens), leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), runDeadlineAt: new Date(Date.now() + 90000).toISOString() };
    const state = { offers: [], result: null, failed: null, chunks: [] }, shutdown = new AbortController();
    const connection = {
      deviceId,
      async heartbeat() { return { accepted: true }; },
      async offer(value) { state.offers.push(value); return { accepted: true }; },
      async command(type, data) {
        // Work is assigned only once the worker has published its probed offer for this model.
        if (type === "worker.poll") { const open = !state.result && !state.failed && state.offers.length > 0; return { executionEnabled: open, assignments: open ? [a] : [] }; }
        if (type === "job.input") return { request, requestDigest: a.requestDigest, capabilityDigest: entry.capabilityDigest, deliveryMode: "stream" };
        if (type === "job.started" || type === "job.renew") return { state: "running", leaseExpiresAt: a.leaseExpiresAt };
        if (type === "job.chunk") { state.chunks.push(data); return { accepted: true, sequence: data.sequence, chunkDigest: data.chunkDigest }; }
        if (type === "job.result") { state.result = data; setTimeout(() => shutdown.abort(), 50); return { accepted: true, state: "verifying" }; }
        if (type === "job.failed") { state.failed = data; setTimeout(() => shutdown.abort(), 50); return { state: "failed" }; }
        throw Error("Unknown synthetic command " + type);
      },
    };
    await setWorkerControl(home, "run");
    await runWorker({ identityPath: join(home, "unused-identity.json"), stateDir: home, installDir: models, policy, timings, connection,
      adapter: syntheticAdapter(entry, policy), telemetry: ready, signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(30000)]) });
    assert.equal(state.failed, null, entry.id + " " + JSON.stringify(state.failed));
    assert.deepEqual(state.offers.slice(0, 2).map(offer => [offer.capabilityDigest, offer.assetId, offer.netUnits]),
      [[entry.capabilityDigest, second, "7"], [entry.capabilityDigest, assetId, "5"]], entry.id + ": one offer per asset");
    assert.deepEqual([state.result.reportedUnits, state.result.output.text, state.chunks.length], ["9", entry.info.reasoning ? "ANSWER" : "SYNTHETIC ANSWER", 2], entry.id);
  }
}));

test("CLI keeps model RAM and VRAM caps explicit and maps Windows/Linux --gpu to CUDA", async () => temporary(async dir => {
  // These command checks only change policy files. No model is installed or executed, so they are not GPU evidence.
  const linuxHome = join(dir, "linux", "worker"), linuxModels = join(dir, "linux", "ai");
  const linuxBefore = await readWorkerPolicy(linuxHome);
  const linuxTooSmall = cliOnPlatform("linux", linuxHome, linuxModels, "use", "qwen3-8b", "--gpu");
  assert.notEqual(linuxTooSmall.status, 0);
  assert.match(linuxTooSmall.stderr, /explicit host memory cap of at least 7 GB/);
  assert.match(linuxTooSmall.stderr, /explicit GPU memory budget of at least 6\.5 GB/);
  assert.deepEqual(await readWorkerPolicy(linuxHome), linuxBefore, "refused selection leaves model and both caps untouched");
  await writeWorkerPolicy(linuxHome, { ...linuxBefore, maxMemoryMb: 7168, maxGpuMemoryMb: 6656 });
  const linuxSelected = jsonOnPlatform("linux", linuxHome, linuxModels, "use", "qwen3-8b", "--gpu");
  assert.deepEqual([linuxSelected.policy.backend, linuxSelected.policy.maxMemoryMb, linuxSelected.policy.maxGpuMemoryMb], ["cuda", 7168, 6656]);
  assert.match(linuxSelected.candidate, /unverified Linux CUDA profile.*Worker 0\.2\.0.*hardware trial.*0\.1\.0 Linux archive remains CPU-only/);
  assert.equal(linuxSelected.executionEvidence, "not established by catalogue inventory");

  const linuxLimitHome = join(dir, "linux-limit", "worker"), linuxLimitModels = join(dir, "linux-limit", "ai");
  const linuxOverLimit = { ...(await readWorkerPolicy(linuxLimitHome)), maxMemoryMb: 129025 };
  await writeWorkerPolicy(linuxLimitHome, linuxOverLimit);
  const linuxRejected = cliOnPlatform("linux", linuxLimitHome, linuxLimitModels, "use", "qwen3-4b", "--gpu");
  assert.notEqual(linuxRejected.status, 0);
  assert.match(linuxRejected.stderr, /host memory cap cannot exceed 126 GB/);
  assert.deepEqual(await readWorkerPolicy(linuxLimitHome), linuxOverLimit);

  const windowsHome = join(dir, "windows", "worker"), windowsModels = join(dir, "windows", "ai");
  const windowsBefore = await readWorkerPolicy(windowsHome);
  const windowsTooSmall = cliOnPlatform("win32", windowsHome, windowsModels, "use", "qwen3-4b", "--gpu");
  assert.notEqual(windowsTooSmall.status, 0);
  assert.match(windowsTooSmall.stderr, /explicit host memory cap of at least 6 GB/);
  assert.match(windowsTooSmall.stderr, /explicit GPU memory budget of at least 6 GB/);
  assert.deepEqual(await readWorkerPolicy(windowsHome), windowsBefore);
  const windowsOverLimit = { ...windowsBefore, maxMemoryMb: 6144, maxGpuMemoryMb: 32769 };
  await writeWorkerPolicy(windowsHome, windowsOverLimit);
  const windowsRejected = cliOnPlatform("win32", windowsHome, windowsModels, "use", "qwen3-4b", "--gpu");
  assert.notEqual(windowsRejected.status, 0);
  assert.match(windowsRejected.stderr, /cannot exceed 32 GB/);
  assert.deepEqual(await readWorkerPolicy(windowsHome), windowsOverLimit);
  await writeWorkerPolicy(windowsHome, { ...windowsOverLimit, maxGpuMemoryMb: 6144 });
  const windowsSelected = jsonOnPlatform("win32", windowsHome, windowsModels, "use", "qwen3-4b", "--gpu");
  assert.deepEqual([windowsSelected.policy.backend, windowsSelected.policy.maxMemoryMb, windowsSelected.policy.maxGpuMemoryMb], ["cuda", 6144, 6144]);
}));

test("worker prices: the earlier single-price file still reads, the last price withdrawn removes the file, and malformed lists are refused", async () => temporary(async dir => {
  const home = join(dir, "worker"), models = join(dir, "ai"), assetId = randomUUID();
  json(home, models, "use", "qwen3-4b");
  await mkdir(join(home, "offers"), { recursive: true });
  await writeFile(join(home, "offers", "qwen3-4b.json"), JSON.stringify({ assetId, netUnits: "3" }), { mode: 0o600 });
  assert.deepEqual(json(home, models, "offer").offers, [{ assetId, netUnits: "3" }], "a price written by an earlier worker version");
  assert.deepEqual(json(home, models, "offer", assetId, "off").offers, []);
  assert.deepEqual(await readWorkerOffers(home, "qwen3-4b"), []);
  json(home,models,"offer",assetId,"3");
  assert.deepEqual(json(home,models,"offer",assetId,"band","2","5").offer,
    {assetId,netUnits:"3",minNetUnits:"2",maxNetUnits:"5"});
  assert.equal(json(home,models,"offer",assetId,"auto","on").offer.auto,"follow_lowest");
  assert.equal(json(home,models,"offer",assetId,"auto","off").offer.auto,undefined);
  assert.deepEqual(json(home,models,"offer",assetId,"4").offer,
    {assetId,netUnits:"4",minNetUnits:"2",maxNetUnits:"5"},"a price edit preserves its guardrail");
  const tooLow=cli(home,models,"offer",assetId,"1");
  assert.notEqual(tooLow.status,0);assert.match(tooLow.stderr,/outside its bounds/);
  assert.equal((await readWorkerOffers(home,"qwen3-4b"))[0].netUnits,"4","a refused edit leaves the published price intact");
  const badBand=cli(home,models,"offer",assetId,"band","5","6");
  assert.notEqual(badBand.status,0);assert.match(badBand.stderr,/outside its bounds/);
  assert.deepEqual(json(home,models,"offer",assetId,"band","off").offers,[{assetId,netUnits:"4"}]);
  const noBand=cli(home,models,"offer",assetId,"auto","on");
  assert.notEqual(noBand.status,0);assert.match(noBand.stderr,/Set a price band/);
  assert.equal(json(home,models,"offer",assetId,"1").offer.netUnits,"1");
  for (const bad of [{ offers: [] }, { offers: [{ assetId, netUnits: "1" }, { assetId, netUnits: "2" }] },
    { offers: [{ assetId, netUnits: "0" }] }, { offers: [{ assetId, netUnits: "1" }], extra: 1 },
    {offers:[{assetId,netUnits:"1",minNetUnits:"0.5"}]},
    {offers:[{assetId,netUnits:"1",minNetUnits:"2",maxNetUnits:"3"}]}]) {
    await writeFile(join(home, "offers", "qwen3-4b.json"), JSON.stringify(bad), { mode: 0o600 });
    await assert.rejects(readWorkerOffers(home, "qwen3-4b"), /Invalid worker offer/, JSON.stringify(bad));
  }
}));

test("automatic supplier pricing follows a cheaper public ask within the saved band and does not ratchet against itself",async()=>{
  const assetId=randomUUID(),base={assetId,netUnits:"5",minNetUnits:"2",maxNetUnits:"7",auto:"follow_lowest"};
  let cheapest="4",calls=0;
  const fetcher=async()=>{calls++;return new Response(JSON.stringify({models:[{id:"qwen3-4b",markets:[{asset:{id:assetId},status:"available",cheapestUnitNet:cheapest}]}]}),
    {status:200,headers:{"content-type":"application/json"}});};
  const price=async(previous=new Map())=>(await automaticWorkerPrices("https://example.test","qwen3-4b",[base],previous,undefined,fetcher))[0].netUnits;
  assert.equal(await price(),"3.999999");
  cheapest="3.999999";
  assert.equal(await price(new Map([[assetId,"3.999999"]])),"3.999999","the supplier's own new best ask must not drive another cut");
  cheapest="1";
  assert.equal(await price(new Map([[assetId,"3.999999"]])),"2","the floor stops undercutting");
  cheapest="6";
  assert.equal(await price(),"5","the rule never raises the saved price");
  assert.equal(calls,4);
  assert.equal((await automaticWorkerPrices("https://example.test","qwen3-4b",[{assetId,netUnits:"5"}],new Map(),undefined,fetcher))[0].netUnits,"5");
  assert.equal(calls,4,"a manual offer never fetches the market");
  assert.equal((await automaticWorkerPrices("https://example.test","qwen3-4b",[base],new Map(),undefined,async()=>{throw Error("offline")}))[0].netUnits,"5");
  const huge=async()=>new Response("x".repeat(2_097_153));
  assert.equal((await automaticWorkerPrices("https://example.test","qwen3-4b",[base],new Map(),undefined,huge))[0].netUnits,"5",
    "an oversized market response cannot influence the worker's price");
});

test("the running worker publishes the automatic ask from the exchange's public model market",async()=>temporary(async dir=>{
  const home=join(dir,"worker"),models=join(dir,"ai"),assetId=randomUUID(),entry=MODEL_CATALOG[0];
  json(home,models,"use",entry.id);json(home,models,"offer",assetId,"5");
  json(home,models,"offer",assetId,"band","2","7");json(home,models,"offer",assetId,"auto","on");
  const policy={...await readWorkerPolicy(home),idleOnly:false,threads:1};await writeWorkerPolicy(home,policy);
  const server=createServer((_req,res)=>{res.setHeader("content-type","application/json");res.end(JSON.stringify({models:[{id:entry.id,
    markets:[{asset:{id:assetId},status:"available",cheapestUnitNet:cheapest}]}]}));});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const origin="http://127.0.0.1:"+server.address().port,stop=new AbortController(),published=[];
  let cheapest="4";
  try {
    await setWorkerControl(home,"run");
    const connection={deviceId:randomUUID(),origin,async heartbeat(){return {accepted:true}},
      async offer(value){published.push(value.netUnits);cheapest=value.netUnits;if(published.length>=2)stop.abort();return {accepted:true}},
      async command(type){if(type==="worker.poll")return {executionEnabled:false,assignments:[]};throw Error("Unexpected command")}};
    await runWorker({identityPath:join(home,"unused.json"),stateDir:home,installDir:models,policy,connection,
      adapter:syntheticAdapter(entry,policy),telemetry:ready,timings,signal:AbortSignal.any([stop.signal,AbortSignal.timeout(5000)])});
    assert.deepEqual(published.slice(0,2),["3.999999","3.999999"]);
    const restartStop=new AbortController(),afterRestart=[];
    await setWorkerControl(home,"run");
    await runWorker({identityPath:join(home,"unused.json"),stateDir:home,installDir:models,policy,
      connection:{...connection,async offer(value){afterRestart.push(value.netUnits);restartStop.abort();return {accepted:true}}},
      adapter:syntheticAdapter(entry,policy),telemetry:ready,timings,signal:AbortSignal.any([restartStop.signal,AbortSignal.timeout(5000)])});
    assert.equal(afterRestart[0],"3.999999","the durable last ask prevents a fresh process from undercutting itself");
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}));

test("the worker lists memory estimates separately from execution profiles and explains import", async () => temporary(async dir => {
  const home = join(dir, "worker"), models = join(dir, "ai"), listed = json(home, models, "models");
  assert.equal(listed.models.length, 17);
  assert.deepEqual([...listed.fitsThisComputer, ...listed.tooLargeForThisComputer], listed.models.map(item => item.id), "fitting models come first");
  for (const item of listed.models) assert.equal(item.fits === "no", listed.tooLargeForThisComputer.includes(item.id));
  const guide = json(home, models, "guide");
  assert.deepEqual(guide.models.fitsThisComputer, listed.fitsThisComputer);
  assert.match(guide.steps.find(step => step.step === "choose-model").note, /models meet the memory-size estimate/);
  const usage = cli(home, models, "import", "gpt-oss-20b", join(dir, "missing.gguf"));
  assert.notEqual(usage.status, 0); assert.match(usage.stderr, /--accept-licenses/);
  const missing = cli(home, models, "import", "gpt-oss-20b", join(dir, "missing.gguf"), "--accept-licenses");
  assert.notEqual(missing.status, 0); assert.match(missing.stderr, /IMPORT_FILE_NOT_FOUND/);
}));

test("Windows image CUDA selection requires explicit budgets and retains pending evidence", () => temporary(async dir => {
  const home=join(dir,"state"),models=join(dir,"models");
  const before=jsonOnPlatform("win32",home,models,"policy").policy;
  await writeWorkerPolicy(home,{...before,maxGpuMemoryMb:2048});
  const low=jsonOnPlatform("win32",home,models,"policy").policy;
  const refused=cliOnPlatform("win32",home,models,"use","sd-turbo","--gpu");
  assert.notEqual(refused.status,0);assert.match(refused.stderr,/MODEL_RESOURCE_BUDGET_REQUIRED/);
  assert.deepEqual(jsonOnPlatform("win32",home,models,"policy").policy,low);
  await writeWorkerPolicy(home,{...before,maxMemoryMb:8192,maxGpuMemoryMb:6144});
  const selected=jsonOnPlatform("win32",home,models,"use","sd-turbo","--gpu");
  assert.equal(selected.policy.backend,"cuda");assert.equal(selected.kind,"image");
  assert.equal(selected.executionProfile.verification,"pending_hardware_evidence");
  const plan=jsonOnPlatform("win32",home,models,"model-plan","sd-turbo","--gpu");
  assert.equal(plan.installationAvailability.planAvailable,true);assert.equal(plan.executionProfile.selectable,true);
}));

test("Windows media CPU routes retain explicit task and resource policies", () => temporary(async dir => {
  const home=join(dir,"state"),models=join(dir,"models");
  const before=jsonOnPlatform("win32",home,models,"policy").policy;
  const refused=cliOnPlatform("win32",home,models,"use","qwen3-embedding-0.6b","--cpu");
  assert.notEqual(refused.status,0);assert.match(refused.stderr,/MODEL_RESOURCE_BUDGET_REQUIRED/);
  assert.deepEqual(jsonOnPlatform("win32",home,models,"policy").policy,before);
  await writeWorkerPolicy(home,{...before,maxMemoryMb:8192,runSeconds:300});
  for(const [id,kind] of [["qwen3-embedding-0.6b","embedding"],["qwen3-asr-0.6b","transcription"],["sd-turbo","image"]]){
    const selected=jsonOnPlatform("win32",home,models,"use",id,"--cpu");
    assert.equal(selected.policy.model,id);assert.equal(selected.policy.backend,"cpu");assert.equal(selected.kind,kind);
    assert.equal(selected.executionProfile.implementation,"implemented");
    assert.equal(selected.executionProfile.verification,"not_established_by_catalogue_inventory");
  }
}));
