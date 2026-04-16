import { NextResponse } from "next/server";
import { z } from "zod/v4";
import { requireOracle } from "@/lib/auth";
import { resolveMarket } from "@/lib/market";

const ResolveBody = z.object({
  outcome: z.enum(["A", "B"]),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = requireOracle(request);
  if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await params;
  const body = await request.json();
  const parsed = ResolveBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const result = resolveMarket(id, parsed.data.outcome);
  if (result.resolved) {
    return NextResponse.json({ resolved: true });
  }
  return NextResponse.json({ resolved: false, reason: result.reason }, { status: 409 });
}
