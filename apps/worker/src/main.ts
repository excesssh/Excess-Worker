import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);

export async function diagnostics() {
  let nvidia: { status: string; devices: string[] } = { status: "unavailable", devices: [] };
  try {
    const { stdout } = await execute("nvidia-smi", ["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"], { timeout: 5000, maxBuffer: 16384, windowsHide: true });
    nvidia = { status: "detected_not_execution_verified", devices: stdout.trim().split(/\r?\n/).filter(Boolean) };
  } catch { /* A missing NVIDIA utility does not imply an unsupported machine. */ }
  return {
    product: "EXCESS", kind: "local_diagnostics", protocolVersion: 1,
    platform: os.platform(), release: os.release(), architecture: os.arch(),
    cpu: os.cpus()[0]?.model.trim() ?? "unknown", logicalCpus: os.cpus().length,
    memoryBytes: String(os.totalmem()), nvidia,
    executionBackends: [], verifiedCapabilities: [], registered: false,
    notes: ["Hardware discovery is not an execution probe.", "No models downloaded or jobs accepted.", "AMD, Intel and CPU execution remain untested."],
  };
}
if (process.argv[2] !== "doctor") {
  process.stderr.write("Usage: worker doctor\nSupplier registration and execution are not implemented yet.\n");
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify(await diagnostics(), null, 2) + "\n");
}
