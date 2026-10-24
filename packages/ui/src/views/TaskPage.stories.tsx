import type { Meta, StoryObj } from "@storybook/react-vite";
import { within } from "storybook/test";
import type { Pr as PrMeta, TaskView } from "@patchix/common";
import { TaskPage, type PageTab } from "./TaskPage.tsx";
import { withMock, type MockCampaign } from "../mock/client.tsx";
import {
  CAMPAIGN,
  HEAD,
  at,
  ask,
  description,
  failedPublishLog,
  failedRun,
  idAt,
  importedRun,
  job,
  okRun,
  prMeta,
  publishLog,
  roughDescription,
  runningRun,
  stoppedRun,
  task,
  unverifiedRun,
  wontfixRun,
  worktreePath,
} from "../mock/fixtures.ts";

const A = "python3Packages.wassima";

function seed(t: () => TaskView, extra: Omit<Partial<MockCampaign>, "tasks"> = {}) {
  return withMock(() => ({ campaigns: [{ campaign: CAMPAIGN, synced: at(30), tasks: [t()], ...extra }] }));
}

/** The tick box above the pull request button. The person sets it before the click. */
const CONFIRM = /^I established confidence in this output/;
/** The mock request of the pull request button operates for approximately 2 seconds. */
const PR_REQUEST = { timeout: 5000 };

/** The page reads its tab from the URL hash when it starts. */
const openTab = (tab: PageTab) => () => {
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#${tab}`);
};

const meta = {
  title: "Storylines/Task page",
  component: TaskPage,
  args: { campaign: "cacert", attr: A },
  beforeEach: openTab("work"),
} satisfies Meta<typeof TaskPage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Todo: Story = {
  parameters: { docs: { description: { story: "1. Work tab, todo: no run. The issue entry shows the tick box, the paths, the notes and the branch. The Queue button adds the task to the queue." } } },
  decorators: [seed(() => task(A))],
};

export const Queued: Story = {
  parameters: { docs: { description: { story: "Work tab: the task waits in the queue after one other task. The button removes it from the queue." } } },
  decorators: [seed(() => task(A, { state: "failed", runs: [failedRun(A, 40)], head: HEAD }), { queue: ["calibre", A], fleet: true })],
};

export const Running: Story = {
  parameters: {
    docs: { description: { story: "2. Work tab, running: the Stop button stops the job. The notice above the tabs of the run gives the zellij tab of the run." } },
  },
  decorators: [
    seed(() => task(A, { state: "running", runs: [runningRun(A, 3)], worktree: worktreePath(A), head: HEAD }), {
      jobs: [{ attr: A, kind: "run", id: idAt(3), started: at(3) }],
    }),
  ],
};

export const RunCommits: Story = {
  parameters: {
    docs: {
      description: {
        story: "Work tab: the Commits tab of a run gives each commit from the base to the head of the run, as `git show` gives it: the full message with the `Assisted-by:` line, then the patch of the commit.",
      },
    },
  },
  decorators: [seed(() => task(A, { state: "ready", runs: [okRun(A, 25)], head: HEAD, worktree: worktreePath(A) }))],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("tab", { name: "Commits" }));
    const list = await canvas.findByRole("list", { name: /^Commits of run / });
    await within(list).findByText(/Assisted-by: Claude Code \(Claude Opus 5\.5\)$/);
    await within(list).findByLabelText(/^Patch of commit /);
  },
};

export const RunPrompt: Story = {
  parameters: { docs: { description: { story: "Work tab: the Prompt tab of a run gives `prompt.md`. The page reads it when the tab opens." } } },
  decorators: [seed(() => task(A, { state: "ready", runs: [okRun(A, 25)], head: HEAD, worktree: worktreePath(A) }))],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("tab", { name: "Prompt" }));
  },
};

export const AskRunning: Story = {
  parameters: { docs: { description: { story: "Work tab: an ask that operates. A notice gives the zellij tab of the ask, and its Prompt gives the prompt." } } },
  decorators: [
    seed(() => task(A, { state: "ready", runs: [okRun(A, 25)], head: HEAD, worktree: worktreePath(A) }), {
      asks: { [A]: [ask(A, 2, { status: "running", finished: null, pid: 51234, question: "Does the package also read the bundle at run time?" })] },
      jobs: [job(A, "ask", 2)],
    }),
  ],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: "Prompt" }));
  },
};

