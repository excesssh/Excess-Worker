import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { servedModels } from "../apps/worker/src/served.ts";
import { executionProfile, largestSelectableTextModel, modelExecutionProfiles, modelFit, modelPlanStatus, modelsByFit, modelsBySelectableFit } from "../apps/worker/src/hardware.ts";

const windowsHardware = { memoryMb: 8192, gpus: [{ name: "synthetic Windows GPU", memoryMb: 65536 }] };
const byId = (models, id) => models.find(item => item.entry.id === id);

test("all catalogue rows keep their legacy memory estimate while execution profiles stay separate", () => {
  const models = servedModels();
  assert.equal(models.length, 17, "all catalogue rows remain visible");
  const rated = modelsByFit(models, windowsHardware);
  assert.equal(rated.length, 17);
  for (const { entry, fit } of rated) {
    assert.deepEqual(Object.keys(fit).sort(), ["cpu", "fits", "gpu"], "legacy fit keys remain unchanged");
    assert.equal(fit.cpu.needsMemoryMb, entry.minMemoryMb);
    assert.equal(fit.gpu.needsGpuMemoryMb, entry.minVramMb);
    assert.equal(fit.fits, modelFit(entry, windowsHardware).fits);
    assert.deepEqual(Object.keys(modelExecutionProfiles(entry, "win32")).sort(), ["cpu", "cuda", "vulkan"]);
  }
});

test("Windows 48/64 GiB memory-fit estimates do not make larger CUDA models selectable", () => {
  const models = servedModels();
  for (const gpuMb of [49152, 65536]) {
    const hardware = { memoryMb: 8192, gpus: [{ name: "synthetic Windows GPU", memoryMb: gpuMb }] };
    const rated = modelsByFit(models, hardware);
    const qwen8 = byId(rated, "qwen3-8b");
    assert.equal(qwen8.fit.gpu.fits, true, `VRAM estimate fits the synthetic ${gpuMb / 1024} GiB device`);
    assert.equal(executionProfile(qwen8.entry, "cuda", "win32").selectable, false, "Windows CUDA selection remains restricted to Qwen3 4B");
    assert.equal(executionProfile(qwen8.entry, "cuda", "win32").maximumGpuMemoryMb, 32768);

    const chosen = modelsBySelectableFit(models, hardware, "win32");
    assert.equal(byId(chosen, "qwen3-8b"), undefined, "unsupported CUDA-only memory fit is excluded from guide recommendations");
    const recommendation = largestSelectableTextModel(models, hardware, "win32");
    assert.notEqual(recommendation?.entry.id, "qwen3-8b", "the unsupported GPU-only memory fit is never recommended");
    assert.equal(recommendation?.executionProfile.selectable, true);
    assert.ok(recommendation?.executionProfile.backend === "cpu" ? recommendation.fit.cpu.fits : recommendation.fit.gpu.fits,
      "the recommendation must have a fitting estimate for its selectable backend");
  }

  const qwen4 = modelExecutionProfiles(models.find(entry => entry.id === "qwen3-4b"), "win32").cuda;
  assert.equal(qwen4.selectable, true);
  assert.equal(qwen4.verification, "verified_on_recorded_configuration");
  assert.equal(qwen4.maximumGpuMemoryMb, 32768);

  const smallGpu = { memoryMb: 4096, gpus: [{ name: "synthetic small Windows GPU", memoryMb: 4096 }] };
  const smallRated = modelsByFit(models, smallGpu);
  assert.equal(byId(smallRated, "qwen3-4b").fit.gpu.fits, true, "legacy model VRAM estimate remains unchanged");
  assert.equal(byId(modelsBySelectableFit(models, smallGpu, "win32"), "qwen3-4b"), undefined,
    "the Windows profile's 6 GiB minimum resource budget is enforced by recommendations");
});

