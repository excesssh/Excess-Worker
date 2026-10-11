import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertPublicBytes } from './privacy.mjs';

if (process.platform !== 'linux' || process.arch !== 'x64') throw Error('SANDBOX_BUILD_REQUIRES_LINUX_X64');
const output = resolve(process.argv[2] ?? 'packages/adapters/native');
const root = process.cwd();
const target = resolve(output, 'excess-gpu-sandbox');
const sourcePath = 'native/linux/excess-gpu-sandbox.c';
const shimPath = 'native/linux/cuda-threadname.c';
let source, shim;
try {
  source = await readFile(sourcePath); shim = await readFile(shimPath);
  assertPublicBytes(source); assertPublicBytes(shim);
} catch { throw Error('GPU_SANDBOX_SOURCE_INVALID'); }
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const byteHeader = bytes => {
  const rows = [];
  for (let at = 0; at < bytes.length; at += 16)
    rows.push('  ' + [...bytes.subarray(at, at + 16)].map(byte => `0x${byte.toString(16).padStart(2, '0')}`).join(', '));
  return '#ifndef EXCESS_CUDA_THREADNAME_BLOB_H\n#define EXCESS_CUDA_THREADNAME_BLOB_H\n' +
    'static const unsigned char excess_cuda_threadname_blob[] = {\n' + rows.join(',\n') + '\n};\n' +
    `static const unsigned long excess_cuda_threadname_blob_size = ${bytes.length}UL;\n#endif\n`;
};
const temporary = await mkdtemp(join(tmpdir(), 'excess-gpu-build-'));
try {
  const shimObject = join(temporary, 'threadname.so');
  const header = join(temporary, 'cuda-threadname-blob.h');
  execFileSync('gcc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fPIC', '-shared',
    '-fstack-protector-strong', '-D_FORTIFY_SOURCE=2', '-Wl,-z,relro,-z,now', '-Wl,--build-id=none',
    '-fno-ident', `-ffile-prefix-map=${root}=.`, shimPath, '-ldl', '-s', '-o', shimObject],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  const shimBytes = await readFile(shimObject); assertPublicBytes(shimBytes);
  await writeFile(header, byteHeader(shimBytes), { flag: 'w' });
  await mkdir(output, { recursive: true });
  execFileSync('gcc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-Wno-misleading-indentation',
    '-fPIE', '-pie', '-fstack-protector-strong', '-D_FORTIFY_SOURCE=2', '-Wl,-z,relro,-z,now',
    '-Wl,--build-id=none', '-s', '-ffile-prefix-map=' + root + '=.', '-I', temporary,
    sourcePath, '-ldl', '-o', target], { stdio: ['ignore', 'ignore', 'pipe'] });
  const bytes = await readFile(target); assertPublicBytes(bytes);
  const pin = { profile: 'linux-cuda-device-budget-v2', sha256: digest(bytes) };
  await writeFile(resolve(output, 'integrity-gpu.json'), JSON.stringify(pin) + '\n');
  console.log(JSON.stringify({ ...pin, sourceSha256: digest(source), shimSourceSha256: digest(shim), embeddedShimSha256: digest(shimBytes), privacy: 'passed' }));
} catch {
  throw Error('GPU_SANDBOX_BUILD_FAILED');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
