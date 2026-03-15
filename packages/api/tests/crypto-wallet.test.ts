import { describe, expect, test } from "bun:test";
import { generateWalletKeyPair, encryptPrivateKey, decryptPrivateKey } from "../src/crypto/wallet";

describe("generateWalletKeyPair", () => {
  test("returns publicKey and privateKey in PEM format", () => {
    const { publicKey, privateKey } = generateWalletKeyPair();

    expect(publicKey).toStartWith("-----BEGIN PUBLIC KEY-----");
    expect(publicKey).toEndWith("-----END PUBLIC KEY-----\n");
    expect(privateKey).toStartWith("-----BEGIN PRIVATE KEY-----");
    expect(privateKey).toEndWith("-----END PRIVATE KEY-----\n");
  });

  test("generates unique key pairs", () => {
    const a = generateWalletKeyPair();
    const b = generateWalletKeyPair();

    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).not.toBe(b.privateKey);
  });
});

describe("encryptPrivateKey / decryptPrivateKey", () => {
  const secret = "test-wallet-encryption-key-32bytes!";

  test("round-trip: encrypt then decrypt returns original key", async () => {
    const { privateKey } = generateWalletKeyPair();

    const encrypted = await encryptPrivateKey(privateKey, secret);
    const decrypted = await decryptPrivateKey(encrypted, secret);

    expect(decrypted).toBe(privateKey);
  });

  test("encrypted output is a Buffer containing IV + ciphertext", async () => {
    const { privateKey } = generateWalletKeyPair();
    const encrypted = await encryptPrivateKey(privateKey, secret);

    expect(Buffer.isBuffer(encrypted)).toBe(true);
    // IV (12) + ciphertext (>0) + GCM tag (16)
    expect(encrypted.byteLength).toBeGreaterThan(12 + 16);
  });

  test("same plaintext produces different ciphertext each time (random IV)", async () => {
    const { privateKey } = generateWalletKeyPair();

    const a = await encryptPrivateKey(privateKey, secret);
    const b = await encryptPrivateKey(privateKey, secret);

    expect(a.equals(b)).toBe(false);
  });

  test("wrong secret fails to decrypt", async () => {
    const { privateKey } = generateWalletKeyPair();
    const encrypted = await encryptPrivateKey(privateKey, secret);

    await expect(decryptPrivateKey(encrypted, "wrong-secret-key")).rejects.toThrow();
  });

  test("tampered ciphertext fails to decrypt", async () => {
    const { privateKey } = generateWalletKeyPair();
    const encrypted = await encryptPrivateKey(privateKey, secret);

    // Flip a byte in the ciphertext portion (after IV)
    encrypted[20] ^= 0xff;

    await expect(decryptPrivateKey(encrypted, secret)).rejects.toThrow();
  });

  test("truncated ciphertext fails to decrypt", async () => {
    const { privateKey } = generateWalletKeyPair();
    const encrypted = await encryptPrivateKey(privateKey, secret);

    const truncated = Buffer.from(encrypted.subarray(0, 20));

    await expect(decryptPrivateKey(truncated, secret)).rejects.toThrow();
  });
});
