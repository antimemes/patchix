import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, waitFor, within } from "storybook/test";
import type { BranchView, Pr as PrMeta, Task } from "@patchix/common";
import { BranchPage, type PageTab } from "./BranchPage.tsx";
import { withMock, type MockCampaign } from "../mock/client.tsx";
import {
  AMENDED,
  CAMPAIGN,
  CONFLICT,
  FREE_KEY,
  FREE_TEXT,
  SHARED,
  SHARED_ATTRS,
  badMarkDescription,
  branch,
  HEAD,
  at,
  description,
  failedPublishLog,
  failedRun,
  importedRun,
  job,
  okRun,
  prMeta,
  publishLog,
  QUESTION,
  questionRun,
  roughDescription,
  rubyBranches,
  runningRun,
  stoppedRun,
  task,
  trailerProblems,
  unverifiedRun,
  wontfixRun,
  worktreePath,
} from "../mock/fixtures.ts";

const A = "python3Packages.wassima";

/**
 * The mock with the branch of `b`. The task list has the entry `A`, and the entry links to the branch: for example
 * after a run with checks that are `pass`. `extra.tasks` gives a different task list.
 */
function seed(b: () => BranchView, extra: Omit<Partial<MockCampaign>, "branches"> = {}) {
  return withMock(() => ({ campaigns: [{ campaign: CAMPAIGN, synced: at(30), branches: [b()], ...extra, tasks: extra.tasks ?? [task(A, { branch: A })] }] }));
}
/** The entry `A` without a branch: no run of `A` had checks that are `pass`. */
const unlinked: Task[] = [task(A)];

/** The tick box above the pull request button. The person sets it before the click. */
const CONFIRM = /^I established confidence in this output/;
/** The mock request of the pull request button operates for approximately 2 seconds. */
const PR_REQUEST = { timeout: 5000 };

/** The page reads its tab from the URL hash when it starts. */
const openTab = (tab: PageTab) => () => {
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#${tab}`);
};

const meta = {
  title: "Storylines/Branch page",
  component: BranchPage,
  args: { campaign: "cacert", branch: A },
  beforeEach: openTab("work"),
} satisfies Meta<typeof BranchPage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Todo: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "1. Work tab, todo: the branch of the key of an entry, without runs. The entry does not link to the branch yet. The Run button adds the branch to the queue, with the question of the text area or without a question.",
      },
    },
  },
  decorators: [seed(() => branch(A), { tasks: unlinked })],
  play: async ({ canvas }) => {
    await canvas.findByText("The branch covers no entry.");
    await canvas.findByText("not an entry of this branch");
  },
};

export const Queued: Story = {
  parameters: { docs: { description: { story: "Work tab: the branch waits in the queue after one other branch. The Run button is disabled, and the Remove from queue button removes the branch from the queue." } } },
  decorators: [seed(() => branch(A, { runs: [failedRun(A, 40)], head: HEAD }), { queue: ["calibre", A], fleet: true })],
  play: async ({ canvas }) => {
    await canvas.findByText("The branch is in the queue.");
    await expect(canvas.getByRole("button", { name: "Run" })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "Remove from queue" })).toBeEnabled();
  },
};

export const Running: Story = {
  parameters: {
    docs: { description: { story: "2. Work tab, running: the Stop button stops the job. The notice above the tabs of the run gives the zellij tab of the run." } },
  },
  decorators: [seed(() => branch(A, { runs: [runningRun(A, 3)], worktree: worktreePath(A), head: HEAD }), { jobs: [job(A, 3)] })],
};

/** The section of the branch on the Work tab. */
const branchSection = async (canvas: ReturnType<typeof within>) => within(await canvas.findByRole("region", { name: "Branch" }));
/** The section of the runs on the Work tab. */
const runsSection = async (canvas: ReturnType<typeof within>) => within(await canvas.findByRole("region", { name: "Runs" }));

