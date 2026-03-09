export function getOraclePublicKey(): string | null {
  return process.env.ORACLE_PUBLIC_KEY ?? null;
}

export function getOraclePrivateKey(): string | null {
  return process.env.ORACLE_PRIVATE_KEY ?? null;
}
