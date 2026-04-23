import type { CreateMarketRequest } from "@wpm/shared";

import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { z } from "zod/v4";

import { requireOracle } from "@/data/auth";
import { createMarket, listAllMarketsRaw } from "@/data/markets";
import { tags } from "@/data/tags";

const CreateMarketBody = z.object({
  id: z.string().min(1),
  sport: z.string().min(1),
  name: z.string().min(1),
  teamA: z.string().min(1),
  teamB: z.string().min(1),
  tickerA: z.string().optional(),
  tickerB: z.string().optional(),
  closesAt: z.iso.datetime(),
  seedAmount: z.number().positive(),
  initialProbabilityA: z.number().min(0).max(1).optional(),
  reserveA: z.number().positive(),
  reserveB: z.number().positive(),
  wpmReserve: z.number().positive(),
});

export async function GET(request: Request) {
  const guard = requireOracle(request);
  if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const rows = await listAllMarketsRaw();
  return NextResponse.json(rows);
}

export async function POST(request: Request) {
  const guard = requireOracle(request);
  if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = CreateMarketBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const result = await createMarket(parsed.data as CreateMarketRequest);
  if (result.created) {
    revalidateTag(tags.marketsAll(), "max");
    return NextResponse.json({ created: true }, { status: 201 });
  }
  return NextResponse.json({ created: false, reason: result.reason }, { status: 200 });
}
