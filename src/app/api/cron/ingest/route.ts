import { NextResponse } from "next/server";

import { runKalshiIngest } from "@/lib/kalshi/ingest";

export const maxDuration = 300;

export async function GET(request: Request) {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  const expected = process.env.CRON_SECRET;
  if (!expected || token !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await runKalshiIngest();
    return NextResponse.json(summary);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Kalshi ingest failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
