// FAKE stand-in for llama-server and sd-server in adapter tests. Not a model runtime and not runtime evidence.
// Its behaviour comes from the JSON file passed as the model path; every request is appended to the configured log.
import { createServer } from "node:http";
import { readFileSync, appendFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

const args = process.argv.slice(2), value = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const llama = args.includes("--port");
const config = JSON.parse(readFileSync(value("--model") ?? value("--diffusion-model"), "utf8"));
const key = process.env.LLAMA_API_KEY;
const log = entry => appendFileSync(config.log, JSON.stringify(entry) + "\n");
log({ type: "start", args, hasKey: Boolean(key) });

function png(width, height) {
  const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, "latin1"); data.copy(out, 8); out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])), 8 + data.length); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc(8))), chunk("IEND", Buffer.alloc(0))]);
}
const send = (response, status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(typeof body === "string" ? body : JSON.stringify(body)); };
createServer((request, response) => {
  const chunks = [];
  request.on("data", chunk => chunks.push(chunk));
  request.on("end", () => {
    if (request.method === "GET" && (request.url === "/health" || request.url === "/v1/models")) return send(response, 200, llama ? { status: "ok" } : { data: [{ id: "sd-cpp-local" }] });
    const authorized = !llama || request.headers.authorization === "Bearer " + key;
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    log({ type: "request", method: request.method, url: request.url, authorized, body });
    if (!authorized) return send(response, 401, { error: "unauthorized" });
    const behavior = config.behavior ?? "ok";
    if (behavior === "hang") return;
    if (behavior === "crash") process.exit(3);
    if (behavior === "status500") return send(response, 500, { error: "fixture failure" });
    if (behavior === "oversize") return send(response, 200, JSON.stringify({ padding: "x".repeat(64 * 1024 * 1024) }));
    if (request.url === "/v1/embeddings") {
      const data = body.input.map((_, index) => {
        const vector = Buffer.alloc((behavior === "short" ? 1023 : 1024) * 4);
        for (let n = 0; n < vector.length / 4; n++) vector.writeFloatLE(behavior === "nan" && index === 0 && n === 7 ? NaN : (index + 1) / 64, n * 4);
        return { index: behavior === "duplicate" ? 0 : index, object: "embedding", embedding: vector.toString("base64") };
      });
      return send(response, 200, { model: "fixture", object: "list", usage: { prompt_tokens: config.tokens ?? 7, total_tokens: config.tokens ?? 7 }, data });
    }
    if (request.url === "/v1/chat/completions")
      return send(response, 200, { choices: [{ index: 0, finish_reason: config.finish ?? "stop", message: { role: "assistant", content: config.content ?? "language English<asr_text>FIXTURE TRANSCRIPT" } }] });
    if (request.url === "/v1/images/generations") {
      const [width, height] = body.size.split("x").map(Number);
      const count = behavior === "fewer" ? body.n - 1 : body.n;
      const data = Array.from({ length: count }, () => ({ b64_json: behavior === "notpng" ? Buffer.from("NOT A PNG FIXTURE").toString("base64") : png(behavior === "badsize" ? width / 2 : width, height).toString("base64") }));
      return send(response, 200, { created: 0, output_format: "png", data });
    }
    send(response, 404, { error: "not found" });
  });
}).listen(Number(value("--port") ?? value("--listen-port")), value("--host") ?? value("--listen-ip"));
