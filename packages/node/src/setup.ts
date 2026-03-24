import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";

const KEYS_DIR = "./data/keys";
const PUB_PATH = `${KEYS_DIR}/node.pub`;
const PEM_PATH = `${KEYS_DIR}/node.pem`;

if (existsSync(PUB_PATH) && existsSync(PEM_PATH)) {
  console.log("Keys already exist, skipping generation");
  process.exit(0);
}

mkdirSync(KEYS_DIR, { recursive: true });

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

writeFileSync(PUB_PATH, publicKey);
writeFileSync(PEM_PATH, privateKey);
console.log("Generated node keys at", KEYS_DIR);