export const BranchCommits: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Work tab: the Branch section gives each commit from the base to the tip of the branch, as `git show` gives it: the full message with the `Assisted-by:` line, then the patch of the commit. The Full diff tab gives the change that the pull request button pushes.",
      },
    },
  },
  decorators: [seed(() => branch(A, { runs: [okRun(A, 25)], head: HEAD, worktree: worktreePath(A) }))],
  play: async ({ canvas, userEvent }) => {
    const section = await branchSection(canvas);
    const list = await section.findByRole("list", { name: "Commits of the branch" });
    await within(list).findByText(/Assisted-by: Claude Code \(Claude Opus 5\.5\) with patchix$/);
    await within(list).findByLabelText(/^Patch of commit /);
    await userEvent.click(section.getByRole("tab", { name: "Full diff" }));
    await section.findByLabelText("Diff of the branch");
    await expect(canvas.queryByRole("status", { name: "Changes without a commit" })).toBeNull();
  },
};

export const HandCommit: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Work tab, unverified: a person changed the commit of the newest run in the worktree. The Branch section gives the commit of the tip. No run has the checks of the tip: the next run starts them.",
      },
    },
  },
  decorators: [seed(() => branch(A, { runs: [okRun(A, 25)], head: AMENDED, worktree: worktreePath(A) }))],
  play: async ({ canvas, userEvent }) => {
    const section = await branchSection(canvas);
    await within(await section.findByRole("list", { name: "Commits of the branch" })).findByText(`commit ${AMENDED.slice(0, 12)}`);
    await userEvent.click(section.getByRole("tab", { name: /^Checks of the tip 0\/1/ }));
    await section.findByText(/^No run has the checks of the tip/);
    await section.findByText("no checks");
  },
};

export const DirtyWorktree: Story = {
  parameters: {
    docs: {
      description: {
        story: "Work tab: the worktree has changes without a commit. A notice tells that the branch does not have them: the Full diff tab gives the diff of the branch only.",
      },
    },
  },
  decorators: [seed(() => branch(A, { runs: [okRun(A, 25)], head: HEAD, worktree: worktreePath(A) }), { dirty: [A] })],
  play: async ({ canvas, userEvent }) => {
    const section = await branchSection(canvas);
    await section.findByRole("status", { name: "Changes without a commit" });
    await userEvent.click(section.getByRole("tab", { name: "Full diff" }));
    await section.findByLabelText("Diff of the branch");
  },
};

export const RunPrompt: Story = {
  parameters: { docs: { description: { story: "Work tab: the Prompt tab of a run gives `prompt.md`. The page reads it when the tab opens." } } },
  decorators: [seed(() => branch(A, { runs: [okRun(A, 25)], head: HEAD, worktree: worktreePath(A) }))],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("tab", { name: "Prompt" }));
  },
};

/** The campaign has the number of jobs of the `concurrency`: the run stays in the queue. */
const fullCampaign = seed(() => branch(A, { runs: [okRun(A, 25)], head: HEAD, worktree: worktreePath(A) }), {
  jobs: [job("calibre", 4), job("anki", 1)],
});

export const RunQueued: Story = {
  parameters: {
    docs: {
      description: {
        story: "Work tab: each job place of the campaign is in use. The person clicks Run without a question: the branch goes into the queue, and the run list starts with the queued run. The fleet starts a usual run when a job stops.",
      },
    },
  },
  decorators: [fullCampaign],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: "Run" }));
    const runs = await canvas.findByRole("region", { name: "Runs" });
    await within(runs).findByText("The run waits in the queue.");
    await within(runs).findByText("queued");
    await canvas.findByText("The branch is in the queue.");
    await expect(canvas.getByRole("button", { name: "Run" })).toBeDisabled();
  },
};

export const QuestionQueued: Story = {
  parameters: {
    docs: {
      description: {
        story: "Work tab: each job place of the campaign is in use. The person writes a question and clicks Run: the branch goes into the queue, and the run list starts with the queued run and its question. The fleet starts the run when a job stops.",
      },
    },
  },
  decorators: [fullCampaign],
  play: async ({ canvas, userEvent }) => {
    await userEvent.type(await canvas.findByPlaceholderText("A question for the agent (optional)"), QUESTION);
    await userEvent.click(canvas.getByRole("button", { name: "Run" }));
    const runs = await canvas.findByRole("region", { name: "Runs" });
    await within(runs).findByText(QUESTION);
    await within(runs).findByText("queued");
    await canvas.findByText("The branch is in the queue.");
  },
};

