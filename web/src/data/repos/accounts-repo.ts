/**
 * src/data/repos/accounts-repo.ts — the SOLE Postgres reader/writer for the
 * email-OTP auth layer (account, auth_session, otp_code).
 *
 * Design refs:
 *   - docs/features/account-creation/architecture/design.md
 *       § Data Model (the three tables; epoch-ms bigint timestamps)
 *       § Interface Definitions › accounts-repo.ts (these exact signatures)
 *       § Component Design ("Auth DB access lives in a repo … reads the
 *         `@/data/db` singleton directly … mirrors resolve-index.ts")
 *   - requirements.md BR-A1 (one account per email, non-enumerating),
 *     BR-A2 (email identity / token never stored raw), BR-A3 (single-use,
 *     expiry), BR-A4 (attempt lockout), BR-A5 (supersession via email-PK
 *     upsert), BR-A7 (per-device sessions, lazy expiry cleanup).
 *
 * Boundary rules (CLAUDE.md "repos are the sole Postgres readers"):
 *   - `import "server-only"` — never bundled to the client.
 *   - Reads the memoized `@/data/db` singleton directly (like resolve-index.ts),
 *     NOT a per-request ctx handle: auth is a server-only concern used by the
 *     Next request path, never by the `tsx` ingest/eval/migrate scripts.
 *   - No business logic and NO validation: emails arrive already normalized
 *     (trim + lowercase) from auth-service; find-or-create / lockout / expiry
 *     decisions live in the service layer. The repo just maps rows.
 *   - DB columns are snake_case (Drizzle); the returned objects are camelCase
 *     (the Interface-Definitions shapes). Epoch-ms timestamps are `bigint`
 *     with mode "number" (int4 overflows ~1.75e12), so they read as `number`.
 *
 * Error style: these are not in-domain Result unions — they return `null` for a
 * clean miss and let GENUINE faults propagate. In particular `createAccount`
 * surfaces the `account_email_idx` UNIQUE violation as a rejected promise, which
 * is the database enforcing BR-A1 ("exactly one account per email"); auth-service
 * avoids triggering it by going find-then-create.
 *
 * node-postgres is asynchronous — every query here is awaited.
 */

import "server-only";

import { eq, lte, sql } from "drizzle-orm";

import { db } from "@/data/db";
import {
  account,
  auth_session,
  conversation,
  conversation_message,
  otp_code,
  team,
} from "@/data/schema";

// ---------------------------------------------------------------------------
// Row shapes (camelCase Interface-Definitions types — § Interface Definitions)
// ---------------------------------------------------------------------------

/** One registered user (BR-A1: exactly one per normalized email). */
export interface Account {
  id: string;
  email: string;
  createdAt: number;
}

/** One active device session; the raw token is never stored — only its hash. */
export interface AuthSession {
  id: string;
  tokenHash: string;
  accountId: string;
  createdAt: number;
  expiresAt: number;
}

/** The at-most-one active OTP for an email (email is the table PK). */
export interface OtpCode {
  email: string;
  codeHash: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
  consumedAt: number | null;
}

// ---------------------------------------------------------------------------
// account
// ---------------------------------------------------------------------------

/**
 * Look up an account by its (already-normalized) email. Returns `null` when no
 * account exists — the caller (verifyCode) uses this for find-or-create and the
 * request path never distinguishes the two outcomes to the user (BR-A1).
 */
