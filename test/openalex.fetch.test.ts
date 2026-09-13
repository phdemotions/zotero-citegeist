/**
 * Tests for the U1 metered-OpenAlex fetch layer: API-key attachment,
 * budget/auth error discrimination, canonical-id resolution, and key
 * redaction. Exercises the real fetch path (getWorkById) against a mocked
 * Zotero.HTTP so the retry/discriminator branches are covered end to end.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PREF_OPENALEX_API_KEY, PREF_OPENALEX_BASE_URL } from "../src/constants";
import {
  OpenAlexBudgetError,
  OpenAlexAuthError,
  OpenAlexNetworkError,
  OpenAlexResponseError,
  normalizeError,
  redactApiKey,
} from "../src/modules/utils";
import { ZOTERO_PREF_BRANCH, makeFakePrefs } from "./_helpers/fakePrefs";

const httpRequest = vi.fn();

// The fake prepends `extensions.zotero.` unless `global` is passed, as real
// Zotero does, so a full-name read without it never sees the profile's value.
const mockZotero = {
  Prefs: makeFakePrefs({ addonDefaults: true }),
  HTTP: { request: httpRequest },
  debug: vi.fn(),
};
vi.stubGlobal("Zotero", mockZotero);

/** Store a pref under its real name, as the settings pane and the real-Zotero harness do. */
function setUserPref(name: string, value: string): void {
  mockZotero.Prefs.user.set(name, value);
}

// Import after the global is stubbed so module-level code sees it.
import { getWorkById, resolveCanonicalId, resolveOpenAlexBase } from "../src/modules/openalex";

function httpResponse(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return {
    status,
    responseText: JSON.stringify(body),
    getResponseHeader: (name: string) => headers[name] ?? null,
  };
}

beforeEach(() => {
  mockZotero.Prefs = makeFakePrefs({ addonDefaults: true });
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

  // The diagnostic report is copy-pasted into public GitHub issues and promises
  // "no personal details", so a username-bearing path must not survive
  // normalizeError into the ring buffer.
  it("normalizeError strips absolute paths that carry the OS username", () => {
    const posix = normalizeError(
      new Error("locked: /Users/janedoe/Library/CloudStorage/Box/Zotero/citegeist.sqlite"),
    );
    expect(posix).not.toContain("janedoe");
    expect(posix).not.toContain("/Users/");
    const win = normalizeError(new Error("locked: C:\\Users\\janedoe\\Zotero\\citegeist.sqlite"));
    expect(win).not.toContain("janedoe");
  });

  // The P1 that this branch's review caught: fetch labels became the recorded
  // diagnostic detail, so a raw DOI/PMID/arXiv/ISBN/title in a label leaked
  // library content into the shareable report. Labels must carry only the
  // identifier TYPE.
  it("no OpenAlex fetch label interpolates a library identifier or title", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/modules/openalex.ts", import.meta.url)),
      "utf8",
    );
    const labels = [...source.matchAll(/rateLimitedFetch<[^>]*>\([^,]+,\s*([^)]+?)\)/g)].map((m) =>
      m[1].trim(),
    );
    const leaky = labels.filter((l) => l.includes("${"));
    expect(leaky, `these labels interpolate a value into the recorded detail: ${leaky}`).toEqual(
      [],
    );
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
    setUserPref(PREF_OPENALEX_API_KEY, "sk-mykey");
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

  it("ignores a key found only under the doubled pref name, which the settings pane never writes (U18)", async () => {
    mockZotero.Prefs.user.set(ZOTERO_PREF_BRANCH + PREF_OPENALEX_API_KEY, "sk-doubled");
    httpRequest.mockResolvedValue(httpResponse(200, { id: "https://openalex.org/W1" }));
    await getWorkById("W1");
    expect(httpRequest.mock.calls[0][1] as string).not.toContain("api_key");
  });
});

