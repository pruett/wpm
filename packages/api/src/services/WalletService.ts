import { Effect, Layer, Redacted } from "effect"
import { generateKeyPair, sign as cryptoSign } from "@wpm/shared/crypto"
import { AppConfigService } from "../Config"
import { DatabaseService } from "./DatabaseService"
import { InternalError } from "../errors"

const IV_LENGTH = 12

function deriveKey(secret: string): ArrayBuffer {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(secret)
  const buf = hasher.digest()
  return (buf.buffer as ArrayBuffer).slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

export class WalletService extends Effect.Tag("WalletService")<
  WalletService,
  {
    readonly generateKeyPair: () => Effect.Effect<{ publicKey: string; privateKey: string }>
    readonly encryptPrivateKey: (privateKey: string) => Effect.Effect<Buffer>
    readonly decryptPrivateKey: (encrypted: Buffer) => Effect.Effect<string>
    readonly getUserPrivateKey: (userId: string) => Effect.Effect<string, InternalError>
    readonly signTransaction: <T extends { signature: string }>(
      tx: T,
      privateKey: string,
    ) => Effect.Effect<T>
  }
>() {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function*() {
      const config = yield* AppConfigService
      const db = yield* DatabaseService
      const encryptionKey = Redacted.value(config.walletEncryptionKey)

      return {
        generateKeyPair: () => Effect.try(() => generateKeyPair()).pipe(Effect.orDie),

        encryptPrivateKey: (privateKey: string) =>
          Effect.tryPromise(async () => {
            const keyBytes = deriveKey(encryptionKey)
            const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))

            const cryptoKey = await crypto.subtle.importKey(
              "raw",
              keyBytes,
              "AES-GCM",
              false,
              ["encrypt"],
            )

            const encoded = new TextEncoder().encode(privateKey)
            const ciphertext = await crypto.subtle.encrypt(
              { name: "AES-GCM", iv: iv.buffer as ArrayBuffer, tagLength: 128 },
              cryptoKey,
              encoded.buffer as ArrayBuffer,
            )

            const result = Buffer.alloc(IV_LENGTH + ciphertext.byteLength)
            result.set(iv, 0)
            result.set(new Uint8Array(ciphertext), IV_LENGTH)
            return result
          }).pipe(Effect.orDie),

        decryptPrivateKey: (encrypted: Buffer) =>
          Effect.tryPromise(async () => {
            const keyBytes = deriveKey(encryptionKey)
            const iv = new Uint8Array(
              encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + IV_LENGTH),
            )
            const ciphertext = new Uint8Array(
              encrypted.buffer.slice(
                encrypted.byteOffset + IV_LENGTH,
                encrypted.byteOffset + encrypted.byteLength,
              ),
            )

            const cryptoKey = await crypto.subtle.importKey(
              "raw",
              keyBytes,
              "AES-GCM",
              false,
              ["decrypt"],
            )

            const decrypted = await crypto.subtle.decrypt(
              { name: "AES-GCM", iv: iv.buffer as ArrayBuffer, tagLength: 128 },
              cryptoKey,
              ciphertext.buffer as ArrayBuffer,
            )

            return new TextDecoder().decode(decrypted)
          }).pipe(Effect.orDie),

        getUserPrivateKey: (userId: string) =>
          Effect.gen(function*() {
            const row = yield* db.findUserById(userId)
            if (!row) {
              return yield* Effect.fail(
                new InternalError({ message: "User not found" }),
              )
            }

            const decrypted = yield* Effect.tryPromise(async () => {
              const keyBytes = deriveKey(encryptionKey)
              const encrypted = row.wallet_private_key_enc
              const iv = new Uint8Array(
                encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + IV_LENGTH),
              )
              const ciphertextBuf = new Uint8Array(
                encrypted.buffer.slice(
                  encrypted.byteOffset + IV_LENGTH,
                  encrypted.byteOffset + encrypted.byteLength,
                ),
              )

              const cryptoKeyObj = await crypto.subtle.importKey(
                "raw",
                keyBytes,
                "AES-GCM",
                false,
                ["decrypt"],
              )

              const result = await crypto.subtle.decrypt(
                { name: "AES-GCM", iv: iv.buffer as ArrayBuffer, tagLength: 128 },
                cryptoKeyObj,
                ciphertextBuf.buffer as ArrayBuffer,
              )

              return new TextDecoder().decode(result)
            }).pipe(
              Effect.catchAll(() =>
                Effect.fail(new InternalError({ message: "Failed to decrypt wallet key" })),
              ),
            )

            return decrypted
          }),

        signTransaction: <T extends { signature: string }>(tx: T, privateKey: string) =>
          Effect.try(() => {
            const signData = JSON.stringify({ ...tx, signature: undefined })
            tx.signature = cryptoSign(signData, privateKey)
            return tx
          }).pipe(Effect.orDie),
      }
    }),
  )
}
