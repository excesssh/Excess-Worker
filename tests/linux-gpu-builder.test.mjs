import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('GPU helper embeds a reproducible sealed-preload payload with no install-time sidecar', {skip:process.platform!=='linux'||process.arch!=='x64'}, async()=>{
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const scratch=await mkdtemp(join(tmpdir(),'excess-gpu-builder-'));
  try {
    const outputs=[join(scratch,'first'),join(scratch,'second')];
    const runs=[];
    for(const output of outputs) {
      const result=spawnSync(process.execPath,[join(root,'scripts/public-worker/build-linux-gpu-sandbox.mjs'),output],
        {cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']});
      assert.equal(result.status,0,'the deterministic builder must complete with contained compiler output');
      const report=JSON.parse(result.stdout.trim());
      const helper=await readFile(join(output,'excess-gpu-sandbox'));
      const pin=JSON.parse(await readFile(join(output,'integrity-gpu.json'),'utf8'));
      assert.equal(report.profile,'linux-cuda-device-budget-v2');
      assert.equal(pin.profile,report.profile);
      assert.equal(pin.sha256,createHash('sha256').update(helper).digest('hex'));
      assert.match(report.embeddedShimSha256,/^[a-f0-9]{64}$/);
      assert.deepEqual((await readdir(output)).sort(),['excess-gpu-sandbox','integrity-gpu.json']);
      runs.push({helper,pin});
    }
    assert.deepEqual(runs[0],runs[1],'same pinned source must produce byte-identical helper and pin');
  } finally {await rm(scratch,{recursive:true,force:true});}
});
