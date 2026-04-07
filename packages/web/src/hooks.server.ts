import { auth } from "$lib/auth";
import { svelteKitHandler } from "better-auth/svelte-kit";
import { building } from "$app/environment";
// DEV-PERSONAS: remove this import and the applyDevPersona() call below to disable.
import { applyDevPersona } from "$lib/dev-personas/index.js";

const STATIC_PREFIXES = ["/_app/", "/favicon"];

export async function handle({ event, resolve }) {
  const isStatic = STATIC_PREFIXES.some((p) => event.url.pathname.startsWith(p));

  if (!isStatic) {
    const session = await auth.api.getSession({
      headers: event.request.headers,
    });

    event.locals.session = session?.session ?? null;
    event.locals.user = session?.user ?? null;

    // DEV-PERSONAS: no-op outside dev; in dev, overrides locals.user/session
    // when the wpm-dev-persona cookie is set.
    applyDevPersona(event);
  }

  return svelteKitHandler({ event, resolve, auth, building });
}
