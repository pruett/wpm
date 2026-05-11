import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";

import { tags } from "@/data/tags";
import { runKalshiResolve } from "@/lib/kalshi/resolve";

export const maxDuration = 300;

export async function GET(request: Request) {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  const expected = process.env.CRON_SECRET;
  if (!expected || token !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await runKalshiResolve();
    if (summary.totals.resolved > 0 || summary.totals.cancelled > 0) {
      revalidateTag(tags.marketsAll(), "max");
    }
    for (const eventId of summary.totals.committedEventIds) {
      revalidateTag(tags.event(eventId), "max");
    }
    return NextResponse.json(summary);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Kalshi resolve failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
