import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { generateKeyPair } from "@wpm/shared";

type NodeKeys = {
  poaPublicKey: string;
  poaPrivateKey: string;
  oraclePublicKey: string;
};

const DEFAULT_POA_PRIVATE_PATH = "/data/poa-private.pem";
const DEFAULT_POA_PUBLIC_PATH = "/data/poa-public.pem";
const DEFAULT_ORACLE_PUBLIC_PATH = "/data/oracle-public.pem";

function loadOrGeneratePoAKeys(
  privatePath: string,
  publicPath: string,
): { publicKey: string; privateKey: string } {
  if (existsSync(privatePath) && existsSync(publicPath)) {
    return {
      privateKey: readFileSync(privatePath, "utf-8"),
      publicKey: readFileSync(publicPath, "utf-8"),
    };
  }

  if (existsSync(privatePath) !== existsSync(publicPath)) {
    const missing = existsSync(privatePath) ? publicPath : privatePath;
    throw new Error(
      `PoA key file missing: ${missing}. Both key files must exist or neither (for auto-generation).`,
    );
  }

  const { publicKey, privateKey } = generateKeyPair();
  writeFileSync(privatePath, privateKey, { mode: 0o600 });
  writeFileSync(publicPath, publicKey, { mode: 0o644 });
  chmodSync(privatePath, 0o600);
  return { publicKey, privateKey };
}

function loadOraclePublicKey(filePath: string): string {
  const envKey = process.env.ORACLE_PUBLIC_KEY;
  if (envKey) {
    return envKey;
  }

  if (existsSync(filePath)) {
    return readFileSync(filePath, "utf-8");
  }

  throw new Error(
    `Oracle public key not found. Set ORACLE_PUBLIC_KEY env var or provide ${filePath}.`,
  );
}

export function loadKeys(paths?: {
  poaPrivatePath?: string;
  poaPublicPath?: string;
  oraclePublicPath?: string;
}): NodeKeys {
  const poaPrivatePath = paths?.poaPrivatePath ?? DEFAULT_POA_PRIVATE_PATH;
  const poaPublicPath = paths?.poaPublicPath ?? DEFAULT_POA_PUBLIC_PATH;
  const oraclePublicPath = paths?.oraclePublicPath ?? DEFAULT_ORACLE_PUBLIC_PATH;

  const poa = loadOrGeneratePoAKeys(poaPrivatePath, poaPublicPath);
  const oraclePublicKey = loadOraclePublicKey(oraclePublicPath);

  return {
    poaPublicKey: poa.publicKey,
    poaPrivateKey: poa.privateKey,
    oraclePublicKey,
  };
}

export type { NodeKeys };
