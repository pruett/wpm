// The realtime bus reads DATABASE_URL_DIRECT at module load. There is no
// PgBouncer in the integration environment, so the direct URL is the same as
// the pooled one — set it before any imports of the bus or db modules.
process.env.DATABASE_URL_DIRECT = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL ?? "";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidateTag: () => {} }));

const { db, client } = await import("@/lib/db");
const { invalidate } = await import("@/data/invalidate");
const { subscribe } = await import("@/lib/realtime/bus");

function waitForTag(expected: string, timeoutMs = 2000) {
  let unsubscribe: (() => void) | undefined;
  const promise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe?.();
      reject(new Error(`Timed out waiting for tag "${expected}" after ${timeoutMs}ms`));
    }, timeoutMs);
    unsubscribe = subscribe((tag) => {
      if (tag !== expected) return;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(tag);
    });
  });
  return { promise, cancel: () => unsubscribe?.() };
}

// Give the bus listener connection a head start — the first subscriber kicks
// off the LISTEN handshake asynchronously, and a NOTIFY published before the
// handshake completes is lost. The bus is module-scoped so this primer runs
// once for the whole file.
const primer = subscribe(() => {});
// Allow LISTEN to register on the listener connection.
await new Promise((r) => setTimeout(r, 250));

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  primer();
  await client.end();
});

describe("invalidate(tag)", () => {
  it("delivers a NOTIFY to bus subscribers when called outside a transaction", async () => {
    const waiter = waitForTag("market:invalidate-test-1");
    await invalidate("market:invalidate-test-1");
    await expect(waiter.promise).resolves.toBe("market:invalidate-test-1");
  });

  it("delivers a NOTIFY when called inside a committed transaction", async () => {
    const waiter = waitForTag("market:invalidate-test-2");
    await db.transaction(async (tx) => {
      await invalidate("market:invalidate-test-2", tx);
    });
    await expect(waiter.promise).resolves.toBe("market:invalidate-test-2");
  });

  it("does NOT deliver a NOTIFY when the surrounding transaction rolls back", async () => {
    const waiter = waitForTag("market:invalidate-test-3", 750);
    await expect(
      db.transaction(async (tx) => {
        await invalidate("market:invalidate-test-3", tx);
        throw new Error("force-rollback");
      }),
    ).rejects.toThrow("force-rollback");
    await expect(waiter.promise).rejects.toThrow(/Timed out/);
    waiter.cancel();
  });
});
