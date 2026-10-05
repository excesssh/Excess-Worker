import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { deflateRawSync, gzipSync, crc32 } from 'node:zlib';

async function entries(root, directory = root) {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw Error('ARCHIVE_LINK_REJECTED');
    if (entry.isDirectory()) result.push(...await entries(root, path));
    else if (entry.isFile()) result.push({ name: relative(root, path).split(sep).join('/'), data: await readFile(path) });
    else throw Error('ARCHIVE_SPECIAL_FILE_REJECTED');
  }
  return result.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** Fixed ordering, ownership, modes and timestamps; no builder paths or host metadata. */
export async function archiveDirectory(root, folder, destination, platform, epoch) {
  if (!Number.isSafeInteger(epoch) || epoch < 315532800 || epoch > 4354819199) throw Error('SOURCE_DATE_EPOCH_INVALID');
  const files = await entries(root);
  const output = platform === 'linux-x64' ? tar(files, folder, epoch) : zip(files, folder, epoch);
  await writeFile(destination, output);
  return (await stat(destination)).size;
}

function tar(files, folder, epoch) {
  const records = [];
  const executableFiles = new Set(['excess-worker', 'node/bin/node',
    ...['excess-sandbox', 'excess-controller', 'excess-egress-peer'].map(name => 'app/node_modules/@excess/adapters/native/' + name)]);
  for (const { name, data } of files) {
    const full = folder + '/' + name, header = Buffer.alloc(512);
    let leaf = full, prefix = '';
    if (Buffer.byteLength(leaf) > 100) {
      const split = full.lastIndexOf('/', 155);
      prefix = full.slice(0, split); leaf = full.slice(split + 1);
    }
    if (Buffer.byteLength(leaf) > 100 || Buffer.byteLength(prefix) > 155) throw Error('ARCHIVE_NAME_TOO_LONG');
    header.write(leaf, 0, 100); header.write(prefix, 345, 155);
    const octal = (offset, length, value) => header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
    octal(100, 8, executableFiles.has(name) ? 0o755 : 0o644);
    octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, data.length); octal(136, 12, epoch);
    header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257, 6); header.write('00', 263, 2);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    records.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  records.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(records), { level: 9, mtime: 0 });
}

function zip(files, folder, epoch) {
  const locals = [], central = []; let offset = 0;
  const date = new Date(epoch * 1000);
  const time = date.getUTCHours() << 11 | date.getUTCMinutes() << 5 | Math.floor(date.getUTCSeconds() / 2);
  const day = (date.getUTCFullYear() - 1980) << 9 | (date.getUTCMonth() + 1) << 5 | date.getUTCDate();
  for (const { name, data } of files) {
    const path = Buffer.from(folder + '/' + name), body = deflateRawSync(data, { level: 9 }), checksum = crc32(data);
    const local = Buffer.alloc(30), directory = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(day, 12); local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(path.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(8, 10); directory.writeUInt16LE(time, 12); directory.writeUInt16LE(day, 14);
    directory.writeUInt32LE(checksum, 16); directory.writeUInt32LE(body.length, 20); directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(path.length, 28); directory.writeUInt32LE((0o100644 * 65536) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    locals.push(local, path, body); central.push(directory, path); offset += local.length + path.length + body.length;
  }
  if (files.length > 65535) throw Error('ARCHIVE_TOO_MANY_FILES');
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
