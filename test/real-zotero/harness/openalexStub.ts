/**
 * Loopback OpenAlex stub for the real-Zotero suite.
 *
 * Started by the scaffold `test:init` hook in `zotero-plugin.config.ts`, which
 * writes its URL into the test profile's base-URL override pref before Zotero
 * launches. Citegeist honours that pref only for loopback hosts, so every
 * request the suite makes lands here and none reaches OpenAlex or spends a
 * metered budget. Runs in the scaffold Node process, never inside Zotero.
 */
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { STUB_REQUEST_LOG_PATH, routeOpenAlexRequest, type StubResponse } from "./fixture";

export interface OpenAlexStub {
  /** Origin to put in the override pref, e.g. `http://127.0.0.1:43121`. */
  readonly url: string;
  /** Path and query of every OpenAlex request received, oldest first. */
  readonly requests: readonly string[];
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, { status, body }: StubResponse): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Start the stub on an ephemeral 127.0.0.1 port. */
export async function startOpenAlexStub(): Promise<OpenAlexStub> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const pathAndQuery = req.url ?? "/";
    if (req.method !== "GET") {
      sendJson(res, { status: 405, body: { error: "Method not allowed" } });
      return;
    }
    if (new URL(pathAndQuery, "http://stub.invalid").pathname === STUB_REQUEST_LOG_PATH) {
      sendJson(res, { status: 200, body: { requests } });
      return;
    }
    requests.push(pathAndQuery);
    sendJson(res, routeOpenAlexRequest(pathAndQuery));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  // The scaffold reporter keeps the process alive for the run; the stub must not
  // hold it open after Zotero exits.
  server.unref();

  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
