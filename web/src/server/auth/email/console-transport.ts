/**
 * Console email transport (account-creation design.md § Component Design,
 * Phase 2; AD-6).
 *
 * The dev/test transport: it NEVER performs network I/O and NEVER sends real
 * mail. Instead it logs the OTP code (so a local developer can read it from
 * stdout) and records each send in a small in-memory ring buffer that tests
 * import to capture the most recently "sent" code.
 *
 * The ring is module-level state shared by every instance, so test capture
 * works no matter which `ConsoleEmailTransport` the factory hands out.
 */

import { logger } from "@/server/logger";

import type { EmailTransport } from "./transport";

/** One captured OTP "send" recorded by the console transport. */
export interface SentOtpEmail {
  /** Normalized recipient email address. */
  to: string;
  /** The 6-digit OTP code (BR-A3). */
  code: string;
  /** Epoch ms when it was recorded. */
  sentAt: number;
}

/** Max retained captures; oldest are dropped past this (bounds memory). */
const RING_CAPACITY = 50;

/** Shared in-memory capture ring (newest last). */
const ring: SentOtpEmail[] = [];

/** Snapshot of all currently-captured sends, oldest → newest. */
export function getSentOtpEmails(): readonly SentOtpEmail[] {
  return [...ring];
}

/** The most recently captured send, or undefined if none. */
export function getLastSentOtpEmail(): SentOtpEmail | undefined {
  return ring[ring.length - 1];
}

/** Clear the capture ring. Call between test cases for isolation. */
export function clearSentOtpEmails(): void {
  ring.length = 0;
}

/**
 * Dev/test {@link EmailTransport}. Logs the code and records it for capture;
 * does no network I/O.
 */
export class ConsoleEmailTransport implements EmailTransport {
  async sendOtpEmail(to: string, code: string): Promise<void> {
    ring.push({ to, code, sentAt: Date.now() });
    while (ring.length > RING_CAPACITY) ring.shift();

    // Surface the code locally — this transport's whole purpose in dev/test
    // (design.md "console-transport … logs code"). Never used in production,
    // where the Resend transport is selected and codes are never logged.
    logger.info(
      { event: "otp_email_console", to, code },
      "console email transport: OTP code (dev/test only, not delivered)",
    );
  }
}

/** Shared singleton handed out by `getEmailTransport()`. */
export const consoleEmailTransport = new ConsoleEmailTransport();
