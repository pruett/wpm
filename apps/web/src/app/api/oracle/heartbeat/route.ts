import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { z } from "zod/v4";
import { ORACLE_JOBS } from "@wpm/shared";
import { requireOracle } from "@/data/auth";
import { recordHeartbeat } from "@/data/oracle";
import { tags } from "@/data/tags";

const HeartbeatBody = z.object({
  job: z.enum(ORACLE_JOBS),
  status: z.enum(["ok", "error"]),
  message: z.string().optional(),
});

export async function POST(request: Request) {
  const guard = requireOracle(request);
  if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = HeartbeatBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const { job, status, message } = parsed.data;
  await recordHeartbeat(job, status, message ?? null);

  revalidateTag(tags.oracleHeartbeats(), "max");
  return NextResponse.json({ ok: true });
}