export async function findAccountByEmail(
  email: string,
): Promise<Account | null> {
  const rows = await db
    .select({
      id: account.id,
      email: account.email,
      createdAt: account.created_at,
    })
    .from(account)
    .where(eq(account.email, email))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Create a new account for `email`. Rejects (UNIQUE violation on
 * `account_email_idx`) if one already exists for the email — the DB-enforced
 * BR-A1 invariant. Callers go find-then-create so this only fires on a genuine
 * race, where the rejection is the correct outcome.
 */
export async function createAccount(
  email: string,
  id: string,
  createdAt: number,
): Promise<Account> {
  await db.insert(account).values({ id, email, created_at: createdAt });
  return { id, email, createdAt };
}

// ---------------------------------------------------------------------------
// otp_code (email PK → issuing a new code is an upsert that supersedes the prior)
// ---------------------------------------------------------------------------

/**
 * Issue/replace the active code for an email (BR-A5 supersession). Because
 * `email` is the PK, this is an upsert: it overwrites code_hash/created_at/
 * expires_at AND resets `attempts` to 0 and `consumed_at` to null, so a freshly
 * issued code is unconsumed and unlocked even if the superseded one was locked
 * out or already used.
 */
export async function upsertOtpCode(row: {
  email: string;
  codeHash: string;
  createdAt: number;
  expiresAt: number;
}): Promise<void> {
  await db
    .insert(otp_code)
    .values({
      email: row.email,
      code_hash: row.codeHash,
      created_at: row.createdAt,
      expires_at: row.expiresAt,
      attempts: 0,
      consumed_at: null,
    })
    .onConflictDoUpdate({
      target: otp_code.email,
      set: {
        code_hash: row.codeHash,
        created_at: row.createdAt,
        expires_at: row.expiresAt,
        attempts: 0,
        consumed_at: null,
      },
    });
}

/** Read the active OTP row for an email, or `null` if none has been issued. */
export async function getOtpCode(email: string): Promise<OtpCode | null> {
  const rows = await db
    .select({
      email: otp_code.email,
      codeHash: otp_code.code_hash,
      createdAt: otp_code.created_at,
      expiresAt: otp_code.expires_at,
      attempts: otp_code.attempts,
      consumedAt: otp_code.consumed_at,
    })
    .from(otp_code)
    .where(eq(otp_code.email, email))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Atomically bump the wrong-attempt counter for an email and return the NEW
 * count (BR-A4: the service locks the code out once this reaches 5). Returns 0
 * if no code row exists for the email (nothing to increment).
 */
export async function incrementOtpAttempts(email: string): Promise<number> {
  const rows = await db
    .update(otp_code)
    .set({ attempts: sql`${otp_code.attempts} + 1` })
    .where(eq(otp_code.email, email))
    .returning({ attempts: otp_code.attempts });
  return rows[0]?.attempts ?? 0;
}

/**
 * Mark the email's code as consumed at `consumedAt` (BR-A3 single-use). A row
 * with a non-null `consumed_at` can no longer authenticate.
 */
export async function consumeOtpCode(
  email: string,
  consumedAt: number,
): Promise<void> {
  await db
    .update(otp_code)
    .set({ consumed_at: consumedAt })
    .where(eq(otp_code.email, email));
}

// ---------------------------------------------------------------------------
// auth_session (one row per device; token stored only as its SHA-256 hash)
// ---------------------------------------------------------------------------

/** Persist a new session row (issued by sessions.issueSession after verify). */
export async function insertSession(row: AuthSession): Promise<void> {
  await db.insert(auth_session).values({
    id: row.id,
    token_hash: row.tokenHash,
    account_id: row.accountId,
    created_at: row.createdAt,
    expires_at: row.expiresAt,
  });
}

/**
 * Resolve a session by the SHA-256 hash of its cookie token, or `null` if no
 * such session exists. Expiry is NOT applied here — the caller compares
 * `expiresAt` against the clock (and may best-effort delete an expired row).
 */
export async function findSessionByTokenHash(
  tokenHash: string,
): Promise<AuthSession | null> {
  const rows = await db
    .select({
      id: auth_session.id,
      tokenHash: auth_session.token_hash,
      accountId: auth_session.account_id,
      createdAt: auth_session.created_at,
      expiresAt: auth_session.expires_at,
    })
    .from(auth_session)
    .where(eq(auth_session.token_hash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Delete a session by token hash (sign-out, AC-5.1). Idempotent — deleting an
 * absent/already-cleared session is a no-op, never an error.
 */
export async function deleteSessionByTokenHash(
  tokenHash: string,
): Promise<void> {
  await db.delete(auth_session).where(eq(auth_session.token_hash, tokenHash));
}

/**
 * Lazy housekeeping (BR-A7): drop every session whose `expires_at` is at or
 * before `now`, returning how many rows were removed. Live sessions
 * (`expires_at > now`) are left untouched. Called opportunistically on resolve;
 * no cron/worker.
 */
export async function deleteExpiredSessions(now: number): Promise<number> {
  const deleted = await db
    .delete(auth_session)
    .where(lte(auth_session.expires_at, now))
    .returning({ id: auth_session.id });
  return deleted.length;
}

// ---------------------------------------------------------------------------
// account deletion (cascade)
// ---------------------------------------------------------------------------

/**
 * Permanently delete an account and EVERYTHING scoped to it
 * (iphone-app M-ACCT-US-6 / M-BR-ACCT-6 "delete my account and all my data").
 *
 * FKs in this schema are LOGICAL (plain indexed columns, no physical
 * `ON DELETE CASCADE` — see schema.ts), so every dependent row is removed
 * explicitly inside ONE transaction, in FK-safe (child-before-parent) order:
 *
 *   conversation_message → conversation → team → auth_session   (all by account_id)
 *   → otp_code (by the account's email)  → account              (by id)
 *
 * `otp_code` carries no `account_id` (it is keyed by email and can exist before
 * the account does, BR-A5), so its row is located via the account's email read
 * inside the same transaction.
 *
 * STRICTLY account-scoped (BR-A9 isolation): every delete filters on this
 * `accountId` / its email, so another account's rows are never touched.
 * Idempotent: deleting an absent account (no matching rows, no email) is a clean
 * no-op, never an error — matching the repo's other deletes (deleteConversation,
 * deleteTeam, deleteSessionByTokenHash).
 */
export async function deleteAccount(accountId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(conversation_message)
      .where(eq(conversation_message.account_id, accountId));
    await tx
      .delete(conversation)
      .where(eq(conversation.account_id, accountId));
    await tx.delete(team).where(eq(team.account_id, accountId));
    await tx
      .delete(auth_session)
      .where(eq(auth_session.account_id, accountId));

    // otp_code is keyed by email, not account_id — resolve the email from the
    // (about-to-be-deleted) account row in the same transaction. If the account
    // does not exist there is nothing to clear (idempotent no-op).
    const rows = await tx
      .select({ email: account.email })
      .from(account)
      .where(eq(account.id, accountId))
      .limit(1);
    const email = rows[0]?.email;
    if (email !== undefined) {
      await tx.delete(otp_code).where(eq(otp_code.email, email));
    }

    await tx.delete(account).where(eq(account.id, accountId));
  });
}
