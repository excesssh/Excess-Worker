import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { assertPublicBytes } from './privacy.mjs';
if (process.platform !== 'linux' || process.arch !== 'x64') throw Error('CONTROLLER_BUILD_REQUIRES_LINUX_X64');
const output = resolve(process.argv[2] ?? 'packages/adapters/native');
await mkdir(output, { recursive: true });
const source = await readFile('native/linux/excess-controller.c');
assertPublicBytes(source);
const target = resolve(output, 'excess-controller');
execFileSync('gcc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fPIE', '-pie',
  '-fstack-protector-strong', '-D_FORTIFY_SOURCE=2', '-Wl,-z,relro,-z,now', '-s',
  '-ffile-prefix-map=' + process.cwd() + '=.', 'native/linux/excess-controller.c', '-o', target],
{ stdio: ['ignore', 'ignore', 'pipe'] });
const bytes = await readFile(target); assertPublicBytes(bytes);
const pin = { profile: 'linux-controller-namespaces-v1', sha256: createHash('sha256').update(bytes).digest('hex') };
await writeFile(resolve(output, 'integrity-controller.json'), JSON.stringify(pin) + '\n');
console.log(JSON.stringify({ profile: pin.profile, sha256: pin.sha256, sourceSha256: createHash('sha256').update(source).digest('hex'), privacy: 'passed' }));
