/**
 * A local HTTP server standing in for the update channel URL in the channel check tests. It serves
 * the routes in the JSON file its first argument names, reread on every request, as
 * { "<path>": { "status": <code>, "body": "<text>" } }, answers 404 for anything else, and prints
 * its port on the first line of stdout. It runs in its own process so a test can run the CLI with
 * spawnSync while the server answers.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const routesFile = process.argv[2];

const server = createServer((request, response) => {
  const route = JSON.parse(readFileSync(routesFile, "utf8"))[request.url ?? ""];
  if (!route) {
    response.writeHead(404);
    response.end("Not Found");
    return;
  }
  response.writeHead(route.status);
  response.end(route.body);
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`${server.address().port}\n`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
