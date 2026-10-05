import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { assertPublicBytes } from './privacy.mjs';

const PROFILE = 'linux-af-unix-peercred-v1';

async function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('EGRESS_PEER_BUILD_REQUIRES_LINUX_X64');
  const output = resolve(process.argv[2] ?? 'packages/adapters/native');
  await mkdir(output, { recursive: true });
  const target = resolve(output, 'excess-egress-peer');
  try {
    execFileSync('gcc', [
      '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fPIE', '-pie',
      '-fstack-protector-strong', '-D_FORTIFY_SOURCE=2', '-Wl,-z,relro,-z,now',
      '-s', '-ffile-prefix-map=' + process.cwd() + '=.',
      'native/linux/excess-egress-peer.c', '-o', target,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    await chmod(target, 0o755);
    const bytes = await readFile(target);
    assertPublicBytes(bytes);
    const pin = { profile: PROFILE, sha256: createHash('sha256').update(bytes).digest('hex') };
    const pinBytes = Buffer.from(JSON.stringify(pin) + '\n');
    assertPublicBytes(pinBytes);
    await writeFile(resolve(output, 'integrity-egress-peer.json'), pinBytes, { mode: 0o644 });
    console.log(JSON.stringify({ profile: PROFILE, sha256: pin.sha256, privacy: 'passed' }));
  } catch {
    throw new Error('EGRESS_PEER_BUILD_FAILED');
  }
}

main().catch(() => {
  console.error('EGRESS_PEER_BUILD_FAILED');
  process.exitCode = 1;
});
