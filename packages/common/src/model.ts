/**
 * The schemas of the files. See CLAUDE.md for the directory layout.
 *
 * A campaign is one tracking issue of nixpkgs. Its definition is in `campaigns/<name>/` and is in git.
 * Its state is in `state/<name>/` and is not in git.
 */
import { z } from "zod";

/** A name of 1 to 60 symbols: a check. */
export const Name = z.string().trim().min(1).max(60);

/** The name of a campaign: a directory name. */
export const CAMPAIGN_NAME = /^[a-z0-9][a-z0-9-]*$/;
/** An attribute path of nixpkgs, for example `python3Packages.wassima`. */
export const ATTR = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
/** The id of a run: its start time. */
export const RUN_ID = /^\d{8}-\d{6}$/;
/** The URL of a git repository that the `import` command reads: `https://` or `file://`. */
export const GIT_URL = /^(https|file):\/\/\S+$/;
/** A GitHub login, for example `someone`: 39 signs or less, and each sign is in `A-Z`, `a-z`, `0-9` or `-`. */
export const GITHUB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

/** The name of a flag of a check, for example `--force-build`. */
export const FLAG_NAME = /^--[a-z][a-z0-9-]*$/;
/** The value of a flag in a check mark, for example `julia-bin`. */
export const FLAG_VALUE = /^[A-Za-z0-9._-]+$/;

/** A flag of a check: see `Check.flags`. */
export const CheckFlagSchema = z.object({
  name: z.string().regex(FLAG_NAME),
  /** `true`: the flag has one value after it, and the value agrees with `FLAG_VALUE`. `false`: the flag has no value. */
  value: z.boolean().default(false),
});
export type CheckFlag = z.infer<typeof CheckFlagSchema>;

/** A check is a command that gives the signal: the fix is correct, or it is not. */
export const CheckSchema = z.object({
  name: Name,
  /**
   * The shell command. The runner starts it in the worktree with `sh -c`. These marks are replaced:
   * `{attr}`, `{base}` (the commit before the fix), `{after}` (the commit of the fix), `{root}` (the root of patchix).
   * With `{root}`, a check can start a script of its campaign, for example `sh '{root}/campaigns/brotli/check.sh'`.
   */
  command: z.string().min(1),
  /** A regular expression. The check is `pass` when the output agrees with it. */
  pass: z.string().min(1),
  /**
   * The command that a reviewer can start without a checkout. It goes into the pull request description.
   * `{attr}` and `{pr}` are replaced. `{pr}` is `<this PR>` until the pull request is made.
   */
  reviewer: z.string().min(1).optional(),
  /**
   * The flags that a person can add to the check mark of a description, for example
   * `{{check:harness --shim julia-bin}}`. They go to the end of the `reviewer` command. A check without flags accepts
   * no flag in its mark. See `render` in the fleet package.
   */
  flags: z.array(CheckFlagSchema).optional(),
  /** The time limit of one check. */
  timeout_minutes: z.number().int().positive().default(60),
});
export type Check = z.infer<typeof CheckSchema>;

/**
 * `campaigns/<name>/campaign.yaml`. The `fork`, the `model` and the `concurrency` are not in this file: they are values
 * of the person and the host, see `SettingsSchema`. A file of a previous version can have these keys: zod removes
 * them, and `readCampaign` writes one warning.
 */
export const CampaignSchema = z.object({
  name: z.string().regex(CAMPAIGN_NAME),
  title: z.string().min(1),
  /** The tracking issue. Its task list gives the tasks. */
  issue: z.object({
    /** `OWNER/REPO`, for example `NixOS/nixpkgs`. The pull requests go to this repository. */
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    number: z.number().int().positive(),
  }),
  /** The branch of the upstream repository that the pull requests go to. */
  base_branch: z.string().min(1).default("master"),
  /** The branch of one task is `<branch_prefix><attr>`, for example `cacert/python3Packages.wassima`. */
  branch_prefix: z.string().min(1),
  /** The labels of each new pull request. A person can change them before the pull request is made. */
  labels: z.array(z.string().min(1)).default([]),
  /** The checks, in sequence. Each must give `pass` before a run is `ok`. */
  checks: z.array(CheckSchema).default([]),
  /**
   * The command that gives the ground truth of the task list. The runner starts it with `sh -c` in the checkout.
   * Each output line is one attribute, then optional spaces and a text. The task list is the union of this output
   * and the issue entries. Without it, only the issue gives the task list.
   */
  source: z.string().min(1).optional(),
  /** The time limit of the agent. */
  timeout_minutes: z.number().int().positive().default(60),
});
export type Campaign = z.infer<typeof CampaignSchema>;

