import { NextResponse } from "next/server";

import { requireUser } from "@/data/auth";
import { subscribe } from "@/lib/realtime/bus";

export const dynamic = "force-dynamic";

export async function GET() {
  const result = await requireUser();
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 401 });
  }

  const userId = result.session.user.id;
  const viewerTag = `viewer:${userId}`;
  const encoder = new TextEncoder();
  const HEARTBEAT_MS = 25_000;
  const SELF_TERMINATE_MS = 270_000;

  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let selfTerminate: ReturnType<typeof setTimeout> | null = null;

  const teardown = () => {
    unsubscribe?.();
    unsubscribe = null;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (selfTerminate) {
      clearTimeout(selfTerminate);
      selfTerminate = null;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      unsubscribe = subscribe((tag) => {
        if (tag.startsWith("viewer:") && tag !== viewerTag) return;
        const frame = `event: invalidate\ndata: ${JSON.stringify({ tag })}\n\n`;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          teardown();
        }
      });

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":keepalive\n\n"));
        } catch {
          teardown();
        }
      }, HEARTBEAT_MS);

      selfTerminate = setTimeout(() => {
        try {
          controller.enqueue(encoder.encode("event: reconnect\ndata: {}\n\n"));
          controller.close();
        } catch {
          // controller already closed
        }
        teardown();
      }, SELF_TERMINATE_MS);
    },
    cancel() {
      teardown();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