describe("OpenAlex base-URL override", () => {
  async function requestedUrl(): Promise<string> {
    httpRequest.mockResolvedValue(httpResponse(200, { id: "https://openalex.org/W1" }));
    await getWorkById("W1");
    return httpRequest.mock.calls[0][1] as string;
  }

  it("uses the production API when the pref is unset", async () => {
    expect(await requestedUrl()).toMatch(/^https:\/\/api\.openalex\.org\/works\/W1\?/);
  });

  it("honours a loopback override, as the real-Zotero stub needs", async () => {
    setUserPref(PREF_OPENALEX_BASE_URL, "http://127.0.0.1:43121");
    expect(await requestedUrl()).toMatch(/^http:\/\/127\.0\.0\.1:43121\/works\/W1\?/);
  });

  it("ignores a non-loopback host and sends the request to OpenAlex", async () => {
    setUserPref(PREF_OPENALEX_BASE_URL, "https://evil.example");
    const url = await requestedUrl();
    expect(url).toMatch(/^https:\/\/api\.openalex\.org\//);
    expect(url).not.toContain("evil.example");
  });

  it("ignores a malformed URL", async () => {
    setUserPref(PREF_OPENALEX_BASE_URL, "not a url");
    expect(await requestedUrl()).toMatch(/^https:\/\/api\.openalex\.org\//);
  });

  it("never attaches the api_key to the override host", async () => {
    setUserPref(PREF_OPENALEX_API_KEY, "sk-mykey");
    setUserPref(PREF_OPENALEX_BASE_URL, "http://localhost:8080");
    const url = await requestedUrl();
    expect(url).toMatch(/^http:\/\/localhost:8080\/works\/W1\?/);
    expect(url).not.toContain("api_key");
  });

  it("keeps sending the api_key to OpenAlex when a hostile override is ignored", async () => {
    setUserPref(PREF_OPENALEX_API_KEY, "sk-mykey");
    setUserPref(PREF_OPENALEX_BASE_URL, "https://evil.example");
    const url = await requestedUrl();
    expect(url).toMatch(/^https:\/\/api\.openalex\.org\//);
    expect(url).toContain("api_key=sk-mykey");
  });

  it("reads the pref by its full name with `global`, so the profile's value is seen", async () => {
    await requestedUrl();
    expect(mockZotero.Prefs.get).toHaveBeenCalledWith(
      "extensions.zotero.citegeist.openAlexBaseUrl",
      true,
    );
  });
});

describe("resolveOpenAlexBase", () => {
  const production = { url: "https://api.openalex.org", overridden: false };

  it.each([
    ["unset", undefined],
    ["blank", "   "],
    ["not a string", 8080],
    ["malformed", "http://"],
    ["missing a scheme", "127.0.0.1:8080"],
    ["another host", "https://evil.example"],
    ["a lookalike host", "http://127.0.0.1.evil.example"],
    ["a userinfo trick", "http://127.0.0.1@evil.example"],
    ["credentials on loopback", "http://user:pw@127.0.0.1:8080"],
    ["a query string", "http://127.0.0.1:8080/?api_key=x"],
    ["a fragment", "http://127.0.0.1:8080/#x"],
    ["a non-http scheme", "file:///etc/passwd"],
    ["localhost with a trailing dot", "http://localhost.:8080"],
  ])("falls back to the production API for %s", (_label, raw) => {
    expect(resolveOpenAlexBase(raw)).toEqual(production);
  });

  it.each([
    ["http://127.0.0.1:43121", "http://127.0.0.1:43121"],
    ["http://localhost:8080/", "http://localhost:8080"],
    ["http://[::1]:9000", "http://[::1]:9000"],
    ["https://127.0.0.1:8443/openalex/", "https://127.0.0.1:8443/openalex"],
    ["  http://LOCALHOST:8080  ", "http://localhost:8080"],
  ])("honours the loopback override %s", (raw, url) => {
    expect(resolveOpenAlexBase(raw)).toEqual({ url, overridden: true });
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

  it("treats a 429 with remaining budget as transient and retries, then response-errors", async () => {
    vi.useFakeTimers();
    httpRequest.mockResolvedValue(httpResponse(429, {}, { "X-RateLimit-Remaining": "42" }));
    const p = getWorkById("W1");
    // The service answered (429), so this is CG-API50 "unexpected response" —
    // NOT CG-NET01, which would tell the user to check a connection that is fine.
    const assertion = expect(p).rejects.toBeInstanceOf(OpenAlexResponseError);
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

  it("maps a 200 with an unparseable body to OpenAlexResponseError (CG-API50)", async () => {
    // The service answered, just not with JSON — a response error, not a network
    // one, so the user isn't told to check a connection that's fine.
    httpRequest.mockResolvedValue({
      status: 200,
      responseText: "<html>not json</html>",
      getResponseHeader: () => null,
    });
    await expect(getWorkById("W1")).rejects.toBeInstanceOf(OpenAlexResponseError);
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
