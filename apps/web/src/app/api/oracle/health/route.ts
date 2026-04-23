import { NextResponse } from "next/server";

import { requireOracle } from "@/data/auth";

export function GET(request: Request) {
  const guard = requireOracle(request);
  if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });
  return NextResponse.json({ ok: true });
}
