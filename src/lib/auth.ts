import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins";
import { eq, sql } from "drizzle-orm";
import fs from "node:fs";

import { SIGNUP_AIRDROP } from "@/lib/constants";
import { db } from "@/lib/db";
import { balances, transactions, treasury } from "@/lib/db/schema/app";
import { user } from "@/lib/db/schema/auth";

const BASE_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:4102";

const pendingProfiles = new Map<string, { displayName: string; color: string; icon: string }>();

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg" }),
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
          await db.transaction(async (tx) => {
            const inserted = await tx
              .insert(balances)
              .values({ userId: createdUser.id, amount: SIGNUP_AIRDROP })
              .onConflictDoNothing()
              .returning({ userId: balances.userId });
            if (inserted.length === 0) return;

            const [t] = await tx.select().from(treasury).where(eq(treasury.id, "treasury"));
            if (!t) throw new Error("Treasury not seeded");
            if (t.amount < SIGNUP_AIRDROP) {
              throw new Error("Insufficient treasury balance for signup airdrop");
            }

            await tx
              .update(treasury)
              .set({ amount: sql`${treasury.amount} - ${SIGNUP_AIRDROP}` })
              .where(eq(treasury.id, "treasury"));

            const now = Date.now();
            await tx.insert(transactions).values({
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
            });
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
