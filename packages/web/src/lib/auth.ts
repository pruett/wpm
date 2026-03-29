import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { sveltekitCookies } from "better-auth/svelte-kit";
import { passkey } from "@better-auth/passkey";
import { Resend } from "resend";
import { getRequestEvent } from "$app/server";
import { db } from "./server/db.js";
import { validateInviteCode } from "./server/invite-store.js";

function e(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function getResend() {
  return new Resend(e("RESEND_API_KEY", ""));
}

export const auth = betterAuth({
  baseURL: e("BETTER_AUTH_URL", "http://localhost:5173"),
  secret: e("BETTER_AUTH_SECRET", "dev-secret-change-me-in-production"),
  database: db,
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url, metadata }) => {
        console.log("[auth] sendMagicLink called", { email, url, metadata });

        if (metadata?.inviteCode) {
          const valid = validateInviteCode(metadata.inviteCode as string);
          if (!valid) {
            throw new Error("Invalid or used invite code");
          }
        }

        try {
          const result = await getResend().emails.send({
            from: e("EMAIL_FROM", "WPM <noreply@example.com>"),
            to: email,
            subject: "Your WPM login link",
            html: `<a href="${url}">Click here to sign in to WPM</a>`,
          });
          console.log("[auth] Resend result:", result);
        } catch (err) {
          console.error("[auth] Resend error:", err);
          throw err;
        }
      },
    }),
    passkey({
      rpID: e("RP_ID", "localhost"),
      rpName: "WPM",
      origin: e("ORIGIN", "http://localhost:5173"),
    }),
    sveltekitCookies(getRequestEvent), // must be last plugin
  ],
});
