import { cache } from "react";
import { headers } from "next/headers";
import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { magicLink } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { passkey } from "@better-auth/passkey";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { user } from "./db/schema/auth";

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
        // TODO: wire a real email transport. For now, log so dev can click through.
        console.log(`[magic-link] ${email} → ${url}`);
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

export const getSession = cache(async (): Promise<Session> => {
  return auth.api.getSession({ headers: await headers() });
});

export function isAdmin(session: Session): boolean {
  if (!session) return false;
  const adminEmails = process.env.ADMIN_EMAILS?.split(",").map((e) => e.trim()) ?? [];
  return adminEmails.includes(session.user.email);
}

export type ActionResult = { success: true; error?: never } | { success?: never; error: string };

export function requireOracle(request: Request): { ok: true } | { error: string; status: number } {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  const expected = process.env.WPM_ORACLE_SERVICE_TOKEN;
  if (!expected || token !== expected) return { error: "Unauthorized", status: 401 };
  return { ok: true };
}

type AuthedSession = NonNullable<Session>;

export async function requireUser(): Promise<{ session: AuthedSession } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "Not authenticated" };
  return { session };
}

export async function requireAdmin(): Promise<{ session: AuthedSession } | { error: string }> {
  const session = await getSession();
  if (!isAdmin(session)) return { error: "Unauthorized" };
  return { session: session as AuthedSession };
}