export const Failed: Story = {
  parameters: { docs: { description: { story: "3. Work tab, failed: the command of the harness stopped with an error. The error and the check output show." } } },
  decorators: [seed(() => task(A, { state: "failed", runs: [failedRun(A, 40), stoppedRun(A, 120)], head: HEAD }))],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("tab", { name: /Checks/ }));
  },
};

export const Unverified: Story = {
  parameters: {
    docs: {
      description: {
        story: "Work tab, unverified: the agent made a fix, but the output of the harness did not agree with its pass expression. A person examines the check output and makes the decision.",
      },
    },
  },
  decorators: [seed(() => task(A, { state: "unverified", runs: [unverifiedRun(A, 30), failedRun(A, 120)], head: HEAD, worktree: worktreePath(A) }))],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("tab", { name: /Checks/ }));
    await canvas.findByText(/A person examines it and makes the decision/);
  },
};

export const UnverifiedToPublish: Story = {
  parameters: {
    docs: {
      description: {
        story: "Publish tab, unverified: the notice above the tick box gives the checks that did not pass. The person examined the output and set the tick box. Thus the button is enabled.",
      },
    },
  },
  beforeEach: openTab("publish"),
  decorators: [
    seed(() => task(A, { state: "unverified", runs: [unverifiedRun(A, 25)], head: HEAD, worktree: worktreePath(A), pr_meta: prMeta(A, idAt(25)) }), {
      drafts: { [A]: description(A) },
    }),
  ],
  play: async ({ canvas, userEvent }) => {
    await canvas.findByText(/The newest run is unverified: the output of harness did not agree/);
    await userEvent.click(await canvas.findByRole("checkbox", { name: CONFIRM }));
  },
};

export const Wontfix: Story = {
  parameters: {
    docs: { description: { story: "Work tab, wontfix: the agent made no commit and its description starts with `## No small fix`. A person must change the entry of the issue." } },
  },
  decorators: [seed(() => task(A, { state: "wontfix", runs: [wontfixRun(A, 30), failedRun(A, 120)], worktree: worktreePath(A) }))],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("tab", { name: /Description/ }));
    await canvas.findByText(/A person must change the entry of the issue: for example/);
  },
};

export const ReadyNoDraft: Story = {
  parameters: { docs: { description: { story: '4. Publish tab, ready, no draft: "Make draft from run" takes the description of the newest ok run and the labels of the campaign.' } } },
  beforeEach: openTab("publish"),
  decorators: [seed(() => task(A, { state: "ready", runs: [okRun(A, 25), failedRun(A, 90)], head: HEAD, worktree: worktreePath(A) }))],
};

export const ReadyDraft: Story = {
  parameters: { docs: { description: { story: "5. Publish tab, ready, with a draft: two lint findings and an ask that operates. The pull request button gives the reasons." } } },
  beforeEach: openTab("publish"),
  decorators: [
    seed(() => task(A, { state: "ready", runs: [okRun(A, 25), failedRun(A, 90)], head: HEAD, worktree: worktreePath(A), pr_meta: prMeta(A, idAt(25)) }), {
      drafts: { [A]: roughDescription(A) },
      asks: {
        [A]: [
          ask(A, 2, { status: "running", finished: null, pid: 51234, question: "Does the package also read the bundle at run time?" }),
          ask(A, 15, { files: ["pkgs/development/python-modules/wassima/default.nix"], question: "Why is the symlink sufficient? Add a test for the import of the bundle." }),
          ask(A, 60),
        ],
      },
      jobs: [job(A, "ask", 2)],
    }),
  ],
};

export const ReadyToPublish: Story = {
  parameters: { docs: { description: { story: "6. Publish tab, ready: no findings, an ok run and no job. The person set the tick box: they established confidence in this output. Thus the button is enabled." } } },
  beforeEach: openTab("publish"),
  decorators: [
    seed(() => task(A, { state: "ready", runs: [okRun(A, 25)], head: HEAD, worktree: worktreePath(A), pr_meta: prMeta(A, idAt(25)) }), {
      drafts: { [A]: description(A) },
    }),
  ],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("checkbox", { name: CONFIRM }));
  },
};