export const QuestionAnswered: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Work tab: a run with a question. The question is above the tabs, and the Reply tab gives the reply of the agent. The run did not move the tip of the branch: it has no checks, and the Branch section gives the checks of the earlier run of the tip.",
      },
    },
  },
  decorators: [seed(() => branch(A, { runs: [questionRun(A, 5), okRun(A, 25)], head: HEAD, worktree: worktreePath(A) }))],
  play: async ({ canvas, userEvent }) => {
    await canvas.findByLabelText(/^Question of run /);
    const runs = await runsSection(canvas);
    await userEvent.click(await runs.findByRole("tab", { name: "Reply" }));
    await runs.findByText(/The package reads the bundle one time, at import time/);
    await userEvent.click(runs.getByRole("tab", { name: /^Checks/ }));
    await runs.findByText(/^No checks: the run did not move the tip of the branch/);
    const section = await branchSection(canvas);
    await userEvent.click(section.getByRole("tab", { name: /^Checks of the tip 1\/1/ }));
    await section.findByRole("list", { name: "Checks of the tip" });
  },
};

export const Failed: Story = {
  parameters: { docs: { description: { story: "3. Work tab, failed: the command of the harness stopped with an error. The error and the check output show." } } },
  decorators: [seed(() => branch(A, { runs: [failedRun(A, 40), stoppedRun(A, 120)], head: HEAD }))],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await (await runsSection(canvas)).findByRole("tab", { name: /^Checks/ }));
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
  decorators: [seed(() => branch(A, { runs: [unverifiedRun(A, 30), failedRun(A, 120)], head: HEAD, worktree: worktreePath(A) }))],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await (await runsSection(canvas)).findByRole("tab", { name: /^Checks/ }));
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
    seed(() => branch(A, { runs: [unverifiedRun(A, 25)], head: HEAD, worktree: worktreePath(A), pr_meta: prMeta(A) }), {
      drafts: { [A]: description(A) },
    }),
  ],
  play: async ({ canvas, userEvent }) => {
    await canvas.findByText(/A check of the tip is unverified: the output of harness of python3Packages\.wassima did not agree/);
    await userEvent.click(await canvas.findByRole("checkbox", { name: CONFIRM }));
  },
};

export const Wontfix: Story = {
  parameters: {
    docs: { description: { story: "Work tab, wontfix: the agent made no commit and its description starts with `## No small fix`. A person must change the entry of the issue." } },
  },
  decorators: [seed(() => branch(A, { runs: [wontfixRun(A, 30), failedRun(A, 120)], worktree: worktreePath(A) }), { tasks: unlinked })],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("tab", { name: /Description/ }));
    await canvas.findByText(/A person must change the entry of the issue: for example/);
  },
};

export const ReadyNoDraft: Story = {
  parameters: {
    docs: {
      description: {
        story: '4. Publish tab, ready, no draft: "Make draft" takes the description of the newest run with a description, the title of the tip of the branch and the labels of the campaign.',
      },
    },
  },
  beforeEach: openTab("publish"),
  decorators: [seed(() => branch(A, { runs: [okRun(A, 25), failedRun(A, 90)], head: HEAD, worktree: worktreePath(A) }))],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: "Make draft" }));
    await canvas.findByRole("textbox", { name: "Title" });
  },
};

export const DraftAgain: Story = {
  parameters: {
    docs: {
      description: {
        story: "Publish tab: a newer run wrote a new description. The person makes the draft again: the dialog asks first, because the new draft replaces the title, the description and the extra words.",
      },
    },
  },
  beforeEach: openTab("publish"),
  decorators: [
    seed(() => branch(A, { runs: [okRun(A, 5), okRun(A, 25)], head: HEAD, worktree: worktreePath(A), pr_meta: prMeta(A, { title: "an old title" }) }), {
      drafts: { [A]: description(A) },
    }),
  ],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: "Make draft again" }));
    await userEvent.click(await screen.findByRole("button", { name: "Replace" }));
    await canvas.findByDisplayValue(`${A}: use the CA bundle of cacert`);
  },
};

