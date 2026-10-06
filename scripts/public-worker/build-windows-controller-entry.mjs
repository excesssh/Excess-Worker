import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, version } from 'esbuild';
import { assertPublicBytes } from './privacy.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const root = fileURLToPath(new URL('../../', import.meta.url));

/** ESM resolution needs directory access that the AppContainer deliberately
 * lacks. Bundle the fixed controller entry without expanding its ACL grants. */
export async function bundleWindowsControllerEntry() {
  if (version !== '0.28.2') throw Error('CONTROLLER_BUNDLE_TOOLCHAIN_INVALID');
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['apps/worker/dist/windows-controller-entry.js'],
    bundle: true, platform: 'node', format: 'esm', target: 'node24',
    sourcemap: false, write: false, metafile: true, logLevel: 'silent',
  });
  if (result.outputFiles.length !== 1) throw Error('CONTROLLER_BUNDLE_INVALID');
  const bytes = Buffer.from(result.outputFiles[0].contents);
  if (bytes.length < 1 || bytes.length > 2 * 1024 * 1024) throw Error('CONTROLLER_BUNDLE_LIMIT');
  assertPublicBytes(bytes);
  const inputs = [];
  for (const path of Object.keys(result.metafile.inputs).sort()) {
    const name = path.split(sep).join('/'), full = resolve(root, path), within = relative(root, full);
    if (isAbsolute(path) || within === '..' || within.startsWith('..' + sep) || isAbsolute(within)) throw Error('CONTROLLER_BUNDLE_INPUT_INVALID');
    assertPublicBytes(Buffer.from(name));
    const input = await readFile(full); assertPublicBytes(input);
    inputs.push({ path: name, sha256: sha256(input) });
  }
  // Every surviving runtime import must be a built-in; no package or relative
  // resolution may be delegated to the confined Node process.
  for (const output of Object.values(result.metafile.outputs)) {
    if (output.imports.some(item => !item.external || !item.path.startsWith('node:'))) throw Error('CONTROLLER_BUNDLE_EXTERNAL_INVALID');
  }
  return { bytes, metadata: { builder: 'esbuild', version, inputs, bytes: bytes.length, sha256: sha256(bytes) } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) throw Error('Usage: build-windows-controller-entry.mjs <existing-output-directory>');
  assertPublicBytes(Buffer.from(resolve(target)));
  const result = await bundleWindowsControllerEntry();
  await writeFile(resolve(target, 'windows-controller-entry.js'), result.bytes);
  await writeFile(resolve(target, 'controller-bundle-inputs.json'), JSON.stringify(result.metadata, null, 2) + '\n');
  console.log(JSON.stringify({ bytes: result.bytes.length, sha256: result.metadata.sha256, inputs: result.metadata.inputs.length }));
}
