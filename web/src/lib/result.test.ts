import { describe, expect, it } from "vitest";
import {
  err,
  isErr,
  isOk,
  mapErr,
  mapResult,
  ok,
  unwrap,
  unwrapOr,
  type Result,
} from "@/lib/result";

describe("result", () => {
  it("constructs and narrows an Ok", () => {
    const r = ok(42);
    expect(r).toEqual({ ok: true, value: 42 });
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
  });

  it("constructs and narrows an Err", () => {
    const r = err("boom");
    expect(r).toEqual({ ok: false, error: "boom" });
    expect(isErr(r)).toBe(true);
    expect(isOk(r)).toBe(false);
  });

  it("unwraps an Ok and throws on an Err", () => {
    expect(unwrap(ok("x"))).toBe("x");
    expect(() => unwrap(err("nope"))).toThrowError(/nope/);
  });

  it("unwrapOr returns the fallback on Err", () => {
    expect(unwrapOr(ok(1), 9)).toBe(1);
    expect(unwrapOr(err<string>("e") as Result<number, string>, 9)).toBe(9);
  });

  it("maps the Ok branch only", () => {
    const o: Result<number, string> = ok(2);
    expect(mapResult(o, (n: number) => n * 3)).toEqual(ok(6));
    const e: Result<number, string> = err("e");
    expect(mapResult(e, (n: number) => n * 3)).toEqual(e);
  });

  it("maps the Err branch only", () => {
    const e: Result<number, string> = err("e");
    expect(mapErr(e, (s: string) => s.toUpperCase())).toEqual(err("E"));
    const o: Result<number, string> = ok(5);
    expect(mapErr(o, (s: string) => s.toUpperCase())).toEqual(o);
  });
});
