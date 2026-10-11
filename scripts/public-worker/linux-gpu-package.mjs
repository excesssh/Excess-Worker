import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertPublicBytes } from './privacy.mjs';

export const LINUX_GPU_PROFILE = 'linux-cuda-device-budget-v2';
export const LINUX_GPU_HELPER = 'excess-gpu-sandbox';
export const LINUX_GPU_PIN = 'integrity-gpu.json';

export function requiresLinuxGpuSandbox(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return !!match && (Number(match[1]) > 0 || (Number(match[1]) === 0 && Number(match[2]) >= 2));
}

export async function readLinuxGpuSandbox(nativeRoot) {
  const helperPath = join(nativeRoot, LINUX_GPU_HELPER), pinPath = join(nativeRoot, LINUX_GPU_PIN);
  let helperInfo, pinInfo;
  try { helperInfo = await lstat(helperPath); pinInfo = await lstat(pinPath); }
  catch (error) {
    if (error?.code === 'ENOENT') throw Error('GPU_SANDBOX_BUILD_REQUIRED');
    throw error;
  }
  if (!helperInfo.isFile() || helperInfo.isSymbolicLink() || !pinInfo.isFile() || pinInfo.isSymbolicLink())
    throw Error('GPU_SANDBOX_INPUT_INVALID');
  const helper = await readFile(helperPath), pinBytes = await readFile(pinPath);
  assertPublicBytes(helper); assertPublicBytes(pinBytes);
  let pin;
  try { pin = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pinBytes)); }
  catch { throw Error('GPU_SANDBOX_INTEGRITY_INVALID'); }
  const hash = createHash('sha256').update(helper).digest('hex');
  if (!pin || typeof pin !== 'object' || Array.isArray(pin) || Object.keys(pin).sort().join(',') !== 'profile,sha256' ||
      pin.profile !== LINUX_GPU_PROFILE || pin.sha256 !== hash) throw Error('GPU_SANDBOX_INTEGRITY_INVALID');
  return { helper, pinBytes, profile: LINUX_GPU_PROFILE, sha256: hash };
}
