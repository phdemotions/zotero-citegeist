/**
 * A local HTTP server standing in for the update channel URL in the channel check tests. It serves
 * the routes in the JSON file its first argument names, reread on every request, answers 404 for
 * anything else, appends each request's path to `<routes file>.log`, and prints its port on the
 * first line of stdout. It runs in its own process so a test can run the CLI with spawnSync while
 * the server answers.
 *
 * A route is one of:
 *
 *   { "status": <code>, "body": "<text>", "headers": { ... } }   the same answer every time
 *   { "redirect": "<path>" }                                     a 302 to another path, with
 *                                                                cache-control: no-cache, as
 *                                                                github.com answers a release
 *                                                                asset URL
 *   { "sequence": [<answer>, ...] }                              one answer per request, in order,
 *                                                                the last one repeating
 */
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

const routesFile = process.argv[2];
/** Requests answered per route, keyed by the route's own definition, so a new route starts over. */
const served = new Map();

const server = createServer((request, response) => {
  const path = request.url ?? "";
  appendFileSync(`${routesFile}.log`, `${path}\n`);
  const route = JSON.parse(readFileSync(routesFile, "utf8"))[path];
  if (!route) {
    response.writeHead(404);
    response.end("Not Found");
    return;
  }
  if (route.redirect) {
    response.writeHead(302, { location: route.redirect, "cache-control": "no-cache" });
    response.end();
    return;
  }
  let answer = route;
  if (Array.isArray(route.sequence)) {
    const key = `${path} ${JSON.stringify(route)}`;
    const count = served.get(key) ?? 0;
    served.set(key, count + 1);
    answer = route.sequence[Math.min(count, route.sequence.length - 1)];
  }
  response.writeHead(answer.status, answer.headers ?? {});
  response.end(answer.body ?? "");
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`${server.address().port}\n`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
