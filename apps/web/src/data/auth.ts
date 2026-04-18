import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { auth, type Session } from "@/lib/auth/server";

export type { Session } from "@/lib/auth/server";

export type ActionResult = { success: true; error?: never } | { success?: never; error: string };

type AuthedSession = NonNullable<Session>;

export const getSession = cache(async (): Promise<Session> => {
  return auth.api.getSession({ headers: await headers() });
});

export async function getCurrentUser() {
  const session = await getSession();
  return session?.user ?? null;
}

export function isAdmin(session: Session): boolean {
  if (!session) return false;
  const adminEmails = process.env.ADMIN_EMAILS?.split(",").map((e) => e.trim()) ?? [];
  return adminEmails.includes(session.user.email);
}

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

export function requireOracle(request: Request): { ok: true } | { error: string; status: number } {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  const expected = process.env.WPM_ORACLE_SERVICE_TOKEN;
  if (!expected || token !== expected) return { error: "Unauthorized", status: 401 };
  return { ok: true };
}
