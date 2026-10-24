import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Campaign } from "@patchix/common";
import { CampaignPage, filtersKey } from "./CampaignPage.tsx";
import { withMock } from "../mock/client.tsx";
import { replaceParams } from "../router.ts";
import { CAMPAIGN, at, job, mixedTasks, runningRun, task, worktreePath } from "../mock/fixtures.ts";

const ISSUE_TASKS = ["anki", "arduino-core", "autopsy", "calibre", "electrum", "gajim", "python3Packages.wassima", "zotero"];

const meta = {
  title: "Storylines/Campaign page",
  component: CampaignPage,
  args: { campaign: "cacert" },
  // The page reads the selected states and the attribute text from the URL query, or from `sessionStorage`, when it starts. Each story starts with an empty query, and `sessionStorage` has no query.
  beforeEach: () => {
    replaceParams({ state: "", q: "" });
    window.sessionStorage.removeItem(filtersKey("cacert"));
  },
} satisfies Meta<typeof CampaignPage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Todo: Story = {
  parameters: { docs: { description: { story: "1. After the first sync: each task is `todo`." } } },
  decorators: [withMock(() => ({ campaigns: [{ campaign: CAMPAIGN, synced: at(1), tasks: ISSUE_TASKS.map((a) => task(a)) }] }))],
};

export const QueueAll: Story = {
  parameters: { docs: { description: { story: "\"Queue selected\" adds each task to the queue. Then the fleet starts two runs, the `concurrency` of the settings, and six tasks wait." } } },
  decorators: [withMock(() => ({ campaigns: [{ campaign: CAMPAIGN, synced: at(1), tasks: ISSUE_TASKS.map((a) => task(a)) }], fleetDelay: 300 }))],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByText(/^Select the \d+ shown tasks$/));
    await userEvent.click(canvas.getByRole("button", { name: /^Queue selected/ }));
    await canvas.findByText("Waiting: 6", undefined, { timeout: 3000 });
  },
};

export const Running: Story = {
  parameters: { docs: { description: { story: "2. Two runs operate: the jobs strip shows them, with a Stop button." } } },
  decorators: [
    withMock(() => ({
      campaigns: [
        {
          campaign: CAMPAIGN,
          synced: at(20),
          tasks: ISSUE_TASKS.map((a) =>
            a === "anki" || a === "calibre" ? task(a, { state: "running", runs: [runningRun(a, a === "anki" ? 4 : 11)], worktree: worktreePath(a) }) : task(a),
          ),
          jobs: [job("anki", "run", 4), job("calibre", "run", 11)],
        },
      ],
    })),
  ],
};

export const Mixed: Story = {
  parameters: { docs: { description: { story: "3. Tasks in each state, with source flags, worktrees, check badges, lint counts and the start time of the newest run: some minutes, hours or days ago." } } },
  decorators: [withMock(() => ({ campaigns: [{ campaign: CAMPAIGN, synced: at(42), tasks: mixedTasks(), jobs: [job("arduino-core", "run", 6), job("gajim", "run", 2)] }] }))],
};

export const Queued: Story = {
  parameters: {
    docs: { description: { story: "4. Two runs operate and three tasks wait in the queue. The fleet operates: it starts the next run when a job stops. Each entry has a remove button." } },
  },
  decorators: [
    withMock(() => ({
      campaigns: [
        {
          campaign: CAMPAIGN,
          synced: at(20),
          tasks: ISSUE_TASKS.map((a) =>
            a === "anki" || a === "calibre" ? task(a, { state: "running", runs: [runningRun(a, a === "anki" ? 4 : 11)], worktree: worktreePath(a) }) : task(a),
          ),
          jobs: [job("anki", "run", 4), job("calibre", "run", 11)],
          queue: ["zotero", "gajim", "electrum"],
        },
      ],
    })),
  ],
};

export const QueueWithoutFleet: Story = {
  parameters: { docs: { description: { story: "5. The queue has entries, but no fleet operates: for example, the fleet stopped with an error. The server starts a fleet in 30 seconds or less." } } },
  decorators: [withMock(() => ({ campaigns: [{ campaign: CAMPAIGN, synced: at(20), tasks: ISSUE_TASKS.map((a) => task(a)), queue: ["autopsy", "electrum"], fleet: false }], fleetDelay: 60_000 }))],
};

export const Busy: Story = {
  parameters: { docs: { description: { story: "6. Each job place is in use: \"Queue selected\" adds the tasks to the queue, and they wait." } } },
  decorators: [
    withMock(() => ({
      campaigns: [
        {
          campaign: CAMPAIGN,
          synced: at(42),
          tasks: mixedTasks().filter((t) => t.state === "todo" || t.state === "running"),
          jobs: [job("arduino-core", "run", 6), job("gajim", "run", 2)],
        },
      ],
    })),
  ],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByText(/^Select the \d+ shown tasks$/));
    await userEvent.click(canvas.getByRole("button", { name: /^Queue selected/ }));
    await canvas.findByText(/^Waiting: \d+$/);
  },
};

export const NoTasks: Story = {
  parameters: { docs: { description: { story: "7. A campaign that was not synced." } } },
  decorators: [withMock(() => ({ campaigns: [{ campaign: CAMPAIGN, synced: null, tasks: [] }] }))],
};

const NO_SOURCE: Campaign = {
  name: CAMPAIGN.name,
  title: CAMPAIGN.title,
  issue: CAMPAIGN.issue,
  base_branch: CAMPAIGN.base_branch,
  branch_prefix: CAMPAIGN.branch_prefix,
  labels: CAMPAIGN.labels,
  checks: CAMPAIGN.checks,
  timeout_minutes: CAMPAIGN.timeout_minutes,
};

export const NoSource: Story = {
  parameters: { docs: { description: { story: "8. Without a `source` command: no source column." } } },
  decorators: [withMock(() => ({ campaigns: [{ campaign: NO_SOURCE, synced: at(42), tasks: mixedTasks().map((t) => ({ ...t, in_source: false, in_issue: true })) }] }))],
};

export const FilterInUrl: Story = {
  parameters: { docs: { description: { story: "9. The URL query keeps the selected states and the attribute text: `?state=ready,merged&q=python`. Back from a task page shows the same tasks. `sessionStorage` also keeps the query: the link to the campaign on a task page shows the same tasks." } } },
  beforeEach: () => replaceParams({ state: "ready,merged", q: "python" }),
  decorators: [withMock(() => ({ campaigns: [{ campaign: CAMPAIGN, synced: at(42), tasks: mixedTasks() }] }))],
  play: async ({ canvas }) => {
    await canvas.findByText("Select the 2 shown tasks");
  },
};

export const Error: Story = {
  decorators: [withMock(() => ({ campaigns: [], fail: { campaign: [404, "no campaign cacert: campaigns/cacert/campaign.yaml is not there"] } }))],
};