export const TipWithoutChecks: Story = {
  parameters: {
    docs: {
      description: {
        story: "Publish tab: a person changed the commit in the worktree after the run. No run has the checks of the new tip: the person set the tick box, but the button stays disabled until a run gives the checks.",
      },
    },
  },
  beforeEach: openTab("publish"),
  decorators: [
    seed(() => branch(A, { runs: [okRun(A, 25)], head: AMENDED, worktree: worktreePath(A), pr_meta: prMeta(A) }), {
      drafts: { [A]: description(A) },
    }),
  ],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("checkbox", { name: CONFIRM }));
    const reasons = await canvas.findByRole("list", { name: "Reasons that the button is disabled" });
    await within(reasons).findByText("The tip of the branch has no checks for python3Packages.wassima.");
    await expect(await canvas.findByRole("button", { name: "Push and create pull request" })).toBeDisabled();
  },
};

export const ReadyDraft: Story = {
  parameters: { docs: { description: { story: "5. Publish tab, with a draft: two lint findings and a run with a question that operates. The findings do not stop the pull request: the run stops it, and the pull request button gives the reasons." } } },
  beforeEach: openTab("publish"),
  decorators: [
    seed(() => branch(A, { runs: [{ ...runningRun(A, 2), question: QUESTION }, okRun(A, 25), failedRun(A, 90)], head: HEAD, worktree: worktreePath(A), pr_meta: prMeta(A) }), {
      drafts: { [A]: roughDescription(A) },
      jobs: [job(A, 2)],
    }),
  ],
};

export const TrailerMissingWork: Story = {
  parameters: {
    docs: {
      description: {
        story: "Work tab: the commit of the branch names Claude in a `Co-Authored-By` line and has no `Assisted-by` line. The run is ok, and a notice above the runs gives the commit and its problems.",
      },
    },
  },
  decorators: [
    seed(() => branch(A, { runs: [okRun(A, 25)], head: HEAD, worktree: worktreePath(A) }), {
      commitProblems: { [A]: trailerProblems(A) },
    }),
  ],
  play: async ({ canvas }) => {
    const notice = await canvas.findByRole("status", { name: "Commit problems" });
    await within(notice).findByText(/no `Assisted-by: <tool> \(<model>\) with patchix` line, a `Co-authored-by` line names an AI: Co-Authored-By: Claude <noreply@anthropic\.com>$/);
  },
};

export const TrailerMissing: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Publish tab: the commit of the branch names Claude in a `Co-Authored-By` line and has no `Assisted-by: <tool> (<model>) with patchix` line. Thus it does not agree with the automation/AI policy of nixpkgs. The person set the tick box, but the button stays disabled. The reasons give the commit, its problems and the hint.",
      },
    },
  },
  beforeEach: openTab("publish"),
  decorators: [
    seed(() => branch(A, { runs: [okRun(A, 25)], head: HEAD, worktree: worktreePath(A), pr_meta: prMeta(A) }), {
      drafts: { [A]: description(A) },
      commitProblems: { [A]: trailerProblems(A) },
    }),
  ],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("checkbox", { name: CONFIRM }));
    const reasons = await canvas.findByRole("list", { name: "Reasons that the button is disabled" });
    await within(reasons).findByText(/^Commit 9e8d7c6b5a4f \(.*\): no `Assisted-by: <tool> \(<model>\) with patchix` line, a `Co-authored-by` line names an AI: Co-Authored-By: Claude <noreply@anthropic\.com>\.$/);
    await within(reasons).findByText("Amend the commit in the worktree, then reload.");
    const button = await canvas.findByRole("button", { name: "Push and create pull request" });
    await expect(button).toBeDisabled();
  },
};

/** The problem of the mark of `badMarkDescription`. */
const MARK_PROBLEM = "the mark `{{check:harness --whatever}}`: the check `harness` has no flag `--whatever`";

export const MarkProblem: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Publish tab: the check mark of the draft has the flag `--whatever`, but the check `harness` does not have this flag. An error above the preview gives the problem, and the preview shows the mark as text. The person set the tick box, but the button stays disabled. The reasons give the problem.",
      },
    },
  },
  beforeEach: openTab("publish"),
  decorators: [
    seed(() => branch(A, { runs: [okRun(A, 25)], head: HEAD, worktree: worktreePath(A), pr_meta: prMeta(A) }), {
      drafts: { [A]: badMarkDescription(A) },
    }),
  ],
  play: async ({ canvas, userEvent }) => {
    const notice = await canvas.findByRole("alert", { name: "Mark problems" });
    await within(notice).findByText(MARK_PROBLEM);
    await userEvent.click(await canvas.findByRole("checkbox", { name: CONFIRM }));
    const reasons = await canvas.findByRole("list", { name: "Reasons that the button is disabled" });
    await within(reasons).findByText(MARK_PROBLEM);
    await expect(await canvas.findByRole("button", { name: "Push and create pull request" })).toBeDisabled();
  },
};

