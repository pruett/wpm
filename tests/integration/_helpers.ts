import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { events as eventsTable } from "@/lib/db/schema";

// Fixtures carry past `closesAt` values; live `placeBet` rejects after close.
// Pushes an Event's `closesAt` to a future epoch so the betting step accepts.
export async function bumpEventClosesAt(
  eventId: string,
  offsetMs: number = 60 * 60 * 1000,
): Promise<void> {
  await db
    .update(eventsTable)
    .set({ closesAt: Date.now() + offsetMs })
    .where(eq(eventsTable.id, eventId));
}
