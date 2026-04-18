import { getSession } from "@/data/auth";
import { subscribe, type RealtimeEvent } from "@/lib/events/bus";

const HEARTBEAT_MS = 15_000;

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return new Response(null, { status: 204 });

  const userId = session.user.id;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {}
      };

      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          cleanup();
        }
      };

      const send = (event: RealtimeEvent) => {
        if (event.type === "balance:update" && event.userId !== userId) return;
        const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        safeEnqueue(encoder.encode(frame));
      };

      const unsubscribe = subscribe(send);
      const heartbeat = setInterval(() => safeEnqueue(encoder.encode(": ping\n\n")), HEARTBEAT_MS);

      req.signal.addEventListener("abort", cleanup);
      safeEnqueue(encoder.encode(": connected\n\n"));
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
