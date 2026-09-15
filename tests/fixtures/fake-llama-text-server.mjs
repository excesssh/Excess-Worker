// FAKE stand-in for llama-server's native text endpoints in adapter tests. Not a model runtime and not runtime evidence.
// Its behaviour comes from the JSON file passed as --model; every request is appended to the configured log.
// Config: { log, output: [[tokenId, piece], ...], marker?: [tokenIds], stopType?: "eos" | "limit", behavior? }
import { createServer } from "node:http";
import { readFileSync, appendFileSync } from "node:fs";

const args = process.argv.slice(2), value = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const key = process.env.LLAMA_API_KEY;
const config = () => JSON.parse(readFileSync(value("--model"), "utf8"));
const log = entry => appendFileSync(config().log, JSON.stringify(entry) + "\n");
log({ type: "start", args, hasKey: Boolean(key) });
const send = (response, status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
createServer((request, response) => {
  const chunks = [];
  request.on("data", chunk => chunks.push(chunk));
  request.on("end", () => {
    if (request.method === "GET" && request.url === "/health") return send(response, 200, { status: "ok" });
    const authorized = request.headers.authorization === "Bearer " + key, body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    log({ type: "request", url: request.url, authorized, body });
    if (!authorized) return send(response, 401, { error: "unauthorized" });
    const settings = config(), output = settings.output ?? [[1, "FIXTURE"]];
    if (request.url === "/tokenize") {
      // The answer marker tokenizes to the configured IDs; any other text counts one token per four bytes.
      if (body.content === "<|channel|>final<|message|>" && settings.marker) return send(response, 200, { tokens: settings.marker });
      return send(response, 200, { tokens: Array.from({ length: Math.ceil(Buffer.byteLength(body.content) / 4) }, (_, index) => index + 1) });
    }
    if (request.url === "/detokenize") {
      const pieces = new Map(output);
      return send(response, 200, { content: body.tokens.map(token => pieces.get(token) ?? "").join("") });
    }
    if (request.url !== "/completion") return send(response, 404, { error: "not found" });
    const produced = output.slice(0, body.n_predict), stopType = produced.length < output.length ? "limit" : settings.stopType ?? "eos";
    if (!body.stream) return send(response, 200, { content: produced.map(item => item[1]).join(""), tokens: produced.map(item => item[0]), stop_type: stopType, truncated: false });
    response.writeHead(200, { "content-type": "text/event-stream" });
    produced.forEach(([token, piece], index) => response.write(`data: ${JSON.stringify({ content: piece, tokens: [token], stop: false, tokens_predicted: index + 1 })}\n\n`));
    response.end(`data: ${JSON.stringify({ content: "", tokens: [], stop: true, tokens_predicted: produced.length, stop_type: stopType, truncated: false })}\n\n`);
  });
}).listen(Number(value("--port")), value("--host"));
