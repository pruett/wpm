import { Context, Layer } from "effect";
import { generateKeyPair } from "@wpm/shared";
import { readFileSync, writeFileSync } from "node:fs";

export type StoredUser = {
  id: string;
  name: string;
  email: string;
  publicKey: string;
  privateKey: string;
  token: string;
  address: string;
};

export class UserStore extends Context.Tag("UserStore")<
  UserStore,
  {
    readonly register: (name: string, email: string) => StoredUser;
    readonly getByToken: (token: string) => StoredUser | undefined;
    readonly getById: (id: string) => StoredUser | undefined;
    readonly getByEmail: (email: string) => StoredUser | undefined;
    readonly getByAddress: (address: string) => StoredUser | undefined;
    readonly getAllUsers: () => StoredUser[];
  }
>() {
  static Live = (filePath?: string) =>
    Layer.sync(this, () => {
      const users = new Map<string, StoredUser>();
      const tokenIndex = new Map<string, string>(); // token → userId
      const emailIndex = new Map<string, string>(); // email → userId

      // Restore from file if it exists
      if (filePath) {
        try {
          const data = JSON.parse(readFileSync(filePath, "utf-8"));
          for (const u of data) {
            users.set(u.id, u);
            tokenIndex.set(u.token, u.id);
            if (u.email) emailIndex.set(u.email, u.id);
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
        register(name: string, email: string): StoredUser {
          // Idempotent: return existing user if email already registered
          const existingId = emailIndex.get(email);
          if (existingId) {
            return users.get(existingId)!;
          }

          const id = crypto.randomUUID();
          const token = crypto.randomUUID();
          const keys = generateKeyPair();
          const user: StoredUser = {
            id,
            name,
            email,
            publicKey: keys.publicKey,
            privateKey: keys.privateKey,
            token,
            address: keys.address,
          };
          users.set(id, user);
          tokenIndex.set(token, id);
          emailIndex.set(email, id);
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
        getByEmail(email: string): StoredUser | undefined {
          const id = emailIndex.get(email);
          return id ? users.get(id) : undefined;
        },
        getByAddress(address: string): StoredUser | undefined {
          return Array.from(users.values()).find((u) => u.address === address);
        },
        getAllUsers(): StoredUser[] {
          return Array.from(users.values());
        },
      };
    });
}
