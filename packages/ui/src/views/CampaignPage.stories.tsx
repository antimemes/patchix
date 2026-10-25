import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import type { Campaign } from "@patchix/common";
import { CampaignPage, filtersKey, type CampaignTab } from "./CampaignPage.tsx";
import { withMock } from "../mock/client.tsx";
import { replaceParams } from "../router.ts";
import { CAMPAIGN, FREE_KEY, HEAD, SHARED, SHARED_ATTRS, at, branch, job, mixed, okRun, runningRun, task, worktreePath } from "../mock/fixtures.ts";

const ISSUE_TASKS = ["anki", "arduino-core", "autopsy", "calibre", "electrum", "gajim", "python3Packages.wassima", "zotero"];

/** The page reads its tab from the URL hash when it starts. */
const openTab = (tab: CampaignTab | null) => () => {
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${tab === null ? "" : `#${tab}`}`);
};

const meta = {
  title: "Storylines/Campaign page",
  component: CampaignPage,
  args: { campaign: "cacert" },
  // The page reads the selected states and the attribute text from the URL query, or from `sessionStorage`, when it starts. Each story starts with an empty query, and `sessionStorage` has no query.
  beforeEach: () => {
    replaceParams({ state: "", q: "" });
    window.sessionStorage.removeItem(filtersKey("cacert"));
    openTab(null)();
  },
} satisfies Meta<typeof CampaignPage>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Two entries with a branch that has a `running` run, and the other entries without a branch. */
function running(attrs: readonly string[] = ISSUE_TASKS) {
  const busy = ["anki", "calibre"];
  return {
    tasks: attrs.map((a) => task(a, busy.includes(a) ? { branch: a } : {})),
    branches: busy.map((a) => branch(a, { runs: [runningRun(a, a === "anki" ? 4 : 11), okRun(a, 300)], head: HEAD, worktree: worktreePath(a) })),
    jobs: [job("anki", 4), job("calibre", 11)],
  };
}

export const Todo: Story = {
  parameters: { docs: { description: { story: "1. After the first sync: each task is `todo`, and no branch covers it." } } },
  decorators: [withMock(() => ({ campaigns: [{ campaign: CAMPAIGN, synced: at(1), tasks: ISSUE_TASKS.map((a) => task(a)) }] }))],
};

export const QueueAll: Story = {
  parameters: { docs: { description: { story: "\"Queue selected\" adds the branch of each task to the queue: the key of its attribute. Then the fleet starts two runs, the `concurrency` of the settings, and six branches wait." } } },
  decorators: [withMock(() => ({ campaigns: [{ campaign: CAMPAIGN, synced: at(1), tasks: ISSUE_TASKS.map((a) => task(a)) }], fleetDelay: 300 }))],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByText(/^Select the \d+ shown tasks$/));
    await userEvent.click(canvas.getByRole("button", { name: /^Queue selected/ }));
    await canvas.findByText("Waiting: 6", undefined, { timeout: 3000 });
  },
};

export const Running: Story = {
  parameters: { docs: { description: { story: "2. Two runs operate: the jobs strip shows them, with a Stop button." } } },
  decorators: [withMock(() => ({ campaigns: [{ campaign: CAMPAIGN, synced: at(20), ...running() }] }))],
};

export const Mixed: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "3. Tasks in each state, with source flags, branches, worktrees, check badges, lint counts and the start time of the newest run. Three Ruby entries have one shared branch. The state of an entry is the state of its branch, and an entry without a branch is `todo`.",
      },
    },
  },
  decorators: [withMock(() => ({ campaigns: [{ campaign: CAMPAIGN, synced: at(42), ...mixed(), jobs: [job("arduino-core", 6), job("gajim", 2)] }] }))],
  play: async ({ canvas }) => {
    const row = (await canvas.findByRole("link", { name: "rubyPackages.httpclient" })).closest("tr");
    await expect(row).not.toBeNull();
    await within(row as HTMLElement).findByRole("link", { name: SHARED });
  },
};

export const Branches: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "The Branches tab: each branch with its entries as chips, its state, its newest run and its pull request. The shared branch covers three entries. The free-text branch and the branch of a run without a fix cover no entry.",
      },
    },
  },
  beforeEach: openTab("branches"),
  decorators: [withMock(() => ({ campaigns: [{ campaign: CAMPAIGN, synced: at(42), ...mixed(), jobs: [job("arduino-core", 6), job("gajim", 2)] }] }))],
  play: async ({ canvas, userEvent }) => {
    const table = within(await canvas.findByRole("table", { name: "Branches" }));
    const shared = (await table.findByRole("link", { name: SHARED })).closest("tr") as HTMLElement;
    for (const attr of SHARED_ATTRS) await within(shared).findByRole("link", { name: attr });
    const free = (await table.findByRole("link", { name: FREE_KEY })).closest("tr") as HTMLElement;
    await within(free).findByText("no entry");
    await userEvent.click(canvas.getByRole("button", { name: /^wontfix/ }));
    await table.findByRole("link", { name: "bitwarden-desktop" });
    await expect(table.queryByRole("link", { name: SHARED })).toBeNull();
  },
};

export const FreeTextRun: Story = {
  parameters: {
    docs: {
      description: {
        story: "The Run box at the top: a new key makes a new branch from the base. The text is necessary: it is the work for the agent. After Run, the key waits in the queue.",
      },
    },
  },
  decorators: [withMock(() => ({ campaigns: [{ campaign: CAMPAIGN, synced: at(42), ...mixed() }], fleetDelay: 60_000 }))],
  play: async ({ canvas, userEvent }) => {
    const box = within(await canvas.findByRole("region", { name: "Run" }));
    await userEvent.type(box.getByRole("textbox", { name: "Key" }), "python-certifi-hook");
    await box.findByText("A new branch must have a text: the work for the agent.");
    await expect(box.getByRole("button", { name: "Run" })).toBeDisabled();
    await userEvent.type(box.getByRole("textbox", { name: "Text" }), "Make one setup hook for the Python packages that bundle certifi.");
    await box.findByText("A new branch from the base. The text is the work for the agent.");
    await userEvent.click(box.getByRole("button", { name: "Run" }));
    await canvas.findByText("Waiting: 1");
    await canvas.findByRole("link", { name: "python-certifi-hook" });
  },
};

export const RunOfAnEntry: Story = {
  parameters: { docs: { description: { story: "The Run box with the attribute of an entry: a usual run of the branch of that key. The text is optional, and it is a question." } } },
  decorators: [withMock(() => ({ campaigns: [{ campaign: CAMPAIGN, synced: at(42), tasks: ISSUE_TASKS.map((a) => task(a)) }], fleetDelay: 60_000 }))],
  play: async ({ canvas, userEvent }) => {
    const box = within(await canvas.findByRole("region", { name: "Run" }));
    await userEvent.type(box.getByRole("textbox", { name: "Key" }), "anki");
    await box.findByText("A run of the branch anki. The text is a question.");
    await expect(box.getByRole("button", { name: "Run" })).toBeEnabled();
  },
};

export const Queued: Story = {
  parameters: {
    docs: { description: { story: "4. Two runs operate and three branches wait in the queue. The fleet operates: it starts the next run when a job stops. Each entry has a remove button." } },
  },
  decorators: [withMock(() => ({ campaigns: [{ campaign: CAMPAIGN, synced: at(20), ...running(), queue: ["zotero", "gajim", "electrum"] }] }))],
};

export const QueueWithoutFleet: Story = {
  parameters: { docs: { description: { story: "5. The queue has entries, but no fleet operates: for example, the fleet stopped with an error. The server starts a fleet in 30 seconds or less." } } },
  decorators: [withMock(() => ({ campaigns: [{ campaign: CAMPAIGN, synced: at(20), tasks: ISSUE_TASKS.map((a) => task(a)), queue: ["autopsy", "electrum"], fleet: false }], fleetDelay: 60_000 }))],
};

export const Busy: Story = {
  parameters: { docs: { description: { story: "6. Each job place is in use: \"Queue selected\" adds the branches to the queue, and they wait." } } },
  decorators: [withMock(() => ({ campaigns: [{ campaign: CAMPAIGN, synced: at(42), ...running(["anki", "calibre", "electrum", "zotero"]) }] }))],
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
  decorators: [
    withMock(() => {
      const data = mixed();
      return { campaigns: [{ campaign: NO_SOURCE, synced: at(42), branches: data.branches, tasks: data.tasks.map((t) => ({ ...t, in_source: false, in_issue: true })) }] };
    }),
  ],
};

export const FilterInUrl: Story = {
  parameters: { docs: { description: { story: "9. The URL query keeps the selected states and the attribute text: `?state=ready,merged&q=python`. Back from a branch page shows the same tasks. `sessionStorage` also keeps the query: the link to the campaign on a branch page shows the same tasks." } } },
  beforeEach: () => replaceParams({ state: "ready,merged", q: "python" }),
  decorators: [withMock(() => ({ campaigns: [{ campaign: CAMPAIGN, synced: at(42), ...mixed() }] }))],
  play: async ({ canvas }) => {
    await canvas.findByText("Select the 2 shown tasks");
  },
};

export const Error: Story = {
  decorators: [withMock(() => ({ campaigns: [], fail: { campaign: [404, "no campaign cacert: campaigns/cacert/campaign.yaml is not there"] } }))],
};
