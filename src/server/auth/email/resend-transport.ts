/**
 * Resend email transport (account-creation design.md § Tech Stack /
 * § Component Design, Phase 2; AD-6).
 *
 * A tiny `fetch`-based client — no new npm dependency, matching the codebase's
 * lean-deps posture. It POSTs to the Resend "send email" endpoint with the API
 * key as a bearer token. A non-2xx response THROWS a transport fault; the
 * caller (`auth-service`) catches it and maps it to the in-domain
 * `email_failed` result (it does not retry or model failure shapes here).
 */

import type { EmailTransport } from "./transport";

/** Resend "send an email" REST endpoint. */
const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** OTP code validity window, surfaced in the email copy (BR-A3). */
const OTP_TTL_MINUTES = 10;

/** Build the subject + html/text bodies for an OTP email. */
function buildOtpEmail(code: string): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = "Your Oak sign-in code";
  const text =
    `Your Oak sign-in code is ${code}.\n\n` +
    `It expires in ${OTP_TTL_MINUTES} minutes and can be used once. ` +
    `If you did not request this, you can ignore this email.`;
  const html =
    `<p>Your Oak sign-in code is:</p>` +
    `<p style="font-size:24px;font-weight:bold;letter-spacing:4px">${code}</p>` +
    `<p>It expires in ${OTP_TTL_MINUTES} minutes and can be used once. ` +
    `If you did not request this, you can ignore this email.</p>`;
  return { subject, text, html };
}

/**
 * Production {@link EmailTransport} backed by Resend. Constructed by
 * `getEmailTransport()` with the resolved API key and from-address.
 */
export class ResendEmailTransport implements EmailTransport {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async sendOtpEmail(to: string, code: string): Promise<void> {
    const { subject, text, html } = buildOtpEmail(code);

    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: [to],
        subject,
        text,
        html,
      }),
    });

    if (!response.ok) {
      // Transport fault — let it throw. `auth-service` maps this to
      // `email_failed` (design.md § Interface Definitions). Best-effort read of
      // the body for a useful log message; the raw code is never included.
      let detail = "";
      try {
        detail = await response.text();
      } catch {
        // ignore — body read is best-effort only
      }
      throw new Error(
        `Resend email send failed: ${response.status} ${response.statusText}` +
          (detail ? ` — ${detail}` : ""),
      );
    }
  }
}
