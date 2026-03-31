import { error, type RequestEvent } from "@sveltejs/kit";
import { API_URL } from "@wpm/shared";
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

  const res = await fetch(`${API_URL}${path}`, init);
  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
