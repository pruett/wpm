import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { sveltekitCookies } from "better-auth/svelte-kit";
import { passkey } from "@better-auth/passkey";
import { getRequestEvent } from "$app/server";
import { db } from "./server/db.js";
import { EMAIL_FROM, getResend } from "./server/email.js";
import { validateInviteCode } from "./server/invite-store.js";

function env(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const auth = betterAuth({
  baseURL: env("BETTER_AUTH_URL", "http://localhost:5173"),
  secret: env("BETTER_AUTH_SECRET", "dev-secret-change-me-in-production"),
  database: db,
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url, metadata }) => {
        if (metadata?.inviteCode) {
          const valid = validateInviteCode(metadata.inviteCode as string);
          if (!valid) {
            throw new Error("Invalid or used invite code");
          }
        }

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
      origin: env("ORIGIN", "http://localhost:5173"),
    }),
    sveltekitCookies(getRequestEvent),
  ],
});
