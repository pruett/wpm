import { error, type RequestEvent } from "@sveltejs/kit";
import { EFFECT_API_URL } from "./config.js";
import { getWalletToken } from "./wallet.js";

export async function proxyToApi(
  event: RequestEvent,
  path: string,
  method: "GET" | "POST" = "GET",
): Promise<Response> {
  const user = event.locals.user;
  if (!user) {
    throw error(401, "Not authenticated");
  }

  const { token } = await getWalletToken(user.email, user.name);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  const init: RequestInit = { method, headers };

  if (method === "POST") {
    headers["Content-Type"] = "application/json";
    init.body = await event.request.text();
  }

  const res = await fetch(`${EFFECT_API_URL}${path}`, init);
  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