/**
 * `<data>/settings.yaml`, in the same directory as `.env`: the values of this person and this host. The file is not in
 * git. Only the server writes it, from the settings page. Without the file, each value is the default.
 */
export const SettingsSchema = z.object({
  /**
   * The GitHub user of the fork of the issue repository: the remote `fork`, the `head` of a new pull request and the
   * `--author` of `gh pr list`. `null`: the login of `gh api user`. See `forkOf` in the fleet package.
   */
  fork: z.string().regex(GITHUB_LOGIN).nullable().default(null),
  /** The `claude` model of the runs. */
  model: z.string().regex(/^\S+$/).default("claude-opus-5-5"),
  /** The maximum number of runs of one campaign that operate at the same time. */
  concurrency: z.number().int().positive().default(2),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** One entry of the task list of the tracking issue. `state/<campaign>/tasks.yaml` has the list. */
export const TaskSchema = z.object({
  attr: z.string().regex(ATTR),
  /** The files of the entry, for example `/share/foo/cacert.pem`. */
  paths: z.array(z.string()),
  /** The text of the entry after the files, for example `stale bundle, no ECC G3 · trusts AAA`. */
  notes: z.string(),
  /** The tick box of the entry is set: the task is done. */
  checked: z.boolean(),
  /** The pull request number of the entry, when the entry has one. */
  pr: z.number().int().positive().nullable(),
  /** The text of the entry after the pull request, for example `(beamPackages)` or `no change needed: ...`. */
  remark: z.string().nullable(),
  /** The issue has an entry for this attribute. */
  in_issue: z.boolean().default(true),
  /** The `source` command of the campaign gave this attribute. Always `false` when the campaign has no `source`. */
  in_source: z.boolean().default(false),
  /**
   * The branch of the task when it is not `<branch_prefix><attr>`. One branch can be the branch of more than one
   * task, for example `cacert/rubyPackages.algoliasearch-excon-httpclient-nap`. The sync keeps this value.
   */
  branch: z.string().min(1).nullable().default(null),
});
export type Task =z.infer<typeof TaskSchema>;

export const TasksFileSchema = z.object({
  /** When the issue was read. */
  synced: z.string(),
  tasks: z.array(TaskSchema),
});
export type TasksFile = z.infer<typeof TasksFileSchema>;

export const CheckResultSchema = z.object({
  name: Name,
  /** `pass`: the output agrees with `pass`. `fail`: it does not. `error`: the command did not stop with code 0, or in time. */
  status: z.enum(["pass", "fail", "error"]),
  code: z.number().int().nullable(),
  seconds: z.number(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

/**
 * `state/<campaign>/tasks/<attr>/runs/<id>/run.yaml`: one try of the agent on one task, or one commit that the
 * `import` command got from a different checkout. `reply.md` of the run directory is the `stdout` of `claude`. A file
 * that patchix wrote before this version can have a `kind` key: zod removes it.
 */
export const RunSchema = z.object({
  id: z.string().regex(RUN_ID),
  attr: z.string().regex(ATTR),
  /**
   * Marks of the run for the person, for example `imported`. The web page shows each mark. No code examines the
   * value of a mark: the code uses the other fields of the run.
   */
  tags: z.array(z.string()).default([]),
  /**
   * The question of a person, also in `question.md` of the run directory. The server writes the question into
   * `question.md` of the task directory, and the runner moves the file into the run directory. `null`: a run without
   * a question. See `startRun` in the fleet package.
   */
  question: z.string().nullable().default(null),
  started: z.string(),
  finished: z.string().nullable(),
  /**
   * `running`: the agent or the checks operate. `ok`: `claude` stopped with code 0 and the branch has commits after
   * the base. The worktree is clean, the run has a description and each check is `pass`. A run with a question can
   * have no description, and it can use the checks of a previous run: see `checks_of`. `unverified`: the agent
   * completed the work, but a person must examine it and make the decision. One or more checks are `fail` and no
   * check is `error`. Or the work has a problem: no commit, changes without a commit in the worktree, or no
   * description. `error` gives the problem, and the runner does not start the checks for it. `wontfix`: the agent
   * found no small fix for the task. `claude` stopped with code 0, the agent made no commit, the worktree is clean and
   * `description.md` starts with the heading `## No small fix`. `failed`: patchix or the run did not complete, see
   * `error`. The run did not start, `claude` stopped with an error or after the time limit, or a check command stopped
   * with an error. The work of the agent does not make a run `failed`. `stopped`: a person stopped the run. A
   * `running` record without a live runner is read as `stopped` with the error "the process stopped". The file does
   * not change.
   */
  status: z.enum(["running", "ok", "unverified", "wontfix", "failed", "stopped"]),
  model: z.string(),
  /**
   * The process id of the runner, while the run is `running`. The run operates when this process is there and its
   * command line contains `run <campaign> <attr>`. See `alive`.
   */
  pid: z.number().int().nullable(),
  /** The commit before the fix. */
  base: z.string(),
  /** The commit of the fix, when the agent made one. */
  head: z.string().nullable(),
  commits: z.number().int(),
  checks: z.array(CheckResultSchema),
  /**
   * A previous run of the task. Its checks apply to this run, and they give the status of this run. A run with a
   * question can keep the tip of the branch. Then this field names the newest previous run with the checks of that
   * tip, when there is one. The runner does not start the checks, and `checks` is empty. `null` for each other run.
   */
  checks_of: z.string().regex(RUN_ID).nullable().default(null),
  /** The number of memelint findings in `description.md`. */
  lint: z.number().int().nullable(),
  error: z.string().nullable(),
});
export type Run = z.infer<typeof RunSchema>;

/**
 * `state/<campaign>/fleet.yaml`: the fleet process of the campaign. The fleet writes this file when it starts, and
 * removes it when the queue is empty. The fleet operates when the process `pid` is there and its command line
 * contains `fleet <campaign>`.
 */
export const FleetSchema = z.object({
  pid: z.number().int(),
  started: z.string(),
});
export type Fleet = z.infer<typeof FleetSchema>;

/**
 * `state/<campaign>/tasks/<attr>/pr.yaml`: the pull request of a task, before and after it is made.
 * `pr.md` in the same directory is the description source. It is a copy of `description.md` of the run `run`, with the
 * changes of the persons. See `render.ts` for the marks that it can contain. A file that patchix wrote before this
 * version can have a `review` key: zod removes it.
 */
export const PrSchema = z.object({
  title: z.string().min(1),
  labels: z.array(z.string().min(1)),
  /** The run that gave the description and the commits. */
  run: z.string().regex(RUN_ID),
  /**
   * Technical names of this description that are not in the memelint words of the campaign. The agent gives
   * them in `words.txt` of the run. A person can move them into `campaigns/<name>/memelint.toml`.
   */
  words: z.array(z.string().min(1)).default([]),
  /** Set when the pull request is made. */
  number: z.number().int().positive().nullable(),
  url: z.string().nullable(),
  created: z.string().nullable(),
  /** The commit that the fork has. */
  pushed: z.string().nullable(),
  /** When the description on GitHub was last written from `pr.md`. */
  updated: z.string().nullable(),
  /**
   * The state of the pull request on GitHub when `refreshPrs` last read it with `gh pr list`. A pull request that is
   * `merged` or `closed` does not accept a new push from patchix.
   */
  state: z.enum(["open", "merged", "closed"]).default("open"),
  /** The time of the merge, when the state is `merged`. */
  merged: z.string().nullable().default(null),
  /**
   * The time of the newest `POST .../pr` without an error. Before it, the person set the tick box of the page. With
   * the tick box, the person agrees with the last part of the AI disclosure. See `disclosure` in the fleet package.
   */
  confirmed: z.string().nullable().default(null),
});
export type Pr = z.infer<typeof PrSchema>;

/** The state of a task, calculated from the files. */
export const TaskStateSchema = z.enum([
  /**
   * The tick box of the issue entry is set, or the entry has a pull request, and patchix has no draft for the task.
   * Thus a person did the task without patchix.
   */
  "external",
  /** The draft has the number of a pull request, and the pull request is open. */
  "pr",
  /** The draft has the number of a pull request, and the pull request is merged. */
  "merged",
  /** The draft has the number of a pull request, and the pull request is closed without a merge. */
  "closed",
  /** No pull request, and the newest run is `ok`: a person can examine it and make the pull request. */
  "ready",
  /**
   * No pull request, and the newest run is `unverified`: the agent completed the work. But a check did not agree with
   * its `pass` expression, or the work has a problem. A person examines the run and makes the decision. The person can
   * make the pull request.
   */
  "unverified",
  "running",
  /** The newest run is `failed` or `stopped`. */
  "failed",
  /** The newest run is `wontfix`: the agent found no small fix. A person must change the issue entry. */
  "wontfix",
  /** No run at this time. */
  "todo",
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const TaskViewSchema = TaskSchema.extend({
  state: TaskStateSchema,
  /** The branch of the task: `branch`, or `<branch_prefix><attr>`. */
  branch_name: z.string(),
  /** The commit of `branch_name` in the repository of patchix, when the repository has the branch. */
  head: z.string().nullable(),
  /** The runs, the newest first. */
  runs: z.array(RunSchema),
  pr_meta: PrSchema.nullable(),
  /** The path of the worktree of the task, when there is one. */
  worktree: z.string().nullable(),
});
export type TaskView = z.infer<typeof TaskViewSchema>;
