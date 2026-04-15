import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { passkey } from "@better-auth/passkey";
import { EMAIL_FROM, getResend } from "./email";

function env(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function getDatabase() {
  const Database = require("better-sqlite3");
  return new Database(env("DATABASE_PATH", "data/wpm.db"));
}

export const auth = betterAuth({
  baseURL: env("BETTER_AUTH_URL", "http://localhost:4102"),
  secret: env("BETTER_AUTH_SECRET", "dev-secret-change-me-in-production"),
  database: getDatabase,
  user: {
    additionalFields: {
      walletPublicKey: {
        type: "string",
        required: false,
        input: false,
        returned: true,
      },
    },
  },
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        if (process.env.NODE_ENV === "development") {
          console.log(`[Magic Link] ${email}: ${url}`);
          return;
        }

        const result = await getResend().emails.send({
          from: EMAIL_FROM,
          to: email,
          subject: "Your WPM login link",
          html: `<a href="${url}">Click here to sign in to WPM</a>`,
        });

        if (result.error) {
          throw new Error(result.error.message);
        }
      },
    }),
    passkey({
      rpID: env("RP_ID", "localhost"),
      rpName: "WPM",
      origin: env("ORIGIN", "http://localhost:4102"),
    }),
    nextCookies(),
  ],
});
