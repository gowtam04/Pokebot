"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  requestCode,
  verifyCode,
  type VerifyCodeResult,
} from "@/lib/auth-client";

/**
 * AuthDialog — the two-step passwordless sign-in dialog (account-creation
 * design.md § File Structure "AuthDialog.tsx"; UI/UX Vision "Two-step auth UI";
 * Phase 6 / p6).
 *
 * Step 1 (email): a single email field → "Send code". Step 2 (code): a 6-digit
 * code field → "Verify", a "Resend code" control disabled during the cooldown
 * with the remaining seconds shown (AC-3.1), and a "Use a different email" back
 * link to correct a mistyped address (AC-2.7).
 *
 * The flow is NON-ENUMERATING (BR-A1 / AC-2.2): a successful `request-code`
 * ALWAYS advances to the code step with the same generic "code sent" message,
 * whether or not the email is registered — the dialog has no branch that reveals
 * account existence. On a verified code the parent is told via
 * `onSignedIn({ created })` (`created` ⇒ first-time signup AC-2.3 vs returning
 * login AC-2.4); the parent updates auth state WITHOUT resetting the on-screen
 * conversation (BR-A10).
 *
 * All network calls go through `@/lib/auth-client` (no direct `fetch` here), so
 * this component stays a pure jsdom-testable unit. Styling lives in the global
 * BEM `auth-dialog` block (`src/app/globals.css`).
 */

export interface AuthDialogProps {
  /** Whether the dialog is shown. State resets each time this turns true. */
  open: boolean;
  /** Dismiss the dialog (backdrop click, close button, Escape). */
  onClose: () => void;
  /** Called once a code is verified. `created` ⇒ a new account was made. */
  onSignedIn: (result: { created: boolean }) => void;
}

/** Resend cooldown mirror of the server's 60s `otp-throttle` cooldown (BR-A5). */
const RESEND_COOLDOWN_SECONDS = 60;

/** Light client-side syntactic check (server is authoritative — AC-2.1). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Step = "email" | "code";

type Feedback =
  | { kind: "none" }
  | { kind: "code_sent" }
  | { kind: "invalid_email" }
  | { kind: "rate_limited" }
  | { kind: "email_failed" }
  | { kind: "invalid_code"; attemptsRemaining?: number }
  | { kind: "expired" }
  | { kind: "too_many" }
  | { kind: "error" };

/** Map a `request-code` error discriminant → dialog feedback. */
function mapRequestError(error: string | undefined): Feedback {
  switch (error) {
    case "invalid_email":
    case "invalid_request":
      return { kind: "invalid_email" };
    case "rate_limited":
      return { kind: "rate_limited" };
    case "email_failed":
      return { kind: "email_failed" };
    default:
      return { kind: "error" };
  }
}

/** Map a `verify` result's error discriminant → dialog feedback. */
function mapVerifyError(res: VerifyCodeResult): Feedback {
  switch (res.error) {
    case "invalid_code":
      return { kind: "invalid_code", attemptsRemaining: res.attemptsRemaining };
    case "invalid_or_expired":
      return { kind: "expired" };
    case "too_many_attempts":
      return { kind: "too_many" };
    case "rate_limited":
      return { kind: "rate_limited" };
    default:
      return { kind: "error" };
  }
}

/** Human-readable copy per feedback kind. Never reveals account existence. */
function feedbackMessage(fb: Feedback, email: string): string {
  switch (fb.kind) {
    case "code_sent":
      return `We sent a 6-digit code to ${email}. Enter it below to continue.`;
    case "invalid_email":
      return "Enter a valid email address.";
    case "rate_limited":
      return "Too many requests. Please wait a moment and try again.";
    case "email_failed":
      return "We couldn't send your code right now. Please try again.";
    case "invalid_code": {
      const n = fb.attemptsRemaining;
      const tail =
        typeof n === "number"
          ? ` ${n} attempt${n === 1 ? "" : "s"} remaining.`
          : "";
      return `That code is incorrect.${tail}`;
    }
    case "expired":
      return "That code is no longer valid. Request a new one below.";
    case "too_many":
      return "Too many incorrect attempts. Request a new code below.";
    case "error":
      return "Something went wrong. Please try again.";
    case "none":
      return "";
  }
}

/** Whether a feedback kind is an error (vs the informational "code sent"). */
function isError(kind: Feedback["kind"]): boolean {
  return kind !== "none" && kind !== "code_sent";
}

