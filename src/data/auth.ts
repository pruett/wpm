import "server-only";
import { headers } from "next/headers";
import { cache } from "react";

import { auth, type Session } from "@/lib/auth";

export type { Session } from "@/lib/auth";

export type ActionResult = { success: true; error?: never } | { success?: never; error: string };

type AuthedSession = NonNullable<Session>;

export const getSession = cache(async (): Promise<Session> => {
  return auth.api.getSession({ headers: await headers() });
});

export async function getCurrentUser() {
  const session = await getSession();
  return session?.user ?? null;
}

export async function requireUser(): Promise<{ session: AuthedSession } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "Not authenticated" };
  return { session };
}
