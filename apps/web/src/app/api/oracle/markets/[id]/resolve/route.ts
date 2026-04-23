import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { z } from "zod/v4";

import { requireOracle } from "@/data/auth";
import { resolveMarket } from "@/data/markets";
import { tags } from "@/data/tags";
import { emit } from "@/lib/events/emit";

const ResolveBody = z.object({
  outcome: z.enum(["A", "B"]),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireOracle(request);
  if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = ResolveBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const result = await resolveMarket(id, parsed.data.outcome);
  if (!result.resolved) {
    return NextResponse.json({ resolved: false, reason: result.reason }, { status: 409 });
  }

  revalidateTag(tags.market(id), "max");
  revalidateTag(tags.marketsAll(), "max");
  revalidateTag(tags.leaderboard(), "max");
  for (const u of result.affectedUsers) {
    revalidateTag(tags.viewer(u.userId), "max");
  }

  emit.marketResolved(id, parsed.data.outcome);
  for (const u of result.affectedUsers) {
    emit.balanceUpdate(u.userId, u.newBalance);
  }

  return NextResponse.json({ resolved: true });
}
