import { generateKeyPairSync, createSign, createVerify, createHash } from "node:crypto";

type KeyPair = {
  publicKey: string;
  privateKey: string;
};

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey };
}

export function sign(data: string, privateKey: string): string {
  const signer = createSign("SHA256");
  signer.update(data);
  signer.end();
  return signer.sign(privateKey, "base64");
}

export function verify(data: string, signature: string, publicKey: string): boolean {
  const verifier = createVerify("SHA256");
  verifier.update(data);
  verifier.end();
  return verifier.verify(publicKey, signature, "base64");
}

export function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}
