import { Hono } from "hono";
import { verifyJwt } from "../middleware/auth";
import { sendError } from "../errors";
import { getRelay } from "../sse/relay";

const events = new Hono();

events.get("/events/stream", async (c) => {
  // SSE connections use ?token= query param for auth (EventSource doesn't support headers)
  const token = c.req.query("token");
  if (!token) {
    return sendError(c, "UNAUTHORIZED", "Missing token query parameter");
  }

  let payload: Awaited<ReturnType<typeof verifyJwt>>;
  try {
    payload = await verifyJwt(token);
  } catch {
    return sendError(c, "UNAUTHORIZED", "Invalid or expired token");
  }

  const relay = getRelay();
  const stream = relay.addClient(payload.sub);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

export { events };
