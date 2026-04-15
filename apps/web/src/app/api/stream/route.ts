import { connection } from "next/server";

const API_BASE = process.env.WPM_API_URL ?? "http://localhost:4101";

export async function GET() {
  await connection();
  const upstream = await fetch(`${API_BASE}/events/stream`, {
    cache: "no-store",
  });

  if (!upstream.ok || !upstream.body) {
    return new Response("upstream unavailable", { status: 502 });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
