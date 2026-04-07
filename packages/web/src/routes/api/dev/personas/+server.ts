// DEV-PERSONAS — list available personas. Disabled outside dev.
import { dev } from "$app/environment";
import { error, json } from "@sveltejs/kit";
import { listPersonas, PERSONA_COOKIE } from "$lib/dev-personas/index.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ cookies }) => {
  if (!dev) throw error(404);
  return json({
    personas: listPersonas(),
    active: cookies.get(PERSONA_COOKIE) ?? null,
  });
};
