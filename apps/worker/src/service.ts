/** `excess-worker service install|remove|status` on Linux: keeps the worker running as a systemd *user* service.
 * A system service cannot do this on Fedora and other SELinux systems: on a Fedora 44 droplet (19 September 2026)
 * systemd refused to execute the worker from the supplier's home directory ("Permission denied", status 203/EXEC),
 * while the same command as a user service ran and served a paid job. User services also need no root, except for
 * lingering, which keeps the service running after logout and starts it at boot. */
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
const execute = promisify(execFile);

export const SERVICE_NAME = "excess-worker.service";

/** The unit file. `drain` and `stop-now` end `run` cleanly, and a clean exit is not restarted. */
export function userUnit(launcher: string): string {
  if (!/^\/[^\n"\\$%`]+$/.test(launcher)) throw Error("The worker launcher path cannot be written into a unit file");
  const memoryMb = Math.max(256, Math.min(12288, Math.floor(os.totalmem() * 0.75 / 1048576)));
  return ["[Unit]", "Description=EXCESS supplier worker", "Wants=network-online.target", "After=network-online.target", "",
    "[Service]", `ExecStart="${launcher}" run`, "Restart=on-failure", "RestartSec=15",
    `MemoryMax=${memoryMb}M`, "MemorySwapMax=0", "TasksMax=128", "CPUQuota=200%",
    "KillMode=control-group", "TimeoutStopSec=15", "OOMPolicy=stop", "", "[Install]", "WantedBy=default.target", ""].join("\n");
}

/** The installer's wrapper when present, so the service follows upgrades; otherwise this package's own launcher. */
export async function launcherPath(entry: string = process.argv[1] ?? ""): Promise<string> {
  const data = process.env.XDG_DATA_HOME || join(os.homedir(), ".local", "share");
  const root = resolve(process.env.EXCESS_INSTALL_ROOT ?? join(data, "excess"));
  const wrapper = join(root, "bin", "excess-worker");
  try { await access(wrapper); return wrapper; } catch { /* a manual unpack has no wrapper */ }
  return resolve(dirname(entry), "..", "..", "..", "excess-worker");
}

const unitPath = () => join(process.env.XDG_CONFIG_HOME || join(os.homedir(), ".config"), "systemd", "user", SERVICE_NAME);
async function systemctl(...args: string[]): Promise<{ ok: boolean; output: string }> {
  try { const { stdout } = await execute("systemctl", ["--user", ...args], { timeout: 20000, maxBuffer: 65536 }); return { ok: true, output: stdout.trim() }; }
  catch (error) { const failure = error as { stdout?: string; stderr?: string }; return { ok: false, output: (failure.stdout || failure.stderr || "").trim() }; }
}
async function lingering(): Promise<boolean | null> {
  try {
    const { stdout } = await execute("loginctl", ["show-user", os.userInfo().username, "-p", "Linger", "--value"], { timeout: 10000 });
    return stdout.trim() === "yes";
  } catch { return null; }
}
const lingerNote = (linger: boolean | null) => linger === true ? null
  : `So the worker keeps running after you log out and starts at boot, run once: sudo loginctl enable-linger ${os.userInfo().username}`;

export async function workerService(action: string | undefined) {
  if (process.platform !== "linux") throw Error("service is for Linux. On Windows, see Headless Windows servers in the worker documentation.");
  const unit = unitPath();
  if (action === "install") {
    const launcher = await launcherPath();
    await mkdir(dirname(unit), { recursive: true });
    await writeFile(unit, userUnit(launcher), { mode: 0o644 });
    const reload = await systemctl("daemon-reload"), enable = reload.ok ? await systemctl("enable", "--now", SERVICE_NAME) : reload;
    const linger = await lingering();
    return { product: "EXCESS", service: SERVICE_NAME, unit, launcher, started: enable.ok,
      ...(enable.ok ? {} : { error: enable.output || "systemctl --user is not available in this session",
        next: `Log in as this user directly (not through su) and run: systemctl --user daemon-reload && systemctl --user enable --now ${SERVICE_NAME}` }),
      linger, ...(lingerNote(linger) ? { note: lingerNote(linger) } : {}),
      logs: `journalctl --user -u ${SERVICE_NAME} -f` };
  }
  if (action === "remove") {
    const disable = await systemctl("disable", "--now", SERVICE_NAME);
    await rm(unit, { force: true });
    await systemctl("daemon-reload");
    return { product: "EXCESS", service: SERVICE_NAME, removed: true, stopped: disable.ok };
  }
  if (action === "status" || action === undefined) {
    let installed = true;
    try { await access(unit); } catch { installed = false; }
    const active = await systemctl("is-active", SERVICE_NAME), enabled = await systemctl("is-enabled", SERVICE_NAME), linger = await lingering();
    return { product: "EXCESS", service: SERVICE_NAME, installed, active: active.output || "unknown", enabled: enabled.output || "unknown", linger,
      ...(lingerNote(linger) && installed ? { note: lingerNote(linger) } : {}) };
  }
  throw Error("Usage: worker service install | remove | status");
}
