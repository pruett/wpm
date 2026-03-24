import { createHash, generateKeyPairSync, sign as rsaSign, verify as rsaVerify } from "node:crypto";

export function generateKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey, address: addressOf(publicKey) };
}

export function addressOf(publicKey: string): string {
  return createHash("sha256").update(publicKey).digest("hex");
}

export function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sign(data: string, privateKey: string): string {
  return rsaSign("sha256", Buffer.from(data), privateKey).toString("base64");
}

export function verify(data: string, signature: string, publicKey: string): boolean {
  return rsaVerify("sha256", Buffer.from(data), publicKey, Buffer.from(signature, "base64"));
}

export function serializeTx(tx: Record<string, unknown>): string {
  const keys = Object.keys(tx)
    .filter((k) => k !== "signature")
    .sort();
  const obj: Record<string, unknown> = {};
  for (const k of keys) obj[k] = tx[k];
  return JSON.stringify(obj);
}
