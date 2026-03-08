import { generateKeyPair } from "@wpm/shared/crypto";

const IV_LENGTH = 12;

export function generateWalletKeyPair() {
  return generateKeyPair();
}

function deriveKey(secret: string): ArrayBuffer {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(secret);
  const buf = hasher.digest();
  return (buf.buffer as ArrayBuffer).slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

export async function encryptPrivateKey(privateKey: string, secret: string): Promise<Buffer> {
  const keyBytes = deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);

  const encoded = new TextEncoder().encode(privateKey);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.buffer as ArrayBuffer, tagLength: 128 },
    cryptoKey,
    encoded.buffer as ArrayBuffer,
  );

  // Format: [IV (12 bytes)][ciphertext + GCM auth tag]
  const result = Buffer.alloc(IV_LENGTH + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), IV_LENGTH);

  return result;
}

export async function decryptPrivateKey(encrypted: Buffer, secret: string): Promise<string> {
  const keyBytes = deriveKey(secret);
  const iv = new Uint8Array(
    encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + IV_LENGTH),
  );
  const ciphertext = new Uint8Array(
    encrypted.buffer.slice(
      encrypted.byteOffset + IV_LENGTH,
      encrypted.byteOffset + encrypted.byteLength,
    ),
  );

  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv.buffer as ArrayBuffer, tagLength: 128 },
    cryptoKey,
    ciphertext.buffer as ArrayBuffer,
  );

  return new TextDecoder().decode(decrypted);
}
