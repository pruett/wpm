import fs from "node:fs";
import postgres from "postgres";

import { MAGIC_LINK_CAPTURE_PATH, TEST_DATABASE_URL } from "../../playwright.config";
import { SIGNUP_AIRDROP } from "../../src/lib/constants";
import { expect, test } from "./fixtures";

function readLatestMagicLinkFor(email: string): string {
  const entries = fs
    .readFileSync(MAGIC_LINK_CAPTURE_PATH, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { email: string; url: string })
    .filter((entry) => entry.email === email);
  if (entries.length === 0) throw new Error(`no magic link captured for ${email}`);
  return entries[entries.length - 1].url;
}

test("new user signup airdrops SIGNUP_AIRDROP and records a Distribute transaction", async ({
  request,
  cleanup,
}) => {
  const email = `airdrop-${Date.now()}@test.local`;
  cleanup.trackUser(email);

  const signInRes = await request.post("/api/auth/sign-in/magic-link", {
    data: {
      email,
      name: "Airdrop Tester",
      displayName: "Airdrop Tester",
      color: "#ff0000",
      icon: "star",
      callbackURL: "/",
    },
  });
  expect(signInRes.ok()).toBe(true);

  const verifyRes = await request.get(readLatestMagicLinkFor(email), { maxRedirects: 0 });
  expect([200, 302, 303]).toContain(verifyRes.status());

  const sql = postgres(TEST_DATABASE_URL);
  try {
    const [userRow] = await sql<{ id: string }[]>`
      select id from "user" where email = ${email}
    `;
    expect(userRow).toBeDefined();

    const [balance] = await sql<{ amount: string }[]>`
      select amount from balances where user_id = ${userRow.id}
    `;
    expect(Number(balance?.amount)).toBe(SIGNUP_AIRDROP);

    const [tx] = await sql<{ payload: string }[]>`
      select payload from transactions
      where user_id = ${userRow.id} and type = 'Distribute'
    `;
    expect(tx).toBeDefined();
    expect(JSON.parse(tx.payload)).toMatchObject({
      type: "Distribute",
      to: userRow.id,
      amount: SIGNUP_AIRDROP,
      memo: "signup_airdrop",
    });
  } finally {
    await sql.end();
  }
});
