/** Worker updates from the exchange the device is paired with. The exchange publishes one pointer line per platform at
 * <origin>/downloads/latest-<platform>.txt (scripts/deploy/publish-worker.mjs); installing reuses that exchange's
 * one-line installer, which checks the archive's SHA-256 before unpacking beside the current version. */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface ReleasePointer { archive: string; sha256: string; bytes: number; version: string; folder: string }
export interface UpdateCheck { current: string | null; latest: string; available: boolean; checkedAt: string }

const SUFFIX = process.platform === "win32" ? "win-x64" : "linux-x64";

/** Parses one pointer line exactly as the installers do. */
export function parsePointer(text: string, suffix: string = SUFFIX): ReleasePointer {
  const parts = text.trim().split(/\s+/);
  const [archive = "", sha256 = "", bytes = "", version = "", folder = ""] = parts;
  const extension = suffix === "win-x64" ? "\\.zip" : "\\.tar\\.gz";
  if (parts.length !== 5 || !new RegExp(`^excess-worker-[A-Za-z0-9._-]+-${suffix}${extension}$`).test(archive) || !/^[0-9a-f]{64}$/.test(sha256) ||
    !/^[0-9]{1,12}$/.test(bytes) || !/^[A-Za-z0-9._+-]{1,64}$/.test(version) || !new RegExp(`^excess-worker-[A-Za-z0-9._-]+-${suffix}$`).test(folder))
    throw Error("The exchange's update pointer is not valid");
  return { archive, sha256, bytes: Number(bytes), version, folder };
}

/** This package's release ("<version>-<commit12>") from its manifest.json, or null outside a published package. */
export async function currentRelease(entry: string = process.argv[1] ?? ""): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readFile(resolve(dirname(entry), "..", "..", "..", "manifest.json"), "utf8")) as { version?: unknown; sourceCommit?: unknown };
    if (typeof manifest.version !== "string" || typeof manifest.sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(manifest.sourceCommit)) return null;
    return `${manifest.version}-${manifest.sourceCommit.slice(0, 12)}`;
  } catch { return null; }
}

export async function checkForUpdate(origin: string, current: string | null, fetcher: typeof fetch = fetch): Promise<UpdateCheck> {
  if (!/^https:\/\/[a-z0-9.-]+(:[0-9]+)?$/.test(origin)) throw Error("Updates need the https exchange this worker is paired with");
  const response = await fetcher(`${origin}/downloads/latest-${SUFFIX}.txt`, { redirect: "error", signal: AbortSignal.timeout(15000), cache: "no-store" });
  if (!response.ok) throw Error(`The exchange has no published worker (HTTP ${response.status})`);
  const latest = parsePointer((await response.text()).slice(0, 1024)).version;
  return { current, latest, available: current !== null && current !== latest, checkedAt: new Date().toISOString() };
}

/** Runs the exchange's installer for this platform and resolves with its exit code; its output goes to ours. */
export function runInstaller(origin: string, quiet = false): Promise<number> {
  const [command, args] = process.platform === "win32"
    ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "irm $env:EXCESS_ORIGIN/downloads/install.ps1 | iex"]]
    : ["sh", ["-c", 'curl -fsSL --proto "=https" --tlsv1.2 "$EXCESS_ORIGIN/downloads/install.sh" | sh']];
  return new Promise(done => {
    const child = spawn(command, args as string[], { env: { ...process.env, EXCESS_ORIGIN: origin }, stdio: ["ignore", quiet ? "ignore" : "inherit", quiet ? "ignore" : "inherit"], windowsHide: true });
    child.on("error", () => done(127));
    child.on("close", code => done(code ?? 1));
  });
}

/** Auto-update only where something restarts the worker afterwards: a Linux systemd service (systemd sets INVOCATION_ID). */
export const supervisedBySystemd = () => process.platform === "linux" && typeof process.env.INVOCATION_ID === "string" && process.env.INVOCATION_ID.length > 0;
/** Exit code after installing an update: nonzero, so Restart=on-failure starts the new version. */
export const UPDATED_EXIT_CODE = 75;
