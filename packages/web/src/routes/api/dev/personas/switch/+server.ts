// DEV-PERSONAS — switch / clear the active dev persona. Disabled outside dev.
import { dev } from "$app/environment";
import { error, json } from "@sveltejs/kit";
import { listPersonas, PERSONA_COOKIE } from "$lib/dev-personas/index.js";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, cookies }) => {
  if (!dev) throw error(404);

  const body = (await request.json().catch(() => null)) as { email?: string } | null;
  const email = body?.email;
  if (!email) throw error(400, "missing email");

  const exists = listPersonas().some((p) => p.email === email);
  if (!exists) throw error(404, `no persona for ${email}`);

  cookies.set(PERSONA_COOKIE, email, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 7,
  });
  return json({ ok: true, active: email });
};

export const DELETE: RequestHandler = ({ cookies }) => {
  if (!dev) throw error(404);
  cookies.delete(PERSONA_COOKIE, { path: "/" });
  return json({ ok: true, active: null });
};
