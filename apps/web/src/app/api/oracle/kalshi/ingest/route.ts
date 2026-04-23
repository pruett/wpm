import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";

import { requireOracle } from "@/data/auth";
import { tags } from "@/data/tags";
import { runKalshiIngest } from "@/lib/kalshi/ingest";

export async function POST(request: Request) {
  const guard = requireOracle(request);
  if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });

  try {
    const summary = await runKalshiIngest();
    if (summary.totals.created > 0) {
      revalidateTag(tags.marketsAll(), "max");
    }
    return NextResponse.json(summary);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Kalshi ingest failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
