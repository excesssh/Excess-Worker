import { writeFile } from 'node:fs/promises';
import { MODEL_CATALOG, MEDIA_CATALOG, PLATFORM_BACKENDS } from '../packages/adapters/dist/manifest.js';
import { assertPublicBytes } from './public-worker/privacy.mjs';

export function catalogueInventory() {
  return [...MODEL_CATALOG, ...MEDIA_CATALOG].map(entry => ({
    id: entry.id, name: entry.displayName, task: entry.kind ?? 'text', quantization: entry.quantization,
    downloadBytes: entry.artifacts.reduce((sum, item) => sum + item.bytes, 0),
    modelBytes: entry.artifacts.filter(item => !item.name.startsWith('licences/')).reduce((sum, item) => sum + item.bytes, 0),
    ramMiB: entry.minMemoryMb, vramMiB: entry.minVramMb, gpuOnly: entry.gpuOnly ?? false,
    licence: entry.info.licence, runtime: entry.capability.runtime, capabilityDigest: entry.capabilityDigest,
    backends: PLATFORM_BACKENDS, artifacts: entry.artifacts,
  }));
}
const inventory = catalogueInventory();
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(inventory, null, 2) + '\n');
if (process.argv.includes('--markdown')) {
  const gib = mib => Number((mib / 1024).toFixed(2));
  const table = ['| Model / CLI ID | Task | Quantization | Download GB | RAM GiB | VRAM GiB | Licence |',
    '| --- | --- | --- | ---: | ---: | ---: | --- |',
    ...inventory.map(row => `| ${row.name}<br>\`${row.id}\` | ${row.task} | ${row.quantization} | ${(row.downloadBytes / 1e9).toFixed(2)} | ${gib(row.ramMiB)}${row.gpuOnly ? ' (GPU required)' : ''} | ${gib(row.vramMiB)} | ${row.licence} |`)];
  process.stdout.write(table.join('\n') + '\n');
}
if (process.argv.includes('--write-inventory')) {
  const bytes = Buffer.from(JSON.stringify({ format: 1, source: 'packages/adapters/src/manifest.ts', models: inventory }, null, 2) + '\n');
  assertPublicBytes(bytes);
  await writeFile('evidence/model-catalogue-inventory.json', bytes);
}
