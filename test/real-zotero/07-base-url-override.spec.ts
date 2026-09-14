/**
 * A non-loopback base-URL override is ignored end to end.
 *
 * Catches: an override honoured for any host, which would let a crafted pref
 * send every request, with the user's api_key on its query string, to another
 * machine; a production request that drops the configured api_key; and an
 * api_key written to Debug Output. `Zotero.HTTP.request` is intercepted for
 * Citegeist's requests only and answered from the fixture, so nothing leaves the
 * runner, and the loopback stub must receive none of this fetch's requests.
 */
import { OPENALEX_API_BASE_URL, PREF_OPENALEX_BASE_URL } from "../../src/constants";
import { routeOpenAlexRequest } from "./shared/fixture";
import {
  API_KEY_SENTINEL,
  clearApiKeyPref,
  patchMethod,
  setApiKeyPref,
  stubBaseUrl,
  stubRequestLog,
  stubRequestsSince,
  withStubItem,
} from "./support/zotero";

const HOSTILE_BASE_URL = "https://evil.example";

type HttpRequest = (
  method: string,
  url: string,
  options?: { headers?: Record<string, string> },
) => Promise<unknown>;

describe("OpenAlex base-URL override", function () {
  it("ignores a non-loopback host and sends requests, with the api_key, only to api.openalex.org", async function () {
    const stub = stubBaseUrl();
    expect(stub, "positive control: the harness pointed Citegeist at the loopback stub").to.match(
      /^http:\/\/127\.0\.0\.1:\d+$/,
    );

    await withStubItem("Citegeist base-URL spec", async (item) => {
      const requestsBefore = await stubRequestLog();
      const citegeistUrls: string[] = [];
      const restoreRequest = patchMethod(
        Zotero.HTTP as { request: HttpRequest },
        "request",
        (request) =>
          function (this: unknown, method, url, options) {
            if (!options?.headers?.["User-Agent"]?.startsWith("Citegeist")) {
              return request.call(this, method, url, options);
            }
            citegeistUrls.push(url);
            const { status, body } = routeOpenAlexRequest(url.replace(/^[a-z]+:\/\/[^/]+/i, ""));
            return Promise.resolve({
              status,
              responseText: JSON.stringify(body),
              getResponseHeader: () => null,
            });
          },
      );
      Zotero.Prefs.set(PREF_OPENALEX_BASE_URL, HOSTILE_BASE_URL, true);
      setApiKeyPref(API_KEY_SENTINEL);
      try {
        const result = await Zotero.Citegeist.fetchItems([item.id]);
        expect(result, "bridge fetch resolved undefined (see Debug Output)").to.exist;
        expect(result.fresh, JSON.stringify(result)).to.equal(1);

        expect(citegeistUrls, "positive control: Citegeist issued requests").to.not.be.empty;
        const elsewhere = citegeistUrls.filter((u) => !u.startsWith(`${OPENALEX_API_BASE_URL}/`));
        expect(elsewhere, "requests that left for a host other than OpenAlex").to.be.empty;
        const keyless = citegeistUrls.filter(
          (u) => new URL(u).searchParams.get("api_key") !== API_KEY_SENTINEL,
        );
        expect(keyless, "OpenAlex requests without the configured api_key").to.be.empty;
      } finally {
        Zotero.Prefs.set(PREF_OPENALEX_BASE_URL, stub, true);
        clearApiKeyPref();
        restoreRequest();
      }

      const logged = Zotero.Debug.getConsoleViewerOutput().filter((line: string) =>
        line.includes(API_KEY_SENTINEL),
      );
      expect(logged, "Debug Output lines carrying the api_key").to.be.empty;
      expect(
        await stubRequestsSince(requestsBefore),
        "requests that reached the loopback stub while the override named another host",
      ).to.be.empty;
    });
  });
});
