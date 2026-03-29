import { error, type RequestEvent } from "@sveltejs/kit";
import { auth } from "$lib/auth";
import { getWalletToken } from "./wallet.js";

/**
 * Proxy an authenticated request to the Effect API.
 * Validates the better-auth session, resolves the wallet Bearer token,
 * and forwards the request.
 */
export async function proxyToApi(
  event: RequestEvent,
  path: string,
  method: "GET" | "POST" = "GET",
): Promise<Response> {
  const session = await auth.api.getSession({
    headers: event.request.headers,
  });
  if (!session) {
    throw error(401, "Not authenticated");
  }

  const { token } = await getWalletToken(session.user.email, session.user.name);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  const init: RequestInit = { method, headers };

  if (method === "POST") {
    headers["Content-Type"] = "application/json";
    init.body = await event.request.text();
  }

  const apiUrl = process.env.EFFECT_API_URL || "http://localhost:4101";
  const res = await fetch(`${apiUrl}${path}`, init);
  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