export const DraftNotSaved: Story = {
  parameters: { docs: { description: { story: "Publish tab: the draft has a change that is not saved. The findings are of the saved draft: lint runs when the person saves the draft." } } },
  beforeEach: openTab("publish"),
  decorators: [
    seed(() => task(A, { state: "ready", runs: [okRun(A, 25)], head: HEAD, worktree: worktreePath(A), pr_meta: prMeta(A, idAt(25)) }), {
      drafts: { [A]: roughDescription(A) },
    }),
  ],
  play: async ({ canvas, userEvent }) => {
    await userEvent.type(await canvas.findByRole("textbox", { name: "Title" }), " again");
    await canvas.findByText("Lint runs when you save the draft.");
  },
};

export const PublishCreated: Story = {
  parameters: { docs: { description: { story: "Publish tab: the person set the tick box and clicked Create pull request. The Output under the button opens and gives each command and its output. The tick box is clear again, and the link of the pull request gives the time of the confirmation." } } },
  beforeEach: openTab("publish"),
  decorators: [
    seed(() => task(A, { state: "ready", runs: [okRun(A, 25)], head: HEAD, worktree: worktreePath(A), pr_meta: prMeta(A, idAt(25)) }), {
      drafts: { [A]: description(A) },
    }),
  ],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("checkbox", { name: CONFIRM }));
    await userEvent.click(await canvas.findByRole("button", { name: "Create pull request" }));
    await canvas.findByText(/^Confidence confirmed /, undefined, PR_REQUEST);
    await canvas.findByLabelText("Output of the publish");
  },
};

export const Publishing: Story = {
  parameters: {
    docs: {
      description: {
        story: "Publish tab: the request of Create pull request operates. The Output opens empty at the click. Each second, the page reads publish.log and shows the commands that started. At the end, the log of the response replaces it.",
      },
    },
  },
  beforeEach: openTab("publish"),
  decorators: [
    seed(() => task(A, { state: "ready", runs: [okRun(A, 25)], head: HEAD, worktree: worktreePath(A), pr_meta: prMeta(A, idAt(25)) }), {
      drafts: { [A]: description(A) },
      publishLogs: { [A]: failedPublishLog(A) },
    }),
  ],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("checkbox", { name: CONFIRM }));
    await userEvent.click(await canvas.findByRole("button", { name: "Create pull request" }));
    await canvas.findByText("Loading…");
    // The first read gives a part of the log, before the response.
    await canvas.findByText(/\$ git push fork/, undefined, PR_REQUEST);
    await canvas.findByRole("button", { name: "Create pull request", busy: true });
    await canvas.findByText(/# the pull request is #580201/, undefined, PR_REQUEST);
  },
};

export const PublishFailed: Story = {
  parameters: {
    docs: { description: { story: "Publish tab: the person set the tick box, and GitHub refused the new pull request. The error shows, and the Output opens with the output of git and gh. The tick box stays set." } },
  },
  beforeEach: openTab("publish"),
  decorators: [
    withMock(() => ({
      campaigns: [
        {
          campaign: CAMPAIGN,
          synced: at(30),
          tasks: [task(A, { state: "ready", runs: [okRun(A, 25)], head: HEAD, worktree: worktreePath(A), pr_meta: prMeta(A, idAt(25)) })],
          drafts: { [A]: description(A) },
        },
      ],
      fail: {
        createPr: [
          500,
          `gh api -X POST failed (1): gh: Validation Failed (HTTP 422)\n{"message":"Validation Failed","errors":[{"resource":"PullRequest","code":"custom","message":"A pull request already exists for someone:cacert/${A}."}]}`,
          { publish_log: failedPublishLog(A) },
        ],
      },
    })),
  ],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("checkbox", { name: CONFIRM }));
    await userEvent.click(await canvas.findByRole("button", { name: "Create pull request" }));
    await canvas.findByText(/\[exit code 1\]/, undefined, PR_REQUEST);
  },
};

export const PublishPreview: Story = {
  parameters: {
    docs: {
      description: {
        story: "Publish tab: the preview shows the description as GitHub shows it. The AI disclosure is a warning alert, the check output is in an open details block, and the template is a task list.",
      },
    },
  },
  beforeEach: openTab("publish"),
  decorators: [
    seed(() => task(A, { state: "ready", runs: [okRun(A, 25)], head: HEAD, worktree: worktreePath(A), pr_meta: prMeta(A, idAt(25), { labels: ["1.severity: security", "6.topic: python"] }) }), {
      drafts: { [A]: description(A) },
    }),
  ],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByText(`Output of harness: ${A}`));
  },
};

