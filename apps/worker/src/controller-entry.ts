import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runWorker } from "./runtime.js";
import { createWorkerConnection } from "./identity.js";
import { createCoordinatorEgressTransport } from "./egress-transport.js";
import { parseCoordinatorOrigin } from "./egress-policy.js";
import { observeLocalResources } from "./telemetry.js";
import { createControllerStateClient } from "./controller-state-client.js";
import { currentRelease } from "./update.js";

/** Fixed internal entry selected by the native namespace helper. This is not a
 * CLI switch or environment-selected alternative to the trusted bootstrap. */
try {
  if (process.platform !== "linux" || process.version !== "v24.11.1" || !process.getuid?.() ||
      resolve(process.execPath) !== "/app/node/bin/node" || resolve(process.argv[1] ?? "") !== "/app/app/worker/dist/controller-entry.js") throw Error("CONTROLLER_PROFILE_REQUIRED");
  const status = await readFile("/proc/self/status", "utf8");
  if (!/^NoNewPrivs:\s+1$/m.test(status) || !/^Seccomp:\s+2$/m.test(status) ||
      !/^CapEff:\s+0000000000000000$/m.test(status) || !/^CapPrm:\s+0000000000000000$/m.test(status)) throw Error("CONTROLLER_PROFILE_REQUIRED");
  const origin = parseCoordinatorOrigin(process.argv[2] ?? "").origin;
  const updateMode = process.argv[3];
  if (process.argv.length !== 4 || !["updates", "no-updates"].includes(updateMode ?? "")) throw Error("CONTROLLER_PROFILE_REQUIRED");
  const transport = createCoordinatorEgressTransport("/broker/socket", origin);
  const stateWriter = createControllerStateClient("/state-broker/socket");
  const connection = await createWorkerConnection("/state/identity.json", transport.fetch,
    { reserveHeartbeatSequence: () => stateWriter.nextHeartbeatSequence() });
  if (connection.origin !== origin) throw Error("CONTROLLER_ORIGIN_MISMATCH");
  const abort = new AbortController();
  process.once("SIGTERM", () => abort.abort()); process.once("SIGINT", () => abort.abort());
  // Updates run outside this readonly payload boundary under their separate
  // signature/high-water verifier; the controller never installs executable code.
  const result = await runWorker({ identityPath: "/state/identity.json", stateDir: "/state", installDir: "/ai",
    connection, fetcher: transport.fetch, stateWriter, telemetry: observeLocalResources, signal: abort.signal,
    ...(updateMode === "updates" ? { update: { origin, current: await currentRelease(), autoInstall: true,
      check: () => stateWriter.check(null), install: () => stateWriter.install() } } : {}) });
  process.stdout.write(JSON.stringify({ product: "EXCESS", ...result }) + "\n");
} catch {
  process.stderr.write("CONTROLLER_OPERATION_FAILED\n"); process.exitCode = 1;
}
