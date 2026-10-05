import { isIP } from "node:net";

export type CoordinatorOrigin = Readonly<{ origin: string; hostname: string; port: number }>;
export type EgressRoute = Readonly<{
  method: "GET" | "POST";
  path: string;
  requestBytes: number;
  responseBytes: number;
  timeoutMs: number;
  archive: boolean;
}>;

const MAX_WORKER_COMMAND_BODY = 2 * 524288 + 4096;
export const MAX_COORDINATOR_ARCHIVE_BYTES = 256 * 1024 * 1024;
export const MAX_COORDINATOR_JSON_BYTES = 1_052_672;

export function parseCoordinatorOrigin(value: string): CoordinatorOrigin {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid paired coordinator origin"); }
  const hostname = url.hostname;
  const ipv6Literal = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password || url.pathname !== "/" ||
      url.search || url.hash || !hostname || hostname.startsWith("[") || isIP(hostname) !== 0 || isIP(ipv6Literal) !== 0 || value.length > 255) {
    throw new Error("Coordinator origin must be a canonical HTTPS origin with a DNS hostname");
  }
  const port = url.port ? Number(url.port) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid coordinator port");
  return Object.freeze({ origin: url.origin, hostname, port });
}

const routes = new Map<string, Omit<EgressRoute, "path">>([
  ["GET /v1/public-config", { method: "GET", requestBytes: 0, responseBytes: 65536, timeoutMs: 10000, archive: false }],
  ["POST /v1/devices/pairing/start", { method: "POST", requestBytes: 32768, responseBytes: 65536, timeoutMs: 10000, archive: false }],
  ["POST /v1/devices/pairing/complete", { method: "POST", requestBytes: 32768, responseBytes: 65536, timeoutMs: 10000, archive: false }],
  ["POST /v1/worker/heartbeat", { method: "POST", requestBytes: 32768, responseBytes: 1048576, timeoutMs: 10000, archive: false }],
  ["POST /v1/worker/command", { method: "POST", requestBytes: MAX_WORKER_COMMAND_BODY, responseBytes: 1048576, timeoutMs: 10000, archive: false }],
  ["POST /v1/worker/offer", { method: "POST", requestBytes: 32768, responseBytes: 1048576, timeoutMs: 10000, archive: false }],
  ["GET /v1/market", { method: "GET", requestBytes: 0, responseBytes: 2 * 1024 * 1024, timeoutMs: 10000, archive: false }],
  ["GET /downloads/release.json", { method: "GET", requestBytes: 0, responseBytes: 65536, timeoutMs: 15000, archive: false }],
  ["GET /downloads/release.json.minisig", { method: "GET", requestBytes: 0, responseBytes: 10240, timeoutMs: 15000, archive: false }],
]);

const releaseVersion = "(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?";
const archivePath = new RegExp(`^/downloads/excess-worker-${releaseVersion}-[0-9a-f]{12}-(?:win-x64\\.zip|linux-x64\\.tar\\.gz)$`);

/** Exact path-and-method allowlist. Query strings, percent-encoding and absolute-form targets are never accepted. */
export function routeFor(method: string, requestTarget: string): EgressRoute | null {
  if (typeof requestTarget !== "string" || requestTarget.length > 256 || !requestTarget.startsWith("/") ||
      requestTarget.startsWith("//") || requestTarget.includes("%") || requestTarget.includes("\\") ||
      requestTarget.includes("?") || requestTarget.includes("#") || /[\u0000-\u0020\u007f]/.test(requestTarget)) return null;
  const base = routes.get(`${method} ${requestTarget}`);
  if (base) return Object.freeze({ ...base, path: requestTarget });
  if (method === "GET" && archivePath.test(requestTarget)) {
    return Object.freeze({ method: "GET", path: requestTarget, requestBytes: 0,
      responseBytes: MAX_COORDINATOR_ARCHIVE_BYTES, timeoutMs: 120000, archive: true });
  }
  return null;
}

/** Filter non-global answers and a conservative subset of special-use DNS ranges. */
export function isPublicUnicast(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const numeric = (((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0);
    const blocked: readonly [number, number][] = [
      [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
      [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
      [0xc0586300, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24],
      [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4], [0xffffffff, 32],
    ];
    return !blocked.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return ((numeric & mask) >>> 0) === base;
    });
  }
  if (family !== 6) return false;
  const lower = address.toLowerCase().split("%", 1)[0]!;
  if (lower.includes(".")) return false;
  const halves = lower.split("::");
  if (halves.length > 2) return false;
  const left = halves[0] ? halves[0]!.split(":") : [], right = halves[1] ? halves[1]!.split(":") : [];
  const values = [...left, ...(halves.length === 2 ? Array(8 - left.length - right.length).fill("0") : []), ...right];
  if (values.length !== 8 || values.some(part => !/^[0-9a-f]{1,4}$/.test(part))) return false;
  const groups = values.map(part => Number.parseInt(part, 16));
  if (groups[0]! < 0x2000 || groups[0]! > 0x3fff) return false;
  const inPrefix = (prefix: readonly number[], bits: number) => {
    const whole = Math.floor(bits / 16), partial = bits % 16;
    for (let i = 0; i < whole; i++) if (groups[i] !== prefix[i]) return false;
    if (partial) {
      const mask = (0xffff << (16 - partial)) & 0xffff;
      if ((groups[whole]! & mask) !== (prefix[whole]! & mask)) return false;
    }
    return true;
  };
  // The deny prefixes track special-purpose blocks with limited/non-global use
  // in IANA's IPv6 registry, plus non-global unicast classes. This is a safety
  // denylist, not a claim that the registry is exhaustive or static.
  const blocked: readonly [readonly number[], number][] = [
    [[0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000], 128],
    [[0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0001], 128],
    [[0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0xffff, 0x0000, 0x0000], 96],
    [[0x0064, 0xff9b, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000], 96],
    [[0x0064, 0xff9b, 0x0001, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000], 48],
    [[0x0100, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000], 64],
    [[0x0100, 0x0000, 0x0000, 0x0001, 0x0000, 0x0000, 0x0000, 0x0000], 64],
    [[0x2001, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000], 23],
    [[0x2001, 0x0db8, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000], 32],
    [[0x2002, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000], 16],
    [[0x3fff, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000], 20],
    [[0x5f00, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000], 16],
    [[0xfc00, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000], 7],
    [[0xfe80, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000], 10],
    [[0xff00, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000], 8],
  ];
  return !blocked.some(([prefix, bits]) => inPrefix(prefix, bits));
}