export const ReadyToPublish: Story = {
  parameters: { docs: { description: { story: "6. Publish tab, ready: an ok run and no job. The person set the tick box: they established confidence in this output. Thus the button is enabled." } } },
  beforeEach: openTab("publish"),
  decorators: [
    seed(() => branch(A, { runs: [okRun(A, 25)], head: HEAD, worktree: worktreePath(A), pr_meta: prMeta(A) }), {
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
    seed(() => branch(A, { runs: [okRun(A, 25)], head: HEAD, worktree: worktreePath(A), pr_meta: prMeta(A) }), {
      drafts: { [A]: roughDescription(A) },
    }),
  ],
  play: async ({ canvas, userEvent }) => {
    await userEvent.type(await canvas.findByRole("textbox", { name: "Title" }), " again");
    await canvas.findByText("Lint runs when you save the draft.");
  },
};

export const PublishCreated: Story = {
  parameters: { docs: { description: { story: "Publish tab: the person set the tick box and clicked Push and create pull request. The Output under the button opens and gives each command and its output. The tick box is clear again, and the link of the pull request gives the time of the confirmation." } } },
  beforeEach: openTab("publish"),
  decorators: [
    seed(() => branch(A, { runs: [okRun(A, 25)], head: HEAD, worktree: worktreePath(A), pr_meta: prMeta(A) }), {
      drafts: { [A]: description(A) },
    }),
  ],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("checkbox", { name: CONFIRM }));
    await userEvent.click(await canvas.findByRole("button", { name: "Push and create pull request" }));
    await canvas.findByText(/^Confidence confirmed /, undefined, PR_REQUEST);
    await canvas.findByLabelText("Output of the publish");
  },
};

export const Publishing: Story = {
  parameters: {
    docs: {
      description: {
        story: "Publish tab: the request of Push and create pull request operates. The Output opens empty at the click. Each second, the page reads publish.log and shows the commands that started. At the end, the log of the response replaces it.",
      },
    },
  },
  beforeEach: openTab("publish"),
  decorators: [
    seed(() => branch(A, { runs: [okRun(A, 25)], head: HEAD, worktree: worktreePath(A), pr_meta: prMeta(A) }), {
      drafts: { [A]: description(A) },
      publishLogs: { [A]: failedPublishLog(A) },
    }),
  ],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("checkbox", { name: CONFIRM }));
    await userEvent.click(await canvas.findByRole("button", { name: "Push and create pull request" }));
    await canvas.findByText("Loading…");
    // The first read gives a part of the log, before the response.
    await canvas.findByText(/\$ git push fork/, undefined, PR_REQUEST);
    await canvas.findByRole("button", { name: "Push and create pull request", busy: true });
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
          tasks: [task(A, { branch: A })],
          branches: [branch(A, { runs: [okRun(A, 25)], head: HEAD, worktree: worktreePath(A), pr_meta: prMeta(A) })],
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
    await userEvent.click(await canvas.findByRole("button", { name: "Push and create pull request" }));
    await canvas.findByText(/\[exit code 1\]/, undefined, PR_REQUEST);
  },
};

/** The branch of the fork has a different commit: the fork rejects a push without the tick box `Force push`. */
const rejectedFork = seed(() => branch(A, { runs: [importedRun(A, 25)], head: HEAD, worktree: worktreePath(A), pr_meta: prMeta(A) }), {
  drafts: { [A]: description(A) },
  rejected: [A],
});

export const PushRejected: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Publish tab: the branch of the fork has a different commit, for example an imported branch that a person changed. The fork rejected the push, and no gh command started. The error and the Output give the output of git. For the next click, the person can set the tick box Force push.",
      },
    },
  },
  beforeEach: openTab("publish"),
  decorators: [rejectedFork],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("checkbox", { name: CONFIRM }));
    await userEvent.click(await canvas.findByRole("button", { name: "Push and create pull request" }));
    await canvas.findByText(/\[exit code 1\]/, undefined, PR_REQUEST);
    await expect(await canvas.findByRole("checkbox", { name: "Force push" })).not.toBeChecked();
  },
};

