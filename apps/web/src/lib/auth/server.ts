import "server-only";
import fs from "node:fs";
import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { magicLink } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { passkey } from "@better-auth/passkey";
import { eq, sql } from "drizzle-orm";
import { SIGNUP_AIRDROP } from "@wpm/shared";
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema/auth";
import { balances, transactions, treasury } from "@/lib/db/schema/app";

const BASE_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:4102";

const pendingProfiles = new Map<string, { displayName: string; color: string; icon: string }>();

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "sqlite" }),
  baseURL: BASE_URL,
  hooks: {
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/sign-in/magic-link" && ctx.body) {
        const { email, displayName, color, icon } = ctx.body;
        if (email && displayName && color && icon) {
          pendingProfiles.set(email as string, {
            displayName: displayName as string,
            color: color as string,
            icon: icon as string,
          });
        }
      }

      const newSession = ctx.context.newSession;
      if (newSession) {
        const profile = pendingProfiles.get(newSession.user.email);
        if (profile) {
          pendingProfiles.delete(newSession.user.email);
          await db
            .update(user)
            .set({
              display_name: profile.displayName,
              color: profile.color,
              icon: profile.icon,
            })
            .where(eq(user.id, newSession.user.id));
        }
      }
    }),
  },
  databaseHooks: {
    user: {
      create: {
        after: async (createdUser) => {
          db.transaction((tx) => {
            const inserted = tx
              .insert(balances)
              .values({ userId: createdUser.id, amount: SIGNUP_AIRDROP })
              .onConflictDoNothing()
              .run();
            if (inserted.changes === 0) return;

            const t = tx.select().from(treasury).where(eq(treasury.id, "treasury")).get();
            if (!t) throw new Error("Treasury not seeded");
            if (t.amount < SIGNUP_AIRDROP) {
              throw new Error("Insufficient treasury balance for signup airdrop");
            }

            tx.update(treasury)
              .set({ amount: sql`${treasury.amount} - ${SIGNUP_AIRDROP}` })
              .where(eq(treasury.id, "treasury"))
              .run();

            const now = Date.now();
            tx.insert(transactions)
              .values({
                type: "Distribute",
                userId: createdUser.id,
                payload: JSON.stringify({
                  type: "Distribute",
                  to: createdUser.id,
                  amount: SIGNUP_AIRDROP,
                  memo: "signup_airdrop",
                  timestamp: new Date(now).toISOString(),
                }),
                createdAt: now,
              })
              .run();
          });
        },
      },
    },
  },
  user: {
    additionalFields: {
      displayName: {
        type: "string",
        required: false,
        fieldName: "display_name",
      },
      color: {
        type: "string",
        required: false,
      },
      icon: {
        type: "string",
        required: false,
      },
    },
  },
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        console.log(`[magic-link] ${email} → ${url}`);
        const capturePath = process.env.WPM_MAGIC_LINK_CAPTURE_PATH;
        if (capturePath) {
          fs.appendFileSync(capturePath, `${JSON.stringify({ email, url })}\n`);
        }
      },
    }),
    passkey({
      rpID: new URL(BASE_URL).hostname,
      rpName: "WPM",
      origin: BASE_URL,
    }),
    nextCookies(),
  ],
});

export type Session = Awaited<ReturnType<typeof auth.api.getSession>>;
