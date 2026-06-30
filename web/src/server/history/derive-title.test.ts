/**
 * Unit tests for src/server/history/derive-title.ts (BR-H7). Pure — no I/O.
 */

import { describe, expect, it } from "vitest";
import {
  deriveTitle,
  FALLBACK_TITLE,
  TITLE_MAX_LEN,
} from "@/server/history/derive-title";

describe("deriveTitle", () => {
  it("uses a short first message verbatim", () => {
    expect(deriveTitle("What beats Garchomp?")).toBe("What beats Garchomp?");
  });

  it("trims surrounding whitespace", () => {
    expect(deriveTitle("  hello  ")).toBe("hello");
  });

  it("collapses internal whitespace runs to single spaces", () => {
    expect(deriveTitle("a\n\n  b\t c")).toBe("a b c");
  });

  it("falls back for an empty message", () => {
    expect(deriveTitle("")).toBe(FALLBACK_TITLE);
  });

  it("falls back for a whitespace-only message", () => {
    expect(deriveTitle("   \n\t  ")).toBe(FALLBACK_TITLE);
  });

  it("truncates an over-long message with an ellipsis", () => {
    const long = "word ".repeat(40); // ~200 chars
    const title = deriveTitle(long);
    expect(title.endsWith("…")).toBe(true);
    // Visible text capped at TITLE_MAX_LEN, plus the single ellipsis char.
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX_LEN + 1);
  });

  it("does not truncate a message exactly at the cap", () => {
    const exact = "x".repeat(TITLE_MAX_LEN);
    expect(deriveTitle(exact)).toBe(exact);
  });

  it("never returns an empty string", () => {
    for (const input of ["", " ", "\n", "ok", "x".repeat(500)]) {
      expect(deriveTitle(input).length).toBeGreaterThan(0);
    }
  });
});
