/**
 * Email transport tests (account-creation Phase 2).
 *
 * Asserts the seam the auth layer depends on:
 *  - factory selection: console when no RESEND_API_KEY, Resend when present
 *    (design.md § Interface Definitions, AD-6);
 *  - Resend builds the correct HTTP request to deliver the code (AC-2.1) and
 *    THROWS on a non-2xx response (the transport fault `auth-service` maps to
 *    `email_failed`);
 *  - the console transport records the code for test capture and performs NO
 *    network I/O (NEVER real mail);
 *  - the new env vars parse with dev defaults and AUTH_SECRET is required in
 *    production.
 *
 * `fetch` is stubbed in every test, so no test can ever reach the real Resend
 * API (NEVER real mail).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseEnv } from "@/env";

import {
  ConsoleEmailTransport,
  clearSentOtpEmails,
  consoleEmailTransport,
  getLastSentOtpEmail,
  getSentOtpEmails,
} from "./console-transport";
import { ResendEmailTransport } from "./resend-transport";
import { getEmailTransport } from "./transport";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

interface MockResponseInit {
  ok: boolean;
  status: number;
  statusText?: string;
  body?: string;
}

function mockResponse(init: MockResponseInit): Response {
  return {
    ok: init.ok,
    status: init.status,
    statusText: init.statusText ?? "",
    text: async () => init.body ?? "",
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearSentOtpEmails();
  // Default: a successful Resend response. Stubbing fetch guarantees no test
  // ever performs a real network send.
  fetchMock = vi.fn().mockResolvedValue(
    mockResponse({ ok: true, status: 200, statusText: "OK", body: '{"id":"e1"}' }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearSentOtpEmails();
});

describe("getEmailTransport — factory selection (AD-6, AC-2.1)", () => {
  it("returns the console transport when no RESEND_API_KEY is configured", () => {
    const transport = getEmailTransport({ apiKey: undefined });
    expect(transport).toBeInstanceOf(ConsoleEmailTransport);
    expect(transport).toBe(consoleEmailTransport);
  });

  it("treats an empty RESEND_API_KEY as absent → console transport", () => {
    const transport = getEmailTransport({ apiKey: "" });
    expect(transport).toBeInstanceOf(ConsoleEmailTransport);
  });

  it("defaults to the console transport in dev/test (no key in env)", () => {
    // The test runner sets no RESEND_API_KEY, so the env-backed default selects
    // the console transport and NEVER real mail.
    expect(getEmailTransport()).toBeInstanceOf(ConsoleEmailTransport);
  });

  it("returns the Resend transport when a RESEND_API_KEY is present", () => {
    const transport = getEmailTransport({
      apiKey: "re_test_123",
      from: "Oak <test@example.com>",
    });
    expect(transport).toBeInstanceOf(ResendEmailTransport);
    expect(transport).not.toBeInstanceOf(ConsoleEmailTransport);
  });
});

describe("ResendEmailTransport.sendOtpEmail — HTTP request (AC-2.1)", () => {
  it("POSTs the code to Resend with the correct endpoint, auth, and payload", async () => {
    const apiKey = "re_test_456";
    const from = "Oak <auth@oak.test>";
    const to = "alice@example.com";
    const code = "012345";

    const transport = new ResendEmailTransport(apiKey, from);
    await transport.sendOtpEmail(to, code);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe(RESEND_ENDPOINT);
    expect(init.method).toBe("POST");

    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${apiKey}`);
    expect(headers["Content-Type"]).toBe("application/json");

    const payload = JSON.parse(init.body as string) as {
      from: string;
      to: string[];
      subject: string;
      text: string;
      html: string;
    };
    expect(payload.from).toBe(from);
    expect(payload.to).toEqual([to]); // delivered to the address entered (AC-2.1)
    expect(typeof payload.subject).toBe("string");
    expect(payload.subject.length).toBeGreaterThan(0);
    // The one-time code is present in the email body (AC-2.1).
    expect(payload.text).toContain(code);
    expect(payload.html).toContain(code);
  });

  it("throws on a non-2xx Resend response (transport fault → email_failed)", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 422,
        statusText: "Unprocessable Entity",
        body: "invalid from address",
      }),
    );
    const transport = new ResendEmailTransport("re_test_789", "x@y.test");

    await expect(transport.sendOtpEmail("bob@example.com", "111222")).rejects.toThrow(
      /422/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("propagates a network-level fetch rejection (transport fault)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const transport = new ResendEmailTransport("re_test_000", "x@y.test");

    await expect(
      transport.sendOtpEmail("carol@example.com", "333444"),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("ConsoleEmailTransport.sendOtpEmail — capture, no real mail", () => {
  it("records the sent code for test capture and sends NO network request", async () => {
    const to = "dave@example.com";
    const code = "654321";

    const transport = new ConsoleEmailTransport();
    await transport.sendOtpEmail(to, code);

    const last = getLastSentOtpEmail();
    expect(last).toBeDefined();
    expect(last?.to).toBe(to);
    expect(last?.code).toBe(code);
    expect(getSentOtpEmails()).toHaveLength(1);

    // NEVER real mail: the console transport must not touch fetch.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("captures multiple sends oldest → newest", async () => {
    await consoleEmailTransport.sendOtpEmail("a@example.com", "100000");
    await consoleEmailTransport.sendOtpEmail("b@example.com", "200000");

    const all = getSentOtpEmails();
    expect(all).toHaveLength(2);
    expect(all[0]?.code).toBe("100000");
    expect(all[1]?.code).toBe("200000");
    expect(getLastSentOtpEmail()?.to).toBe("b@example.com");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("starts empty after clearSentOtpEmails()", () => {
    expect(getSentOtpEmails()).toHaveLength(0);
    expect(getLastSentOtpEmail()).toBeUndefined();
  });
});

describe("env additions — AUTH_SECRET / RESEND_API_KEY / EMAIL_FROM", () => {
  it("applies dev defaults when only the API key is supplied", () => {
    const parsed = parseEnv({ ANTHROPIC_API_KEY: "sk-test" });
    expect(parsed.AUTH_SECRET).toBe("dev-insecure-auth-secret-change-me");
    expect(parsed.RESEND_API_KEY).toBeUndefined();
    expect(parsed.EMAIL_FROM).toBe("Oak <onboarding@resend.dev>");
  });

  it("treats an empty RESEND_API_KEY as absent (→ undefined)", () => {
    const parsed = parseEnv({ ANTHROPIC_API_KEY: "sk-test", RESEND_API_KEY: "" });
    expect(parsed.RESEND_API_KEY).toBeUndefined();
  });

  it("keeps a non-empty RESEND_API_KEY", () => {
    const parsed = parseEnv({
      ANTHROPIC_API_KEY: "sk-test",
      RESEND_API_KEY: "re_live_abc",
    });
    expect(parsed.RESEND_API_KEY).toBe("re_live_abc");
  });

  it("rejects the default AUTH_SECRET in production (AD-4)", () => {
    expect(() =>
      parseEnv({ ANTHROPIC_API_KEY: "sk-test", NODE_ENV: "production" }),
    ).toThrowError(/AUTH_SECRET/);
  });

  it("accepts an explicit AUTH_SECRET in production", () => {
    const parsed = parseEnv({
      ANTHROPIC_API_KEY: "sk-test",
      NODE_ENV: "production",
      AUTH_SECRET: "a-strong-production-secret",
    });
    expect(parsed.AUTH_SECRET).toBe("a-strong-production-secret");
    expect(parsed.NODE_ENV).toBe("production");
  });
});
