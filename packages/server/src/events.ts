/**
 * The server-sent events. A watcher on `state/` makes the events. Thus a change from the page, from a runner or the
 * fleet in zellij, from a text editor or from `git` gets to each open page. A change of a `run.yaml`, the queue or
 * `fleet.yaml` gives a `jobs` event.
 */
import { mkdirSync, watch } from "node:fs";
import { join } from "node:path";
import { CAMPAIGN_NAME, KEY, type Event } from "@patchix/common";
import { jobsView, message, type Ctx } from "@patchix/fleet";

const DELAY_MS = 200;
export const PING_MS = 25_000;

/**
 * The campaign and the branch of a path in `state/`. `view`: the files of the campaign view changed. `job`: the jobs,
 * the queue or the fleet changed. A temporary file and `fleet.log` give `null`.
 */
export function changeOf(path: string): { campaign: string; key: string | null; view: boolean; job: boolean } | null {
  const parts = path.split(/[\\/]/);
  const [campaign = "", kind, key = ""] = parts;
  const file = parts.at(-1) ?? "";
  if (!CAMPAIGN_NAME.test(campaign) || file.endsWith(".tmp") || (parts.length === 2 && file === "fleet.log")) return null;
  if (kind === "queue" || (parts.length === 2 && file === "fleet.yaml")) return { campaign, key: null, view: false, job: true };
  const job = file === "run.yaml";
  return { campaign, key: kind === "branches" && KEY.test(key) ? key : null, view: true, job };
}

export interface Hub {
  /** Adds a connection. Gives the function that removes it. */
  connect(send: (event: Event) => void): () => void;
  close(): void;
}

export function hub(ctx: Ctx): Hub {
  const clients = new Set<(event: Event) => void>();
  const timers = new Map<string, NodeJS.Timeout>();
  const broadcast = (event: Event) => {
    for (const send of clients) send(event);
  };
  /** Does `task` after `DELAY_MS`. More requests with the same key in that time do not add to it. */
  const later = (key: string, task: () => Promise<void> | void) => {
    if (timers.has(key)) return;
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        void Promise.resolve(task()).catch((e: unknown) => console.error(`event ${key}: ${message(e)}`));
      }, DELAY_MS),
    );
  };
  const dir = join(ctx.data, "state");
  mkdirSync(dir, { recursive: true });
  // A run writes its log and the output of its checks continuously: thus each key gets one event or less in each `DELAY_MS`.
  const watcher = watch(dir, { recursive: true }, (_, name) => {
    const change = changeOf(String(name ?? ""));
    if (change === null) return;
    const { campaign, key } = change;
    if (change.view) later(`campaign:${campaign}/${key ?? ""}`, () => broadcast({ type: "campaign", campaign, key }));
    if (change.job) later(`jobs:${campaign}`, async () => broadcast({ type: "jobs", campaign, ...(await jobsView(ctx, campaign)) }));
  });
  watcher.on("error", (e) => console.error(`watch ${dir}: ${e.message}`));
  watcher.unref();
  return {
    connect(send) {
      clients.add(send);
      return () => clients.delete(send);
    },
    close() {
      watcher.close();
      for (const t of timers.values()) clearTimeout(t);
    },
  };
}
