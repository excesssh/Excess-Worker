import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { atomicPrivateJson } from "./control.js";
import { parseCoordinatorOrigin } from "./egress-policy.js";

function configPath(stateDir: string): string {
  const state = resolve(stateDir);
  const id = createHash("sha256").update(state).digest("hex");
  // Neither an absolute user path nor device key material is recorded in it.
  return join(dirname(state), ".excess-worker-controller", id + ".json");
}
async function checkParents(path: string): Promise<void> {
  const full = resolve(path), base = parse(full).root;
  let current = base;
  for (const part of relative(base, full).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw Error("CONTROLLER_CONFIG_INVALID");
  }
}
function fingerprint(key: string): string {
  if (typeof key !== "string" || !/^[A-Za-z0-9+/]{40,256}={0,2}$/.test(key)) throw Error("CONTROLLER_CONFIG_INVALID");
  return createHash("sha256").update(Buffer.from(key, "base64")).digest("hex");
}

/** Called only from explicit host setup/pairing, never inside the controller. */
export async function saveControllerOrigin(stateDir: string, origin: string, publicKey: string): Promise<void> {
  if (process.platform !== "linux" || !process.getuid?.()) throw Error("CONTROLLER_CONFIG_UNAVAILABLE");
  const configured = parseCoordinatorOrigin(origin).origin, file = configPath(stateDir), directory = dirname(file);
  await checkParents(dirname(directory));
  try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  await checkParents(directory);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) throw Error("CONTROLLER_CONFIG_INVALID");
  try { await checkParents(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await atomicPrivateJson(file, { format: 1, origin: configured, fingerprint: fingerprint(publicKey) });
  await chmod(file, 0o600);
}

/** Immutable-for-controller policy is stored outside the writable state mount. */
export async function configuredControllerOrigin(stateDir: string, identityOrigin: string, publicKey: string): Promise<string> {
  const file = configPath(stateDir);
  try {
    await checkParents(file);
    const directory = await lstat(dirname(file));
    if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077)) throw Error("invalid");
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size < 1 || info.size > 2048) throw Error("invalid");
      const value = JSON.parse(await handle.readFile("utf8")) as Record<string, unknown>;
      if (!value || Object.keys(value).sort().join(",") !== "fingerprint,format,origin" || value.format !== 1 ||
          value.origin !== identityOrigin || value.fingerprint !== fingerprint(publicKey)) throw Error("invalid");
      return parseCoordinatorOrigin(identityOrigin).origin;
    } finally { await handle.close(); }
  } catch { throw Error("CONTROLLER_SETUP_REQUIRED"); }
}
