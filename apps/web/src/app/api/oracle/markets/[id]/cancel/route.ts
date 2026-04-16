import { NextResponse } from "next/server";
import { z } from "zod/v4";
import { requireOracle } from "@/lib/auth";
import { cancelMarket } from "@/lib/market";

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

  const result = cancelMarket(id, reason);
  if (result.cancelled) {
    return NextResponse.json({ cancelled: true });
  }
  return NextResponse.json({ cancelled: false, reason: result.reason }, { status: 409 });
}
