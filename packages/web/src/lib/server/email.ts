import { Resend } from "resend";

let resend: Resend | undefined;

export function getResend(): Resend {
  resend ??= new Resend(process.env.RESEND_API_KEY || "");
  return resend;
}

export const EMAIL_FROM = process.env.EMAIL_FROM || "WPM <noreply@example.com>";