export const ForcePushed: Story = {
  parameters: {
    docs: {
      description: {
        story: "Publish tab: after the rejected push, the person set the tick box Force push and clicked again. `git push --force` replaced the branch on the fork, and the pull request was made. The tick box Force push is clear again.",
      },
    },
  },
  beforeEach: openTab("publish"),
  decorators: [rejectedFork],
  play: async ({ canvas, userEvent }) => {
    const button = () => canvas.findByRole("button", { name: "Push and create pull request" });
    await userEvent.click(await canvas.findByRole("checkbox", { name: CONFIRM }));
    await userEvent.click(await button());
    await canvas.findByText(/\[exit code 1\]/, undefined, PR_REQUEST);
    await userEvent.click(await canvas.findByRole("checkbox", { name: "Force push" }));
    await userEvent.click(await button());
    await canvas.findByText(/^Confidence confirmed /, undefined, PR_REQUEST);
    await canvas.findByText(/\$ git push --force fork/);
    await expect(await canvas.findByRole("checkbox", { name: "Force push" })).not.toBeChecked();
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
    seed(() => branch(A, { runs: [okRun(A, 25)], head: HEAD, worktree: worktreePath(A), pr_meta: prMeta(A, { labels: ["1.severity: security", "6.topic: python"] }) }), {
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
      campaigns: [{ campaign: CAMPAIGN, synced: at(30), tasks: [task(A, { branch: A })],
          branches: [branch(A, { runs: [okRun(A, 25)], head: HEAD, pr_meta: prMeta(A) })], drafts: { [A]: description(A) } }],
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
        branch(A, {
          runs: [okRun(A, 300)],
          head: HEAD,
          pr_meta: prMeta(A, {
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
  prMeta(A, {
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
    seed(() => branch(A, { runs: [okRun(A, 3000)], head: HEAD, pr_meta: made(3000, { state: "merged", merged: at(600) }) }), {
      drafts: { [A]: description(A) },
    }),
  ],
};

export const Closed: Story = {
  parameters: { docs: { description: { story: "9. Publish tab, closed: the pull request is closed without a merge. The button is disabled with the reason." } } },
  beforeEach: openTab("publish"),
  decorators: [
    seed(() => branch(A, { runs: [okRun(A, 3000)], head: HEAD, pr_meta: made(3000, { state: "closed" }) }), {
      drafts: { [A]: description(A) },
    }),
  ],
};

/** The branches of `rubyBranches`: `SHARED` with three entries, `CONFLICT` and `FREE_KEY`. */
const ruby = (p: Omit<Partial<MockCampaign>, "tasks" | "branches"> = {}) =>
  withMock(() => {
    const data = rubyBranches();
    return { campaigns: [{ campaign: CAMPAIGN, synced: at(30), tasks: [...data.tasks, task("rubyPackages.certified", { notes: "stale bundle" })], branches: data.branches, ...p }] };
  });

/** The entries of the branch in the header of the page. */
const entries = async (canvas: ReturnType<typeof within>) => within(await canvas.findByRole("list", { name: "Entries" }));

export const SharedBranch: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Work tab: one branch covers three entries. Each entry is a chip with a link to its row in the task table. The Checks of the tip tab has one row for each entry. The run also declared a fourth entry, but that entry links to its own branch: the notice gives the two branches.",
      },
    },
  },
  args: { branch: SHARED },
  decorators: [ruby()],
  play: async ({ canvas, userEvent }) => {
    const list = await entries(canvas);
    for (const attr of SHARED_ATTRS) await list.findByRole("link", { name: attr });
    const others = within(await canvas.findByRole("status", { name: "Other branches" }));
    await others.findByRole("link", { name: CONFLICT });
    const section = await branchSection(canvas);
    await userEvent.click(section.getByRole("tab", { name: /^Checks of the tip 3\/3/ }));
    const tip = within(await section.findByRole("list", { name: "Checks of the tip" }));
    for (const attr of SHARED_ATTRS) await tip.findByText(attr);
    const runs = await runsSection(canvas);
    await within(await runs.findByLabelText(/^Entries of run /)).findByText(CONFLICT);
  },
};

export const AddEntry: Story = {
  parameters: {
    docs: {
      description: {
        story: "Work tab: the person adds an entry to the shared branch. The entry has no checks of the tip: the branch is unverified until a run gives them.",
      },
    },
  },
  args: { branch: SHARED },
  decorators: [ruby()],
  play: async ({ canvas, userEvent }) => {
    await userEvent.type(await canvas.findByRole("combobox", { name: "Add entry" }), "certified");
    await userEvent.click(await screen.findByRole("option", { name: /^rubyPackages\.certified/ }));
    await (await entries(canvas)).findByRole("link", { name: "rubyPackages.certified" });
    const section = await branchSection(canvas);
    await userEvent.click(await section.findByRole("tab", { name: /^Checks of the tip 3\/4/ }));
    await section.findByText("no checks");
    await canvas.findByText("unverified", { selector: ".task-title .ui-badge" });
  },
};

export const RemoveEntry: Story = {
  parameters: { docs: { description: { story: "Work tab: the × of a chip removes the entry from the branch, after the dialog. The entry has no branch after this." } } },
  args: { branch: SHARED },
  decorators: [ruby()],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: "Remove rubyPackages.nap from the branch" }));
    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(async () => expect((await entries(canvas)).queryByRole("link", { name: "rubyPackages.nap" })).toBeNull());
    await (await entries(canvas)).findByRole("link", { name: "rubyPackages.httpclient" });
  },
};