test("Linux CUDA is selectable in the candidate while hardware verification remains pending", () => {
  const qwen8 = servedModels().find(entry => entry.id === "qwen3-8b");
  const cuda = executionProfile(qwen8, "cuda", "linux");
  assert.equal(cuda.selectable, true);
  assert.equal(cuda.implementation, "implemented");
  assert.equal(cuda.verification, "pending_hardware_evidence");
  assert.equal(cuda.maximumGpuMemoryMb, 131072);
  assert.match(cuda.note, /hardware verification is pending/);
  assert.match(cuda.note, /published 0\.1\.0 Linux archive remains CPU-only/);
});

test("model-plan keeps installation availability separate from execution support", () => {
  const qwen8 = servedModels().find(entry => entry.id === "qwen3-8b");
  const status = modelPlanStatus(qwen8, "cuda", "win32", true, true);
  assert.deepEqual(status.installationAvailability, { planAvailable: true, requiresExplicitConsent: true, disk: "sufficient" });
  assert.equal(status.executionProfile.selectable, false);
  assert.equal(status.executionProfile.implementation, "unsupported");
  const linux = modelPlanStatus(qwen8, "cuda", "linux", true, null);
  assert.equal(linux.installationAvailability.disk, "unknown");
  assert.equal(linux.installationAvailability.planAvailable, true);
  assert.equal(linux.executionProfile.selectable, true);
  assert.equal(linux.executionProfile.verification, "pending_hardware_evidence");
});

test("CLI and guide use the named memory estimate and selectable-profile fields", async () => {
  const [main, guide] = await Promise.all([
    readFile(new URL("../apps/worker/src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../apps/worker/src/guide.ts", import.meta.url), "utf8"),
  ]);
  assert.match(main, /memoryFitEstimate/);
  assert.match(main, /executionProfiles/);
  assert.match(main, /modelPlanStatus/);
  assert.match(guide, /modelsBySelectableFit/);
  assert.match(guide, /largestSelectableTextModel/);
  assert.match(guide, /memory-size estimate/);
});

test("a selectable GPU profile also needs its host-memory budget and operating-system boundary", () => {
  const qwen4 = servedModels().find(entry => entry.id === "qwen3-4b");
  const lowHost = { memoryMb: 7168, gpus: [{ name: "synthetic sufficient GPU", memoryMb: 8192 }] };
  assert.equal(modelFit(qwen4, lowHost).gpu.fits, true);
  assert.notEqual(byId(modelsBySelectableFit([qwen4], lowHost, "win32"), "qwen3-4b")?.executionProfile.backend, "cuda",
    "VRAM alone cannot satisfy the separate 6 GiB host budget plus system reserve");
  const sufficient = { ...lowHost, memoryMb: 8192 };
  assert.equal(byId(modelsBySelectableFit([qwen4], sufficient, "win32"), "qwen3-4b").executionProfile.backend, "cuda");
  assert.equal(executionProfile(qwen4, "cuda", "win32").evidenceRelease, "0.1.0",
    "recorded verification identifies the published release rather than approving a changed payload");
  const all = servedModels();
  assert.equal(modelsByFit(all, windowsHardware).length, 17);
  assert.equal(modelsBySelectableFit(all, windowsHardware, "darwin").length, 0);
  for (const profile of Object.values(modelExecutionProfiles(qwen4, "darwin"))) {
    assert.equal(profile.selectable, false);
    assert.equal(profile.implementation, "unsupported");
    assert.equal(profile.verification, "not_applicable");
  }
});

test("Windows media catalogue and plans remain visible while paired-worker profiles are refused", () => {
  const all=servedModels(),media=all.filter(entry=>entry.kind!=="text");
  assert.equal(media.length,4);
  assert.equal(modelsByFit(all,windowsHardware).length,17);
  for(const entry of media){
    for(const backend of ["cpu","cuda","vulkan"]){
      const profile=executionProfile(entry,backend,"win32");
      assert.equal(profile.selectable,false);
      assert.equal(profile.implementation,"unsupported");
      assert.match(profile.note,/Windows paired-worker controller refuses media tasks/);
      assert.equal(modelPlanStatus(entry,backend,"win32",true,true).installationAvailability.planAvailable,true);
    }
    assert.equal(executionProfile(entry,"cpu","linux").selectable,!entry.gpuOnly);
    assert.equal(executionProfile(entry,"cuda","linux").verification,"pending_hardware_evidence");
  }
});