export const LabelsUnavailable: Story = {
  parameters: { docs: { description: { story: "Publish tab: gh did not give the labels. The chosen labels stay, and a notice gives the error." } } },
  beforeEach: openTab("publish"),
  decorators: [
    withMock(() => ({
      campaigns: [{ campaign: CAMPAIGN, synced: at(30), tasks: [task(A, { state: "ready", runs: [okRun(A, 25)], head: HEAD, pr_meta: prMeta(A, idAt(25)) })], drafts: { [A]: description(A) } }],
      fail: { labels: [502, "gh label list: HTTP 401: Bad credentials"] },
    })),
  ],
};

export const Pr: Story = {
  parameters: { docs: { description: { story: "7. Publish tab, pr: the pull request is made. The tab shows the link and the time of the confirmation. After the tick box, the button writes the description again." } } },
  beforeEach: openTab("publish"),
  decorators: [
    seed(
      () =>
        task(A, {
          state: "pr",
          runs: [okRun(A, 300)],
          head: HEAD,
          pr_meta: prMeta(A, idAt(300), {
            number: 580114,
            url: "https://github.com/NixOS/nixpkgs/pull/580114",
            created: at(200),
            updated: at(45),
            confirmed: at(45),
            pushed: "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d",
          }),
        }),
      { drafts: { [A]: description(A) }, publishLogs: { [A]: publishLog(A, 580114, 45) } },
    ),
  ],
};

const made = (minutesAgo: number, p: Partial<PrMeta> = {}) =>
  prMeta(A, idAt(minutesAgo), {
    number: 579002,
    url: "https://github.com/NixOS/nixpkgs/pull/579002",
    created: at(minutesAgo - 100),
    updated: at(minutesAgo - 100),
    confirmed: at(minutesAgo - 100),
    pushed: HEAD,
    ...p,
  });

export const Merged: Story = {
  parameters: {
    docs: { description: { story: "8. Publish tab, merged: the refresh read the merge on GitHub. The tab shows the merge time, and the button is disabled with the reason." } },
  },
  beforeEach: openTab("publish"),
  decorators: [
    seed(() => task(A, { state: "merged", checked: true, runs: [okRun(A, 3000)], head: HEAD, pr_meta: made(3000, { state: "merged", merged: at(600) }) }), {
      drafts: { [A]: description(A) },
    }),
  ],
};

export const Closed: Story = {
  parameters: { docs: { description: { story: "9. Publish tab, closed: the pull request is closed without a merge. The button is disabled with the reason." } } },
  beforeEach: openTab("publish"),
  decorators: [
    seed(() => task(A, { state: "closed", runs: [okRun(A, 3000)], head: HEAD, pr_meta: made(3000, { state: "closed" }) }), {
      drafts: { [A]: description(A) },
    }),
  ],
};

const RUBY = "rubyPackages.excon";
const SHARED = "cacert/rubyPackages.algoliasearch-excon-httpclient-nap";

export const Imported: Story = {
  parameters: {
    docs: {
      description: {
        story: "Work tab: a run with the tag `imported`. The import command got the commit of a person from a different checkout. The branch of the task is the branch of four tasks.",
      },
    },
  },
  args: { attr: RUBY },
  decorators: [
    seed(() => task(RUBY, { state: "ready", runs: [importedRun(RUBY, 30)], branch: SHARED, branch_name: SHARED, head: HEAD, pr_meta: prMeta(RUBY, idAt(30), { words: ["gem"] }) }), {
      drafts: { [RUBY]: description(RUBY) },
    }),
  ],
};

export const DoneElsewhere: Story = {
  parameters: { docs: { description: { story: "Work tab, external: an issue entry with a pull request that patchix did not make, and no draft." } } },
  args: { attr: "akkoma" },
  decorators: [seed(() => task("akkoma", { state: "external", checked: true, pr: 576652, remark: "(beamPackages)", notes: "", paths: ["/lib/castore-1.0.17/priv/cacerts.pem"] }))],
};

export const Error: Story = {
  decorators: [withMock(() => ({ campaigns: [], fail: { task: [404, `the campaign cacert has no task ${A}`] } }))],
};
