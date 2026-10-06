import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWindowsControllerTransport } from "./windows-controller-transport.js";
import { createWindowsStateClient } from "./windows-controller-state.js";
import { createWindowsCoordinatorClient } from "./windows-controller-coordinator.js";
import { createWindowsTextAdapterClient } from "./windows-controller-adapter.js";
import { runWorker } from "./runtime.js";

// Internal package entry only. The native helper verifies this exact file and
// launches pinned Node in an AppContainer with inherited anonymous pipes.
let transport: ReturnType<typeof createWindowsControllerTransport> | undefined;
let state: ReturnType<typeof createWindowsStateClient> | undefined;
try {
  const entry = fileURLToPath(import.meta.url), packageDir = resolve(dirname(entry), "..", "..", "..");
  if (process.platform !== "win32" || process.arch !== "x64" || process.version !== "v24.11.1" || process.argv.length !== 2 ||
      resolve(process.argv[1] ?? "") !== entry || resolve(process.execPath) !== resolve(packageDir, "node", "node.exe") ||
      !process.stdin.readable || !process.stdout.writable || process.stdin.isTTY || process.stdout.isTTY) throw Error("CONTROLLER_PROFILE_REQUIRED");
  transport = createWindowsControllerTransport(process.stdin, process.stdout);
  const rpc = transport;
  state = createWindowsStateClient((payload, signal) => rpc.call("state", payload, signal));
  const coordinator = await createWindowsCoordinatorClient((payload, signal) => rpc.call("coordinator", payload, signal));
  const adapter = createWindowsTextAdapterClient((payload, signal) => rpc.call("adapter", payload, signal));
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort()); process.once("SIGTERM", () => abort.abort());
  // This virtual root only converts the runtime's fixed output names into typed
  // store selectors. No child filesystem read or write uses it.
  const virtualRoot = resolve(process.cwd(), "virtual-state");
  await runWorker({ identityPath: "unused", stateDir: virtualRoot, installDir: "unused", connection: coordinator.connection,
    adapter, stateReader: state.reader, stateWriter: state.writer, fetcher: coordinator.fetcher,
    telemetry: coordinator.telemetry, signal: abort.signal,
    update: { autoInstall: false, check: coordinator.checkForUpdate } });
  await state.close();
  await transport.finish();
  process.stdin.pause(); process.exitCode = 0;
} catch {
  await state?.close().catch(() => {});
  transport?.close(); process.stdin.pause();
  process.stderr.write("CONTROLLER_OPERATION_FAILED\n"); process.exitCode = 1;
}
