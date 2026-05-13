// The realtime bus reads DATABASE_URL_DIRECT at module load. There is no
// PgBouncer in the integration environment, so the direct URL is the same as
// the pooled one — set it before any imports of the bus or db modules.
process.env.DATABASE_URL_DIRECT = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL ?? "";

import postgres from "postgres";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidateTag: () => {} }));

const { client } = await import("@/lib/db");
const { subscribe } = await import("@/lib/realtime/bus");

const CHANNEL = "wpm_invalidations";
const DIRECT_URL = process.env.DATABASE_URL_DIRECT as string;

function waitForTag(predicate: (tag: string) => boolean, timeoutMs = 2000) {
  let unsubscribe: (() => void) | undefined;
  const promise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe?.();
      reject(new Error(`Timed out waiting for matching tag after ${timeoutMs}ms`));
    }, timeoutMs);
    unsubscribe = subscribe((tag) => {
      if (!predicate(tag)) return;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(tag);
    });
  });
  return { promise, cancel: () => unsubscribe?.() };
}

// Notify on a fresh single-use connection — mimics a "writer instance" that
// owns no part of the bus, only emits NOTIFY commands.
async function notifyFromSeparateConnection(tag: string) {
  const writer = postgres(DIRECT_URL, { max: 1 });
  try {
    await writer`SELECT pg_notify(${CHANNEL}, ${tag})`;
  } finally {
    await writer.end({ timeout: 5 });
  }
}

// Keep the bus connection warm for the whole file. A NOTIFY published before
// the LISTEN handshake completes is lost, so we prime the connection up front
// and let the 250ms settle handle the initial registration.
const primer = subscribe(() => {});
await new Promise((r) => setTimeout(r, 250));

afterAll(async () => {
  primer();
  await client.end();
});

describe("realtime bus", () => {
  it("delivers a payload to a subscribed handler", async () => {
    const waiter = waitForTag((t) => t === "market:bus-test-1");
    await notifyFromSeparateConnection("market:bus-test-1");
    await expect(waiter.promise).resolves.toBe("market:bus-test-1");
  });

  it("fans out a single payload to every subscriber", async () => {
    const received: Array<string[]> = [[], [], []];
    const unsubs = received.map((bucket, i) =>
      subscribe((tag) => {
        if (tag === "market:fanout-test") bucket.push(`sub${i}`);
      }),
    );

    try {
      await notifyFromSeparateConnection("market:fanout-test");
      // Allow the LISTEN socket to deliver and the registry to fan out.
      await new Promise((r) => setTimeout(r, 250));
      expect(received[0]).toEqual(["sub0"]);
      expect(received[1]).toEqual(["sub1"]);
      expect(received[2]).toEqual(["sub2"]);
    } finally {
      for (const u of unsubs) u();
    }
  });

  it("stops delivering to a handler after it unsubscribes", async () => {
    const calls: string[] = [];
    const unsub = subscribe((tag) => {
      if (tag === "market:lifecycle-test") calls.push(tag);
    });
    unsub();

    await notifyFromSeparateConnection("market:lifecycle-test");
    // Give the bus enough time to fan out if the handler were (incorrectly)
    // still registered.
    await new Promise((r) => setTimeout(r, 250));
    expect(calls).toEqual([]);
  });

  it("recovers and re-delivers payloads after the listener connection is dropped", async () => {
    // Forcibly terminate the bus's listener backend from a side-channel
    // connection. postgres.js detects the dropped socket, reconnects with the
    // configured exponential backoff, and re-issues LISTEN via its onclose
    // hook. The subscriber registry is untouched across reconnect, so a
    // NOTIFY sent after reconnect should still reach existing handlers.
    const admin = postgres(DIRECT_URL, { max: 1 });
    try {
      await admin`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND query ILIKE ${`%LISTEN%${CHANNEL}%`}
      `;
    } finally {
      await admin.end({ timeout: 5 });
    }

    // Wait long enough for: socket-drop detection + backoff (~0.25–0.5s with
    // jitter on retry 0) + reconnect + LISTEN re-registration. 4s leaves
    // headroom; the next assertion has its own timeout if the reconnect
    // actually fails.
    await new Promise((r) => setTimeout(r, 3000));

    const waiter = waitForTag((t) => t === "market:reconnect-test", 5000);
    await notifyFromSeparateConnection("market:reconnect-test");
    await expect(waiter.promise).resolves.toBe("market:reconnect-test");
  });
});
