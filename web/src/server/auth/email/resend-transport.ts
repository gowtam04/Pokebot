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

/**
 * Build the subject + html/text bodies for an OTP email.
 *
 * The HTML is a self-contained, email-client-safe document (table layout,
 * inline styles, web-font with graceful Arial/Courier fallback) themed after
 * Oak — a clean white card with a Poké Ball–red accent and the code in a
 * contained mono "well". A hidden preheader controls the inbox-preview snippet
 * so it no longer leaks the raw code. The `text` part is the plain-text
 * fallback for clients that don't render HTML.
 */
function buildOtpEmail(code: string): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = "Your Oak sign-in code";
  const text =
    `Your Oak sign-in code is ${code}.\n\n` +
    `It expires in ${OTP_TTL_MINUTES} minutes and can be used once. ` +
    `If you did not request this, you can safely ignore this email — ` +
    `no one can sign in without the code.\n\n` +
    `Oak · your Pokémon research companion`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${subject}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap');
  body { margin:0; padding:0; background:#F3F4F2; }
</style>
</head>
<body style="margin:0;padding:0;background:#F3F4F2;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">Your Oak sign-in code expires in ${OTP_TTL_MINUTES} minutes. Open to view it.</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F2;">
    <tr>
      <td align="center" style="padding:56px 16px;">

        <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#FFFFFF;border-radius:20px;border:1px solid #E6E7E4;box-shadow:0 20px 48px -32px rgba(20,20,20,0.35);overflow:hidden;">

          <tr><td style="height:6px;background:#EE1515;font-size:0;line-height:0;">&nbsp;</td></tr>

          <tr>
            <td style="padding:40px 48px 0 48px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align:middle;">
                    <div style="width:26px;height:26px;border-radius:50%;background:#EE1515;background-image:linear-gradient(180deg,#EE1515 0%,#EE1515 46%,#1A1A1A 46%,#1A1A1A 54%,#FFFFFF 54%,#FFFFFF 100%);border:2px solid #1A1A1A;box-sizing:border-box;"></div>
                  </td>
                  <td style="vertical-align:middle;padding-left:10px;font-family:'Sora',Arial,sans-serif;font-size:18px;font-weight:700;letter-spacing:-0.3px;color:#16181A;">Oak</td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:32px 48px 0 48px;">
              <h1 style="margin:0 0 14px 0;font-family:'Sora',Arial,sans-serif;font-size:27px;font-weight:600;line-height:1.25;letter-spacing:-0.6px;color:#16181A;">Here's your sign-in code</h1>
              <p style="margin:0 0 30px 0;font-family:'Sora',Arial,sans-serif;font-size:15px;line-height:1.65;color:#6A6F73;">Use the code below to finish signing in to Oak. For your security, it expires shortly and works only once.</p>
            </td>
          </tr>

          <tr>
            <td style="padding:0 48px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAF9;border:1px solid #ECEDEA;border-radius:14px;">
                <tr>
                  <td align="center" style="padding:30px 16px 26px 16px;">
                    <div style="font-family:'Sora',Arial,sans-serif;font-size:11px;font-weight:600;letter-spacing:2.5px;text-transform:uppercase;color:#A2A7AB;margin-bottom:14px;">Sign-in code</div>
                    <div style="font-family:'JetBrains Mono','Courier New',monospace;font-size:42px;font-weight:700;letter-spacing:14px;color:#16181A;padding-left:14px;">${code}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td align="center" style="padding:18px 48px 0 48px;">
              <p style="margin:0;font-family:'Sora',Arial,sans-serif;font-size:13px;color:#9aa0a4;">Expires in <strong style="color:#16181A;font-weight:600;">${OTP_TTL_MINUTES} minutes</strong>&nbsp;·&nbsp;single use</p>
            </td>
          </tr>

          <tr>
            <td style="padding:34px 48px 38px 48px;">
              <div style="border-top:1px solid #EFEFEC;padding-top:20px;">
                <p style="margin:0;font-family:'Sora',Arial,sans-serif;font-size:12px;line-height:1.6;color:#A2A7AB;">If you didn't request this, you can safely ignore this email — no one can sign in without the code.</p>
              </div>
            </td>
          </tr>

        </table>

        <p style="margin:22px 0 0 0;font-family:'Sora',Arial,sans-serif;font-size:11px;color:#B7BBBE;">Oak · your Pokémon research companion</p>
      </td>
    </tr>
  </table>
</body>
</html>`;
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