export default function AuthDialog({
  open,
  onClose,
  onSignedIn,
}: AuthDialogProps) {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>({ kind: "none" });
  // Remaining resend-cooldown seconds; 0 ⇒ resend available (AC-3.1).
  const [cooldown, setCooldown] = useState(0);

  const titleId = useId();
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  // Reset to a clean email step every time the dialog (re)opens.
  useEffect(() => {
    if (open) {
      setStep("email");
      setEmail("");
      setCode("");
      setSubmitting(false);
      setFeedback({ kind: "none" });
      setCooldown(0);
    }
  }, [open]);

  // Single cooldown ticker: starts when cooldown becomes positive, tears down at
  // zero. Depending only on `active` avoids re-subscribing every second.
  const cooldownActive = cooldown > 0;
  useEffect(() => {
    if (!cooldownActive) return;
    const id = setInterval(() => {
      setCooldown((c) => (c <= 1 ? 0 : c - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [cooldownActive]);

  // Move focus to the active step's field for keyboard users.
  useEffect(() => {
    if (!open) return;
    if (step === "email") emailRef.current?.focus();
    else codeRef.current?.focus();
  }, [open, step]);

  if (!open) return null;

  async function submitEmail(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      // Short-circuit obviously invalid input without a request (AC-2.1).
      setFeedback({ kind: "invalid_email" });
      return;
    }
    setSubmitting(true);
    const res = await requestCode(trimmed);
    setSubmitting(false);
    if (res.ok) {
      // Non-enumerating: identical advance for registered/unregistered (BR-A1).
      setEmail(trimmed);
      setCode("");
      setStep("code");
      setFeedback({ kind: "code_sent" });
      setCooldown(RESEND_COOLDOWN_SECONDS);
      return;
    }
    setFeedback(mapRequestError(res.error));
  }

  async function submitCode(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    const trimmed = code.trim();
    if (trimmed.length === 0) return;
    setSubmitting(true);
    const res = await verifyCode(email, trimmed);
    setSubmitting(false);
    if (res.ok) {
      onSignedIn({ created: res.created ?? false });
      return;
    }
    setFeedback(mapVerifyError(res));
  }

  async function resend() {
    if (submitting || cooldown > 0) return;
    setSubmitting(true);
    const res = await requestCode(email);
    setSubmitting(false);
    if (res.ok) {
      setCode("");
      setFeedback({ kind: "code_sent" });
      setCooldown(RESEND_COOLDOWN_SECONDS);
      return;
    }
    setFeedback(mapRequestError(res.error));
  }

  function changeEmail() {
    // Go back to correct a mistyped address (AC-2.7).
    setStep("email");
    setCode("");
    setCooldown(0);
    setFeedback({ kind: "none" });
  }

  const fb = feedback;
  const message = feedbackMessage(fb, email);

  return (
    <div
      className="auth-dialog__backdrop"
      data-testid="auth-dialog-backdrop"
      onClick={onClose}
    >
      <div
        className="auth-dialog"
        data-testid="auth-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="auth-dialog__header">
          <h2
            id={titleId}
            data-testid="auth-dialog-title"
            className="auth-dialog__title"
          >
            {step === "email" ? "Sign in to Oak" : "Enter your code"}
          </h2>
          <button
            type="button"
            data-testid="auth-close"
            aria-label="Close sign in"
            onClick={onClose}
            className="auth-dialog__close"
          >
            ×
          </button>
        </div>

        {message && (
          <p
            data-testid="auth-feedback"
            data-kind={fb.kind}
            data-error={isError(fb.kind)}
            role={isError(fb.kind) ? "alert" : "status"}
            className="auth-dialog__feedback"
          >
            {message}
          </p>
        )}

        {step === "email" ? (
          <form
            data-testid="auth-email-step"
            onSubmit={submitEmail}
            className="auth-dialog__form"
          >
            <p className="auth-dialog__intro">
              Enter your email and we&apos;ll send you a one-time code. No password
              needed.
            </p>
            <label className="auth-dialog__label">
              Email
              <input
                ref={emailRef}
                data-testid="auth-email-input"
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                aria-label="Email address"
                className="auth-dialog__input"
              />
            </label>
            <button
              type="submit"
              data-testid="auth-send-code"
              disabled={submitting || email.trim().length === 0}
              className="auth-dialog__submit"
            >
              {submitting ? "Sending…" : "Send code"}
            </button>
          </form>
        ) : (
          <form
            data-testid="auth-code-step"
            onSubmit={submitCode}
            className="auth-dialog__form"
          >
            <label className="auth-dialog__label">
              6-digit code
              <input
                ref={codeRef}
                data-testid="auth-code-input"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) =>
                  setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                placeholder="123456"
                aria-label="One-time code"
                className="auth-dialog__input auth-dialog__input--code"
              />
            </label>
            <button
              type="submit"
              data-testid="auth-verify"
              disabled={submitting || code.trim().length === 0}
              className="auth-dialog__submit"
            >
              {submitting ? "Verifying…" : "Verify"}
            </button>

            <div className="auth-dialog__resend-row">
              <button
                type="button"
                data-testid="auth-resend"
                onClick={resend}
                disabled={submitting || cooldown > 0}
                className="auth-dialog__link"
              >
                Resend code
              </button>
              {cooldown > 0 && (
                <span
                  data-testid="auth-resend-countdown"
                  aria-live="polite"
                  className="auth-dialog__countdown"
                >
                  Resend in {cooldown}s
                </span>
              )}
            </div>

            <button
              type="button"
              data-testid="auth-change-email"
              onClick={changeEmail}
              className="auth-dialog__link auth-dialog__link--inline"
            >
              Use a different email
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
