import { Context, Layer } from "effect";
import { generateKeyPair } from "@wpm/shared";
import { readFileSync, writeFileSync } from "node:fs";

export type WalletEntry = {
  userId: string;
  publicKey: string;
  privateKey: string;
  token: string;
  address: string;
};

export class WalletKeystore extends Context.Tag("WalletKeystore")<
  WalletKeystore,
  {
    readonly register: (userId: string) => WalletEntry;
    readonly getByToken: (token: string) => WalletEntry | undefined;
    readonly getById: (userId: string) => WalletEntry | undefined;
    readonly getByAddress: (address: string) => WalletEntry | undefined;
    readonly getAllWallets: () => WalletEntry[];
  }
>() {
  static Live = (filePath?: string) =>
    Layer.sync(this, () => {
      const wallets = new Map<string, WalletEntry>();
      const tokenIndex = new Map<string, string>(); // token → userId

      if (filePath) {
        try {
          const data = JSON.parse(readFileSync(filePath, "utf-8"));
          for (const w of data) {
            wallets.set(w.userId, w);
            tokenIndex.set(w.token, w.userId);
          }
        } catch {
          // File doesn't exist or is invalid — start fresh
        }
      }

      function persist() {
        if (!filePath) return;
        try {
          writeFileSync(filePath, JSON.stringify([...wallets.values()], null, 2));
        } catch {
          // Best-effort persistence
        }
      }

      return {
        register(userId: string): WalletEntry {
          const existing = wallets.get(userId);
          if (existing) return existing;

          const token = crypto.randomUUID();
          const keys = generateKeyPair();
          const entry: WalletEntry = {
            userId,
            publicKey: keys.publicKey,
            privateKey: keys.privateKey,
            token,
            address: keys.address,
          };
          wallets.set(userId, entry);
          tokenIndex.set(token, userId);
          persist();
          return entry;
        },
        getByToken(token: string): WalletEntry | undefined {
          const userId = tokenIndex.get(token);
          return userId ? wallets.get(userId) : undefined;
        },
        getById(userId: string): WalletEntry | undefined {
          return wallets.get(userId);
        },
        getByAddress(address: string): WalletEntry | undefined {
          return Array.from(wallets.values()).find((w) => w.address === address);
        },
        getAllWallets(): WalletEntry[] {
          return Array.from(wallets.values());
        },
      };
    });
}
