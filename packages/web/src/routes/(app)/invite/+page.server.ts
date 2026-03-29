import { fail } from "@sveltejs/kit";
import { Resend } from "resend";
import { createInviteCode, listInviteCodes } from "$lib/server/invite-store.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => {
  const invites = listInviteCodes(locals.user!.email);
  return { invites };
};

export const actions = {
  default: async ({ request, locals, url }) => {
    const data = await request.formData();
    const email = data.get("email")?.toString().trim();

    if (!email) {
      return fail(400, { error: "Email is required" });
    }

    const code = createInviteCode(locals.user!.email, email);
    const signupUrl = `${url.origin}/signup?code=${code}`;

    if (process.env.RESEND_API_KEY) {
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: process.env.EMAIL_FROM || "WPM <noreply@example.com>",
        to: email,
        subject: `${locals.user!.name} invited you to WPM`,
        html: `<p>${locals.user!.name} invited you to join WPM, a prediction market for friends.</p><p><a href="${signupUrl}">Click here to join</a></p>`,
      });
    }

    return { success: true, code, email };
  },
} satisfies Actions;
