/**
 * Tests for the U1 metered-OpenAlex fetch layer: API-key attachment,
 * budget/auth error discrimination, canonical-id resolution, and key
 * redaction. Exercises the real fetch path (getWorkById) against a mocked
 * Zotero.HTTP so the retry/discriminator branches are covered end to end.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  OpenAlexBudgetError,
  OpenAlexAuthError,
  OpenAlexNetworkError,
  normalizeError,
  redactApiKey,
} from "../src/modules/utils";

let apiKeyPref = "";
const httpRequest = vi.fn();

const mockZotero = {
  Prefs: {
    get: vi.fn((pref: string) => {
      if (pref === "extensions.zotero.citegeist.openAlexApiKey") return apiKeyPref;
      return undefined;
    }),
  },
  HTTP: { request: httpRequest },
  debug: vi.fn(),
};
vi.stubGlobal("Zotero", mockZotero);

// Import after the global is stubbed so module-level code sees it.
import { getWorkById, resolveCanonicalId } from "../src/modules/openalex";

function httpResponse(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return {
    status,
    responseText: JSON.stringify(body),
    getResponseHeader: (name: string) => headers[name] ?? null,
  };
}

beforeEach(() => {
  apiKeyPref = "";
  httpRequest.mockReset();
  mockZotero.debug.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("redactApiKey", () => {
  it("redacts an api_key query value, preserving surrounding params", () => {
    const url = "https://api.openalex.org/works/W1?api_key=sk-SECRET123&select=id";
    const out = redactApiKey(url);
    expect(out).not.toContain("sk-SECRET123");
    expect(out).toContain("api_key=REDACTED");
    expect(out).toContain("select=id");
  });

  it("is applied by normalizeError so a URL-bearing error never leaks the key", () => {
    const e = new Error("request failed: https://api.openalex.org/works?api_key=LEAK&x=1");
    const msg = normalizeError(e);
    expect(msg).not.toContain("LEAK");
    expect(msg).toContain("api_key=REDACTED");
  });
});

describe("resolveCanonicalId", () => {
  it("returns the short id from the response body (301-merge canonicalization)", () => {
    expect(resolveCanonicalId({ id: "https://openalex.org/A999" })).toBe("A999");
  });
  it("returns null when the body has no id", () => {
    expect(resolveCanonicalId({})).toBeNull();
    expect(resolveCanonicalId(null)).toBeNull();
  });
});

describe("api key attachment", () => {
  it("attaches api_key to the request URL when the pref is set", async () => {
    apiKeyPref = "sk-mykey";
    httpRequest.mockResolvedValue(httpResponse(200, { id: "https://openalex.org/W1" }));
    await getWorkById("W1");
    const url = httpRequest.mock.calls[0][1] as string;
    expect(url).toContain("api_key=sk-mykey");
    expect(url).not.toContain("mailto");
  });

  it("issues an anonymous request (no api_key) when the pref is empty", async () => {
    httpRequest.mockResolvedValue(httpResponse(200, { id: "https://openalex.org/W1" }));
    await getWorkById("W1");
    const url = httpRequest.mock.calls[0][1] as string;
    expect(url).not.toContain("api_key");
    expect(url).not.toContain("mailto");
  });
});

describe("error discrimination", () => {
  it("maps 401 to OpenAlexAuthError (no retry)", async () => {
    httpRequest.mockResolvedValue(httpResponse(401));
    await expect(getWorkById("W1")).rejects.toBeInstanceOf(OpenAlexAuthError);
    expect(httpRequest).toHaveBeenCalledTimes(1);
  });

  it("maps 403 to OpenAlexAuthError (no retry)", async () => {
    httpRequest.mockResolvedValue(httpResponse(403));
    await expect(getWorkById("W1")).rejects.toBeInstanceOf(OpenAlexAuthError);
    expect(httpRequest).toHaveBeenCalledTimes(1);
  });

  it("maps a 429 with X-RateLimit-Remaining: 0 to OpenAlexBudgetError (no retry)", async () => {
    httpRequest.mockResolvedValue(httpResponse(429, {}, { "X-RateLimit-Remaining": "0" }));
    await expect(getWorkById("W1")).rejects.toBeInstanceOf(OpenAlexBudgetError);
    expect(httpRequest).toHaveBeenCalledTimes(1);
  });

  it("treats a 429 with remaining budget as transient and retries, then network-errors", async () => {
    vi.useFakeTimers();
    httpRequest.mockResolvedValue(httpResponse(429, {}, { "X-RateLimit-Remaining": "42" }));
    const p = getWorkById("W1");
    const assertion = expect(p).rejects.toBeInstanceOf(OpenAlexNetworkError);
    await vi.runAllTimersAsync();
    await assertion;
    // initial attempt + 2 retries (OPENALEX_RETRY_DELAYS_MS has length 2)
    expect(httpRequest).toHaveBeenCalledTimes(3);
  });

  it("returns the work on 200", async () => {
    httpRequest.mockResolvedValue(
      httpResponse(200, { id: "https://openalex.org/W1", authorships: [] }),
    );
    const work = await getWorkById("W1");
    expect(work?.id).toBe("https://openalex.org/W1");
  });

  it("returns null on 404", async () => {
    httpRequest.mockResolvedValue(httpResponse(404));
    expect(await getWorkById("W1")).toBeNull();
  });
});

/**
 * The tests above mock `Zotero.HTTP.request` as RESOLVING on 401/404/429. Real
 * Zotero only does that when `successCodes: false` is passed — its default is
 * `success = status >= 200 && status < 300` (chrome/content/zotero/xpcom/http.js),
 * which rejects every error status before the caller can read it. Without the
 * flag the whole discriminator above is dead code in production: "not found",
 * "budget exhausted" and "bad key" all collapse into the network-error branch
 * and get retried three times each, while this suite stays green against a
 * mock that no longer matches the host. This guards the contract itself.
 */
describe("Zotero.HTTP contract", () => {
  it("passes successCodes: false so error statuses reach our own classifier", async () => {
    httpRequest.mockResolvedValue(httpResponse(200, { id: "https://openalex.org/W1" }));
    await getWorkById("W1");
    expect(httpRequest.mock.calls[0][2]).toMatchObject({ successCodes: false });
  });

  it("still surfaces a genuine transport rejection as OpenAlexNetworkError", async () => {
    vi.useFakeTimers();
    httpRequest.mockRejectedValue(new Error("NS_ERROR_OFFLINE"));
    const p = getWorkById("W1");
    const assertion = expect(p).rejects.toBeInstanceOf(OpenAlexNetworkError);
    await vi.runAllTimersAsync();
    await assertion;
  });
});
