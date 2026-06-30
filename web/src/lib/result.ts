/**
 * Result<T, E> — the discriminated-union error type used across the
 * tool/data layer (design.md § Interface Definitions, decision A6).
 *
 * Tool/data-layer functions return either a Result or one of the
 * domain-specific structured shapes mandated by tools.md
 * (`{ found: false, suggestions }`, `{ error: "upstream_unavailable" }`, ...).
 * Those structured shapes take precedence at the tool boundary and must NOT be
 * wrapped away in a generic Result.
 */

export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E = string> = Ok<T> | Err<E>;

/** Build a success Result. */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/** Build a failure Result. */
export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/** Type guard: narrows a Result to its Ok branch. */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

/** Type guard: narrows a Result to its Err branch. */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/**
 * Extract the success value, throwing if the Result is an Err.
 * Use only at boundaries where an error is genuinely unexpected (e.g. tests).
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) {
    return result.value;
  }
  throw new Error(`Called unwrap on an Err: ${stringifyError(result.error)}`);
}

/** Extract the success value, or return the supplied fallback on Err. */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/** Map the success value, leaving an Err untouched. */
export function mapResult<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U,
): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** Map the error value, leaving an Ok untouched. */
export function mapErr<T, E, F>(
  result: Result<T, E>,
  fn: (error: E) => F,
): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
