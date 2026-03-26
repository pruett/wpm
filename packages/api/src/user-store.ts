import { Context, Effect, Layer } from "effect";
import { generateKeyPair, addressOf } from "@wpm/shared";
import { readFileSync, writeFileSync } from "node:fs";

export type StoredUser = {
  id: string;
  name: string;
  publicKey: string;
  privateKey: string;
  token: string;
  address: string;
};

export class UserStore extends Context.Tag("UserStore")<
  UserStore,
  {
    readonly register: (name: string) => StoredUser;
    readonly getByToken: (token: string) => StoredUser | undefined;
    readonly getById: (id: string) => StoredUser | undefined;
  }
>() {
  static Live = (filePath?: string) =>
    Layer.sync(this, () => {
      const users = new Map<string, StoredUser>();
      const tokenIndex = new Map<string, string>(); // token → userId

      // Restore from file if it exists
      if (filePath) {
        try {
          const data = JSON.parse(readFileSync(filePath, "utf-8"));
          for (const u of data) {
            users.set(u.id, u);
            tokenIndex.set(u.token, u.id);
          }
        } catch {
          // File doesn't exist or is invalid — start fresh
        }
      }

      function persist() {
        if (!filePath) return;
        try {
          writeFileSync(filePath, JSON.stringify([...users.values()], null, 2));
        } catch {
          // Best-effort persistence
        }
      }

      return {
        register(name: string): StoredUser {
          const id = crypto.randomUUID();
          const token = crypto.randomUUID();
          const keys = generateKeyPair();
          const user: StoredUser = {
            id,
            name,
            publicKey: keys.publicKey,
            privateKey: keys.privateKey,
            token,
            address: keys.address,
          };
          users.set(id, user);
          tokenIndex.set(token, id);
          persist();
          return user;
        },
        getByToken(token: string): StoredUser | undefined {
          const id = tokenIndex.get(token);
          return id ? users.get(id) : undefined;
        },
        getById(id: string): StoredUser | undefined {
          return users.get(id);
        },
      };
    });
}