export const Conflict: Story = {
  parameters: {
    docs: {
      description: {
        story: "Work tab: the entry links to its own branch, and a run of the shared branch also declared it. The run did not change the link: the notice gives the other branch.",
      },
    },
  },
  args: { branch: CONFLICT },
  decorators: [ruby()],
  play: async ({ canvas }) => {
    const others = within(await canvas.findByRole("status", { name: "Other branches" }));
    await others.findByRole("link", { name: SHARED });
  },
};

export const FreeText: Story = {
  parameters: {
    docs: {
      description: {
        story: "Work tab: a free-text run made the branch from the base. The text of the person is the work of the run. The branch covers no entry: the person adds the entries that the change fixes.",
      },
    },
  },
  args: { branch: FREE_KEY },
  decorators: [ruby()],
  play: async ({ canvas }) => {
    await canvas.findByText("The branch covers no entry.");
    await canvas.findByText(/^No issue entry: a free-text run made the branch/);
    await canvas.findByText(FREE_TEXT);
  },
};

export const Imported: Story = {
  parameters: {
    docs: {
      description: {
        story: "Work tab: a run with the tag `imported`. The import command got the commit of a person from a different checkout, and the branch of the commit covers the three entries of its commit message.",
      },
    },
  },
  args: { branch: SHARED },
  decorators: [
    withMock(() => ({
      campaigns: [
        {
          campaign: CAMPAIGN,
          synced: at(30),
          tasks: SHARED_ATTRS.map((a) => task(a, { branch: SHARED })),
          branches: [branch(SHARED, { runs: [importedRun(SHARED, 30, SHARED_ATTRS)], head: HEAD, pr_meta: prMeta(SHARED, { words: ["gem"] }) })],
          drafts: { [SHARED]: description(SHARED) },
        },
      ],
    })),
  ],
};

export const DoneElsewhere: Story = {
  parameters: { docs: { description: { story: "Work tab, external: the key of an entry with a pull request that patchix did not make. The branch has no runs and no draft." } } },
  args: { branch: "akkoma" },
  decorators: [withMock(() => ({ campaigns: [{ campaign: CAMPAIGN, synced: at(30), tasks: [task("akkoma", { checked: true, pr: 576652, remark: "(beamPackages)", notes: "", paths: ["/lib/castore-1.0.17/priv/cacerts.pem"] })] }] }))],
  play: async ({ canvas }) => {
    await canvas.findByText("external");
  },
};

export const Error: Story = {
  decorators: [withMock(() => ({ campaigns: [], fail: { branch: [404, `no branch ${A} in the campaign cacert`] } }))],
};
