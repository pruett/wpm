import { NextResponse } from "next/server";
import { z } from "zod/v4";
import type { CreateMarketRequest } from "@wpm/shared";
import { requireOracle } from "@/lib/auth";
import { db } from "@/lib/db";
import { markets } from "@/lib/db/schema";
import { createMarketAndNotify } from "@/lib/market";

const CreateMarketBody = z.object({
  id: z.string().min(1),
  sport: z.string().min(1),
  name: z.string().min(1),
  teamA: z.string().min(1),
  teamB: z.string().min(1),
  logoA: z.string().optional(),
  logoB: z.string().optional(),
  leagueLogo: z.string().optional(),
  startTime: z.iso.datetime(),
  bettingClosesAt: z.iso.datetime(),
  seedAmount: z.number().positive(),
  initialProbabilityA: z.number().min(0).max(1).optional(),
  reserveA: z.number().positive(),
  reserveB: z.number().positive(),
  wpmReserve: z.number().positive(),
});

export function GET(request: Request) {
  const guard = requireOracle(request);
  if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const rows = db.select().from(markets).all();
  return NextResponse.json(rows);
}

export async function POST(request: Request) {
  const guard = requireOracle(request);
  if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await request.json();
  const parsed = CreateMarketBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const result = createMarketAndNotify(parsed.data as CreateMarketRequest);
  if (result.created) {
    return NextResponse.json({ created: true }, { status: 201 });
  }
  return NextResponse.json({ created: false, reason: result.reason }, { status: 200 });
}
