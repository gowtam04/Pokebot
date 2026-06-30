import { describe, expect, it } from "vitest";

// Trivial toolchain smoke test: proves vitest runs green on the scaffolded app.
describe("smoke", () => {
  it("runs the test suite", () => {
    expect(1 + 1).toBe(2);
  });
});
