console.log("[hooks] loading hooks.server.ts");

import { auth } from "$lib/auth";
import { svelteKitHandler } from "better-auth/svelte-kit";
import { building } from "$app/environment";

console.log("[hooks] auth loaded, building =", building);

export async function handle({ event, resolve }) {
  console.log("[hooks] handle called:", event.request.method, event.url.pathname);

  const session = await auth.api.getSession({
    headers: event.request.headers,
  });

  event.locals.session = session?.session ?? null;
  event.locals.user = session?.user ?? null;

  return svelteKitHandler({ event, resolve, auth, building });
}
