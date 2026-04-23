import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { z } from "zod/v4";

import { requireOracle } from "@/data/auth";
import { cancelMarket } from "@/data/markets";
import { tags } from "@/data/tags";
import { emit } from "@/lib/events/emit";

const CancelBody = z.object({
  reason: z.string().optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireOracle(request);
  if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await params;
  let reason: string | undefined;
  try {
    const body = await request.json();
    const parsed = CancelBody.safeParse(body);
    if (parsed.success) reason = parsed.data.reason;
  } catch {
    // empty body is fine for cancel
  }

  const result = await cancelMarket(id, reason);
  if (!result.cancelled) {
    return NextResponse.json({ cancelled: false, reason: result.reason }, { status: 409 });
  }

  revalidateTag(tags.market(id), "max");
  revalidateTag(tags.marketsAll(), "max");
  revalidateTag(tags.leaderboard(), "max");
  for (const u of result.affectedUsers) {
    revalidateTag(tags.viewer(u.userId), "max");
  }
  for (const u of result.affectedUsers) {
    emit.balanceUpdate(u.userId, u.newBalance);
  }

  return NextResponse.json({ cancelled: true });
}
