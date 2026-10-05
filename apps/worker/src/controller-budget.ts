import { readFile } from "node:fs/promises";

const MAX_MEMORY = 12n * 1024n * 1024n * 1024n;
export function validateControllerBudget(memory: string, swap: string, tasks: string, cpu: string): void {
  const positive = (value: string) => /^[1-9][0-9]{0,19}$/.test(value.trim());
  if (!positive(memory) || BigInt(memory.trim()) > MAX_MEMORY || swap.trim() !== "0" ||
      !positive(tasks) || BigInt(tasks.trim()) > 128n) throw Error("CONTROLLER_RESOURCE_BOUNDARY_REQUIRED");
  const match = /^([1-9][0-9]{0,19}) ([1-9][0-9]{0,19})$/.exec(cpu.trim());
  if (!match || BigInt(match[1]!) > 2n * BigInt(match[2]!)) throw Error("CONTROLLER_RESOURCE_BOUNDARY_REQUIRED");
}

/** Aggregate process/memory/CPU limits belong to a dedicated outside service
 * cgroup, rather than an ineffective RSS rlimit or UID-wide process counter. */
export async function requireControllerBudget(): Promise<void> {
  try {
    const membership = (await readFile("/proc/self/cgroup", "utf8")).trim();
    const match = /^0::(\/[A-Za-z0-9_./@:-]+\/excess-worker(?:-verification-[a-f0-9]+)?\.service)$/.exec(membership);
    if (!match || match[1]!.split("/").some(part => part === "." || part === "..")) throw Error("cgroup");
    const root = "/sys/fs/cgroup" + match[1];
    const [memory, swap, tasks, cpu] = await Promise.all([
      readFile(root + "/memory.max", "utf8"), readFile(root + "/memory.swap.max", "utf8"),
      readFile(root + "/pids.max", "utf8"), readFile(root + "/cpu.max", "utf8"),
    ]);
    validateControllerBudget(memory, swap, tasks, cpu);
  } catch { throw Error("CONTROLLER_RESOURCE_BOUNDARY_REQUIRED"); }
}
