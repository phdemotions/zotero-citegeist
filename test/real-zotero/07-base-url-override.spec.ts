/**
 * A non-loopback base-URL override is ignored end to end.
 *
 * Catches: an override honoured for any host, which would let a crafted pref
 * send every request, with the user's api_key on its query string, to another
 * machine. `Zotero.HTTP.request` is intercepted for Citegeist's requests only
 * and answered from the fixture, so nothing leaves the runner.
 */
import { OPENALEX_API_BASE_URL, PREF_OPENALEX_BASE_URL } from "../../src/constants";
import { STUB_DOI, routeOpenAlexRequest } from "./harness/fixture";
import { createJournalArticle, stubBaseUrl } from "./support/zotero";

const HOSTILE_BASE_URL = "https://evil.example";

describe("OpenAlex base-URL override", function () {
  it("ignores a non-loopback host and sends requests to api.openalex.org", async function () {
    const stub = stubBaseUrl();
    expect(stub, "positive control: the harness pointed Citegeist at the loopback stub").to.match(
      /^http:\/\/127\.0\.0\.1:\d+$/,
    );

    const item = await createJournalArticle("Citegeist base-URL spec", STUB_DOI);
    const request = Zotero.HTTP.request;
    const citegeistUrls: string[] = [];
    Zotero.HTTP.request = function (
      method: string,
      url: string,
      options?: { headers?: Record<string, string> },
    ) {
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
    };
    Zotero.Prefs.set(PREF_OPENALEX_BASE_URL, HOSTILE_BASE_URL, true);
    try {
      const result = await Zotero.Citegeist.fetchItems([item.id]);
      expect(result, "bridge fetch resolved undefined (see Debug Output)").to.exist;
      expect(result.fresh, JSON.stringify(result)).to.equal(1);

      expect(citegeistUrls, "positive control: Citegeist issued requests").to.not.be.empty;
      const elsewhere = citegeistUrls.filter((u) => !u.startsWith(`${OPENALEX_API_BASE_URL}/`));
      expect(elsewhere, "requests that left for a host other than OpenAlex").to.be.empty;
    } finally {
      Zotero.Prefs.set(PREF_OPENALEX_BASE_URL, stub, true);
      Zotero.HTTP.request = request;
      await item.eraseTx();
    }
  });
});
