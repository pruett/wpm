import fs from "node:fs";
import Database from "better-sqlite3";
import { expect, test } from "@playwright/test";
import { SIGNUP_AIRDROP } from "@wpm/shared";
import { MAGIC_LINK_CAPTURE_PATH, TEST_DB_PATH } from "../../playwright.config";

function readLatestMagicLinkFor(email: string): string {
  const contents = fs.readFileSync(MAGIC_LINK_CAPTURE_PATH, "utf8");
  const matches = contents
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { email: string; url: string })
    .filter((entry) => entry.email === email);
  if (matches.length === 0) throw new Error(`no magic link captured for ${email}`);
  return matches[matches.length - 1].url;
}

test("new user signup airdrops SIGNUP_AIRDROP and records a Distribute transaction", async ({
  request,
}) => {
  const email = `airdrop-${Date.now()}@test.local`;

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

  const verifyUrl = readLatestMagicLinkFor(email);
  const verifyRes = await request.get(verifyUrl, { maxRedirects: 0 });
  expect([200, 302, 303].includes(verifyRes.status())).toBe(true);

  const sqlite = new Database(TEST_DB_PATH, { readonly: true });
  try {
    const userRow = sqlite.prepare("SELECT id FROM user WHERE email = ?").get(email) as
      | { id: string }
      | undefined;
    expect(userRow).toBeDefined();
    const userId = userRow!.id;

    const balanceRow = sqlite
      .prepare("SELECT amount FROM balances WHERE user_id = ?")
      .get(userId) as { amount: number } | undefined;
    expect(balanceRow?.amount).toBe(SIGNUP_AIRDROP);

    const txRow = sqlite
      .prepare("SELECT type, payload FROM transactions WHERE user_id = ? AND type = 'Distribute'")
      .get(userId) as { type: string; payload: string } | undefined;
    expect(txRow).toBeDefined();
    const payload = JSON.parse(txRow!.payload) as {
      type: string;
      to: string;
      amount: number;
      memo: string;
    };
    expect(payload).toMatchObject({
      type: "Distribute",
      to: userId,
      amount: SIGNUP_AIRDROP,
      memo: "signup_airdrop",
    });
  } finally {
    sqlite.close();
  }
});
