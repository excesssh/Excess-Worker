import { randomBytes, generateKeyPairSync, sign } from "node:crypto";
function der(tag, content) {
  const length = content.length;
  const encodedLength = length < 128 ? Buffer.from([length]) : (() => {
    const parts = []; let value = length;
    while (value) { parts.unshift(value & 255); value = Math.floor(value / 256); }
    return Buffer.from([0x80 | parts.length, ...parts]);
  })();
  return Buffer.concat([Buffer.from([tag]), encodedLength, content]);
}

function derOid(value) {
  const arcs = value.split(".").map(BigInt);
  const values = [40n * arcs[0] + arcs[1], ...arcs.slice(2)];
  const encoded = [];
  for (let n of values) {
    const bytes = [Number(n & 0x7fn)]; n >>= 7n;
    while (n) { bytes.unshift(Number((n & 0x7fn) | 0x80n)); n >>= 7n; }
    encoded.push(...bytes);
  }
  return der(0x06, Buffer.from(encoded));
}

export function makeEphemeralTlsFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const sequence = (...values) => der(0x30, Buffer.concat(values));
  const integer = bytes => {
    let value = Buffer.from(bytes); while (value.length > 1 && value[0] === 0) value = value.subarray(1);
    if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
    return der(0x02, value);
  };
  const utc = date => der(0x17, Buffer.from(date.toISOString().slice(2, 19).replace(/[-:T]/g, "") + "Z"));
  const name = sequence(der(0x31, sequence(derOid("2.5.4.3"), der(0x0c, Buffer.from("coordinator.test")))));
  const now = new Date(), end = new Date(now); end.setUTCFullYear(end.getUTCFullYear() + 8);
  const extension = (id, value, critical = false) => sequence(derOid(id), ...(critical ? [der(0x01, Buffer.from([0xff]))] : []), der(0x04, value));
  const extensions = der(0xa3, sequence(
    extension("2.5.29.19", sequence(der(0x01, Buffer.from([0xff]))), true),
    extension("2.5.29.17", sequence(der(0x82, Buffer.from("coordinator.test")))),
    extension("2.5.29.37", sequence(derOid("1.3.6.1.5.5.7.3.1"))),
  ));
  const algorithm = sequence(derOid("1.2.840.10045.4.3.2"));
  const tbs = sequence(der(0xa0, integer(Buffer.from([2]))), integer(randomBytes(16)), algorithm,
    name, sequence(utc(now), utc(end)), name, publicKey.export({ type: "spki", format: "der" }), extensions);
  const signature = sign("sha256", tbs, privateKey);
  const certificate = sequence(tbs, algorithm, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const certPem = `-----BEGIN CERTIFICATE-----\n${certificate.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`;
  // TLS accepts the serialized key here; keep it only in memory and never write or print it.
  return { cert: certPem, key: privateKey.export({ type: "pkcs8", format: "pem" }) };
}
