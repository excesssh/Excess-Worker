import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { assertIdentifierFree, assertPublicBytes } from './privacy.mjs';

const pins = {
  'win32-x64': { version: 'v24.11.1', file: 'node-v24.11.1-win-x64.zip', sha256: '5355ae6d7c49eddcfde7d34ac3486820600a831bf81dc3bdca5c8db6a9bb0e76' },
  'linux-x64': { version: 'v24.11.1', file: 'node-v24.11.1-linux-x64.tar.gz', sha256: '58a5ff5cc8f2200e458bea22e329d5c1994aa1b111d499ca46ec2411d58239ca' },
};

/** Inspect authenticated official archives in memory; persist only the selected binary and required licence. */
export async function nodeRuntime(root, platform) {
  const pin = pins[platform]; if (!pin) throw Error('NODE_PLATFORM_UNSUPPORTED');
  let archive = await readFile(join(root, '.cache/node', pin.file)).catch(() => null);
  if (!archive || createHash('sha256').update(archive).digest('hex') !== pin.sha256) {
    const response = await fetch(`https://nodejs.org/dist/${pin.version}/${pin.file}`, { redirect: 'error', signal: AbortSignal.timeout(120000) });
    if (!response.ok || !response.body) throw Error('NODE_DOWNLOAD_FAILED');
    const reader = response.body.getReader(), chunks = []; let total = 0;
    try {
      for (;;) { const next = await reader.read(); if (next.done) break;
        total += next.value.length; if (total > 128 * 1024 * 1024) throw Error('NODE_DOWNLOAD_TOO_LARGE'); chunks.push(next.value); }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; } finally { reader.releaseLock(); }
    archive = Buffer.concat(chunks, total);
  }
  if (createHash('sha256').update(archive).digest('hex') !== pin.sha256) throw Error('NODE_HASH_MISMATCH');
  assertIdentifierFree(archive);
  const top = pin.file.replace(/\.(zip|tar\.gz)$/, ''), binary = top + (platform === 'linux-x64' ? '/bin/node' : '/node.exe');
  const selected = new Map();
  const accept = (name, data) => { assertIdentifierFree(Buffer.from(name)); assertIdentifierFree(data);
    if (name === binary || name === top + '/LICENSE') { assertPublicBytes(data); if (selected.has(name)) throw Error('NODE_DUPLICATE_ENTRY'); selected.set(name, data); } };
  if (platform === 'linux-x64') {
    const tar = gunzipSync(archive, { maxOutputLength: 1024 * 1024 * 1024 }); assertIdentifierFree(tar);
    const text = (at, n) => tar.subarray(at, at + n).toString().split('\0')[0];
    for (let at = 0; at + 512 <= tar.length;) {
      if (tar.subarray(at, at + 512).every(byte => !byte)) break;
      const size = parseInt(text(at + 124, 12).trim(), 8), next = at + 512 + Math.ceil(size / 512) * 512;
      if (!Number.isSafeInteger(size) || size < 0 || next > tar.length) throw Error('NODE_ARCHIVE_INVALID');
      const prefix = text(at + 345, 155), name = (prefix ? prefix + '/' : '') + text(at, 100);
      if (tar[at + 156] === 48 || tar[at + 156] === 0) accept(name, Buffer.from(tar.subarray(at + 512, at + 512 + size)));
      at = next;
    }
  } else {
    let end = -1;
    for (let at = archive.length - 22; at >= Math.max(0, archive.length - 65557); at--) if (archive.readUInt32LE(at) === 0x06054b50) { end = at; break; }
    if (end < 0) throw Error('NODE_ARCHIVE_INVALID');
    const count = archive.readUInt16LE(end + 10); let at = archive.readUInt32LE(end + 16), total = 0;
    if (count > 10000) throw Error('NODE_ARCHIVE_INVALID');
    for (let n = 0; n < count; n++) {
      if (at + 46 > end || archive.readUInt32LE(at) !== 0x02014b50) throw Error('NODE_ARCHIVE_INVALID');
      const method = archive.readUInt16LE(at + 10), compressed = archive.readUInt32LE(at + 20), expanded = archive.readUInt32LE(at + 24);
      const length = archive.readUInt16LE(at + 28), extra = archive.readUInt16LE(at + 30), comment = archive.readUInt16LE(at + 32), local = archive.readUInt32LE(at + 42);
      const name = archive.subarray(at + 46, at + 46 + length).toString();
      if (local + 30 > at || archive.readUInt32LE(local) !== 0x04034b50 || ![0, 8].includes(method)) throw Error('NODE_ARCHIVE_INVALID');
      const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
      if (start + compressed > at || expanded > 128 * 1024 * 1024 || (total += expanded) > 1024 * 1024 * 1024) throw Error('NODE_ARCHIVE_INVALID');
      const data = method === 0 ? Buffer.from(archive.subarray(start, start + compressed)) : inflateRawSync(archive.subarray(start, start + compressed), { maxOutputLength: Math.max(1, expanded) });
      if (data.length !== expanded) throw Error('NODE_ARCHIVE_INVALID'); accept(name, data);
      at += 46 + length + extra + comment;
    }
  }
  if (!selected.has(binary) || !selected.has(top + '/LICENSE')) throw Error('NODE_ARCHIVE_INPUT_MISSING');
  return { version: pin.version, binary: selected.get(binary), license: selected.get(top + '/LICENSE'), archiveSha256: pin.sha256 };
}
