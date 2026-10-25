import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { cacheUntracked, context, ensureFleets, listCampaigns, message, readCampaign, repoPath } from "@patchix/fleet";
import { app } from "./routes.ts";

const { values } = parseArgs({ options: { port: { type: "string", default: "8788" }, host: { type: "string", default: "127.0.0.1" } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`--port must be a number from 0 to 65535, not ${values.port}`);
  process.exit(2);
}
const ctx = context();
// `readCampaign` writes one warning for a `campaign.yaml` with keys that patchix does not use, for example `fork`.
for (const c of await listCampaigns(ctx)) await readCampaign(ctx, c).catch((e: unknown) => console.error(`campaign ${c}: ${message(e)}`));
// A repository of a previous version does not have this value. The page of a task gets `git status` of its worktree.
await cacheUntracked(repoPath(ctx)).catch((e: unknown) => console.error(`core.untrackedCache: ${message(e)}`));
const server = serve({ fetch: app(ctx).fetch, port, hostname: values.host }, (info) => {
  const host = info.family === "IPv6" ? `[${info.address}]` : info.address;
  console.log(`patchix at http://${host}:${info.port}/ (runs in the zellij session patchix)`);
});
server.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});

// A queue with entries must have a fleet: for example, after a fleet stopped with an error, or when the server starts again.
const FLEETS_MS = 30_000;
const fleets = () => void ensureFleets(ctx, (c, e) => console.error(`fleet ${c}: ${message(e)}`)).catch((e: unknown) => console.error(`fleets: ${message(e)}`));
fleets();
setInterval(fleets, FLEETS_MS);
