import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

// The official v24.11.1 Linux x64 binary in the pinned Node archive.
const NODE_SHA256 = "5796fd9700e83170bc7ddfdf7f18858c794a9f91cb39dd6f9e95060b292f2563";
const MAX_FILES = 4096;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const required = ["node/bin/node", "app/worker/dist/controller-entry.js",
  "app/node_modules/@excess/adapters/native/excess-controller",
  "app/node_modules/@excess/adapters/native/integrity-controller.json",
  "app/node_modules/@excess/adapters/native/excess-egress-peer",
  "app/node_modules/@excess/adapters/native/integrity-egress-peer.json"];

/** Installation authenticates the complete archive. Before execution, require
 * its exact checksum inventory again and the separately pinned Node binary.
 * A controller only receives this package through a read-only mount. */
export async function verifyControllerPackage(packageDir: string): Promise<void> {
  try {
    const root = resolve(packageDir);
    const inventory = await open(join(root, "SHA256SUMS.txt"), constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try {
      const info = await inventory.stat();
      if (!info.isFile() || info.size < 1 || info.size > 1024 * 1024 || (info.uid !== 0 && info.uid !== process.getuid?.()) || (info.mode & 0o022)) throw Error("inventory");
      text = await inventory.readFile("utf8");
    } finally { await inventory.close(); }
    const expected = new Map<string, string>();
    if (!text.endsWith("\n")) throw Error("inventory");
    for (const row of text.slice(0, -1).split("\n")) {
      const match = /^([a-f0-9]{64})  ([A-Za-z0-9_@+./-]+)$/.exec(row);
      if (!match || match[2]!.startsWith("/") || match[2]!.split("/").some(p => !p || p === "." || p === "..") ||
          match[2] === "SHA256SUMS.txt" || expected.has(match[2]!) || expected.size >= MAX_FILES) throw Error("inventory");
      expected.set(match[2]!, match[1]!);
    }
    if (required.some(name => !expected.has(name)) || expected.get("node/bin/node") !== NODE_SHA256) throw Error("required");
    let total = 0, seen = 0, directories = 0;
    async function visit(directory: string, depth = 0): Promise<void> {
      if (++directories > MAX_FILES * 2 || depth > 32) throw Error("directory");
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.uid !== 0 && info.uid !== process.getuid?.()) || (info.mode & 0o022)) throw Error("directory");
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) { await visit(file, depth + 1); continue; }
        const name = relative(root, file).split(sep).join("/");
        if (name === "SHA256SUMS.txt") continue;
        if (!entry.isFile() || !expected.has(name) || ++seen > MAX_FILES) throw Error("file");
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const metadata = await handle.stat();
          if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES || (metadata.uid !== 0 && metadata.uid !== process.getuid?.()) ||
              (metadata.mode & 0o022) || (total += metadata.size) > MAX_TOTAL_BYTES) throw Error("file");
          const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
          let bytes = 0;
          for (;;) {
            const result = await handle.read(buffer, 0, buffer.length, null);
            if (!result.bytesRead) break;
            if ((bytes += result.bytesRead) > metadata.size) throw Error("changed");
            hash.update(buffer.subarray(0, result.bytesRead));
          }
          if (bytes !== metadata.size || hash.digest("hex") !== expected.get(name)) throw Error("hash");
        } finally { await handle.close(); }
      }
    }
    await visit(root);
    if (seen !== expected.size) throw Error("coverage");
  } catch { throw Error("CONTROLLER_PACKAGE_INTEGRITY_INVALID"); }
}
