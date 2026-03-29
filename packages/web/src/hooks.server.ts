import { auth } from "$lib/auth";
import { svelteKitHandler } from "better-auth/svelte-kit";
import { building } from "$app/environment";

const STATIC_PREFIXES = ["/_app/", "/favicon"];

export async function handle({ event, resolve }) {
  const isStatic = STATIC_PREFIXES.some((p) => event.url.pathname.startsWith(p));

  if (!isStatic) {
    const session = await auth.api.getSession({
      headers: event.request.headers,
    });

    event.locals.session = session?.session ?? null;
    event.locals.user = session?.user ?? null;
  }

  return svelteKitHandler({ event, resolve, auth, building });
}
