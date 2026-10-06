import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('CONTROLLER_BUILD_REQUIRES_WINDOWS_X64');
const output = resolve(process.argv[2] ?? 'packages/adapters/native');
const toolchain = resolve(process.argv[3] ?? '.cache/native-toolchain/windows');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const { assertPublicBytes } = await import(pathToFileURL(resolve('scripts/public-worker/privacy.mjs')));
const inventoryHash = '051d04fab3d3756d47d766b01e009fab3000445134d4db909bc0a034e71ac3bd';
const inventoryBytes = await readFile(join(toolchain, 'inputs.json'));
if (hash(inventoryBytes) !== inventoryHash) throw Error('NATIVE_TOOLCHAIN_INVENTORY_MISMATCH');
const inventory = JSON.parse(inventoryBytes.toString('utf8'));
for (const entry of inventory.files) {
  const target = resolve(toolchain, entry.file), rel = relative(toolchain, target);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw Error('NATIVE_TOOLCHAIN_PATH_DENIED');
  const bytes = await readFile(target);
  if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw Error('NATIVE_TOOLCHAIN_INPUT_MISMATCH');
  assertPublicBytes(bytes);
}
const source = await readFile('native/windows/ExcessController.cs');
assertPublicBytes(source);
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(output, '.controller-build-'));
let compileFailed = false;
try {
  await writeFile(join(scratch, 'source.cs'), source, { flag: 'wx' });
  const compiler = join(toolchain, 'microsoft.net.compilers.toolset/tasks/net472/csc.exe');
  const referenceRoot = join(toolchain, 'microsoft.netframework.referenceassemblies.net48/build/.NETFramework/v4.8');
  const references = ['mscorlib.dll', 'System.dll', 'System.Core.dll', 'System.Web.dll', 'System.Web.Extensions.dll', 'System.Xml.dll', 'System.Data.dll'];
  const args = ['/nologo', '/noconfig', '/nostdlib+', '/target:exe', '/platform:x64', '/optimize+', '/debug-', '/deterministic+',
    '/langversion:5', '/codepage:65001', '/preferreduilang:en-US', '/utf8output',
    '/pathmap:' + scratch + '=/src/excess-controller,' + toolchain + '=/build-tools', '/out:ExcessController.exe',
    ...references.map(name => '/reference:' + join(referenceRoot, name)), 'source.cs'];
  try {
    execFileSync(compiler, args, { cwd: scratch, windowsHide: true,
      env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', WINDIR: process.env.WINDIR ?? 'C:\\Windows', TEMP: scratch, TMP: scratch },
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 65536, timeout: 60000 });
  } catch (error) {
    const text = Buffer.concat([Buffer.from(error.stdout ?? ''), Buffer.from(error.stderr ?? '')]).toString('utf8');
    const errors = [...text.matchAll(/source\.cs\((\d+),(\d+)\): error (CS\d+)\b/g)].map(match => ({ line: Number(match[1]), column: Number(match[2]), code: match[3] }));
    console.log(JSON.stringify({ compileErrors: errors }));
    compileFailed = true;
  }
  if (compileFailed) { process.exitCode = 1; }
  else {
  const binary = await readFile(join(scratch, 'ExcessController.exe'));
  assertPublicBytes(binary);
  const pin = { profile: 'windows-appcontainer-controller-v1', sha256: hash(binary), sourceSha256: hash(source),
    toolchainInventorySha256: inventoryHash, compiler: 'Microsoft.Net.Compilers.Toolset 4.14.0',
    references: 'Microsoft.NETFramework.ReferenceAssemblies.net48 1.0.3', deterministic: true, debugSymbols: false };
  await writeFile(join(output, 'ExcessController.exe'), binary);
  await writeFile(join(output, 'integrity-controller-win32.json'), JSON.stringify(pin) + '\n');
  console.log(JSON.stringify({ profile: pin.profile, sha256: pin.sha256, sourceSha256: pin.sourceSha256,
    toolchainInventorySha256: inventoryHash, privacy: 'passed' }));
  }
} finally {
  if (dirname(scratch) !== output || !scratch.startsWith(join(output, '.controller-build-'))) throw Error('NATIVE_BUILD_CLEANUP_BOUNDARY_DENIED');
  await rm(scratch, { recursive: true, force: true });
}
