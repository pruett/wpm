import { test as base } from "@playwright/test";
import postgres from "postgres";

import { TEST_DATABASE_URL } from "../../playwright.config";

export type TestCleanup = {
  trackUser: (email: string) => void;
};

export const test = base.extend<{ cleanup: TestCleanup }>({
  cleanup: async ({}, use) => {
    const emails: string[] = [];
    await use({ trackUser: (email) => emails.push(email) });

    if (emails.length === 0) return;

    const sql = postgres(TEST_DATABASE_URL);
    try {
      await sql`
        delete from transactions
        where user_id in (select id from "user" where email = any(${emails}))
      `;
      await sql`delete from "user" where email = any(${emails})`;
    } finally {
      await sql.end();
    }
  },
});

export { expect } from "@playwright/test";
