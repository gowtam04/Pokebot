/**
 * Transactional email transport for account-creation OTP codes
 * (account-creation design.md § Interface Definitions / § Component Design,
 * Phase 2; AD-6).
 *
 * One small interface with two implementations selected at runtime:
 *  - `RESEND_API_KEY` present → the fetch-based Resend client (real delivery).
 *  - otherwise              → the console transport (dev/test; never sends mail,
 *                             records the code in-memory for test capture).
 *
 * `sendOtpEmail` THROWS only on a genuine delivery/transport fault (e.g. a
 * non-2xx Resend response). `auth-service` catches that and maps it to the
 * in-domain `email_failed` result — the transport itself does not model
 * in-domain failure shapes.
 */

import { env } from "@/env";

import { consoleEmailTransport } from "./console-transport";
import { ResendEmailTransport } from "./resend-transport";

/**
 * The single seam the auth layer depends on. `to` is a normalized email
 * address; `code` is the 6-digit OTP (BR-A3). Resolves on a successful send,
 * rejects (throws) on a transport fault.
 */
export interface EmailTransport {
  sendOtpEmail(to: string, code: string): Promise<void>;
}

/**
 * Resolved configuration for {@link getEmailTransport}. Optional overrides let
 * tests pick a transport deterministically without mutating `process.env`;
 * production callers pass nothing and the values come from the validated `env`.
 */
export interface EmailTransportConfig {
  /** Resend API key. Falsy/absent ⇒ console transport. */
  apiKey?: string;
  /** From-address used by the Resend transport. */
  from?: string;
}

/**
 * Factory: choose the email transport for the current environment.
 *
 * Selection rule (design.md § Interface Definitions): a non-empty
 * `RESEND_API_KEY` ⇒ Resend; otherwise the console transport. The console
 * transport is a shared singleton so its in-memory capture ring is visible to
 * tests regardless of where the factory is called.
 */
export function getEmailTransport(
  config: EmailTransportConfig = {},
): EmailTransport {
  const apiKey = config.apiKey ?? env.RESEND_API_KEY;
  const from = config.from ?? env.EMAIL_FROM;

  if (typeof apiKey === "string" && apiKey.length > 0) {
    return new ResendEmailTransport(apiKey, from);
  }
  return consoleEmailTransport;
}
