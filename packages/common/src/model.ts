/**
 * The schemas of the files. See AGENTS.md for the directory layout.
 *
 * A campaign is one tracking issue of nixpkgs. Its definition is in `campaigns/<name>/` and is in git.
 * Its state is in `state/<name>/` and is not in git. The unit of work is a branch: `state/<name>/branches/<key>/` has
 * its runs and its draft. An entry of the task list links to its branch: see `Task.branch`.
 */
import { z } from "zod";

/** A name of 1 to 60 symbols: a check. */
export const Name = z.string().trim().min(1).max(60);

/** The name of a campaign: a directory name. */
export const CAMPAIGN_NAME = /^[a-z0-9][a-z0-9-]*$/;
/** An attribute path of nixpkgs, for example `python3Packages.wassima`. */
export const ATTR = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
/**
 * The key of a branch: the part of the branch name after the `branch_prefix` of the campaign. It has the signs of an
 * attribute. The key of a run on an entry is the attribute of the entry. A person gives the key of a free-text run.
 */
export const KEY = ATTR;
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
   * The shell command. The runner starts it in the worktree with `sh -c`, one time for each attribute that the run
   * declares. These marks are replaced: `{attr}` (the attribute), `{base}` (the commit before the fix), `{after}` (the
   * commit of the fix).
   */
  command: z.string().min(1),
  /** A regular expression. The check is `pass` when the output agrees with it. */
  pass: z.string().min(1),
  /**
   * The command that a reviewer can start without a checkout. It goes into the pull request description, one time for
   * each entry of the branch. `{attr}` and `{pr}` are replaced. `{pr}` is `<this PR>` until the pull request is made.
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
  /** The branch of the key `<key>` is `<branch_prefix><key>`, for example `cacert/python3Packages.wassima`. */
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
   * The key of the branch of this entry: the branch is `<branch_prefix><branch>`. `null`: the entry has no branch. One
   * branch can have more than one entry, for example `rubyPackages.algoliasearch-excon-httpclient-nap`. The runner sets
   * it when each check of the entry is `pass` (see `requestLink`). The sync sets it from the pull request number of the
   * entry, and a person sets it on the page. The sync keeps this value.
   */
  branch: z.string().regex(KEY).nullable().default(null),
});
export type Task = z.infer<typeof TaskSchema>;

export const TasksFileSchema = z.object({
  /** When the issue was read. */
  synced: z.string(),
  tasks: z.array(TaskSchema),
});
export type TasksFile = z.infer<typeof TasksFileSchema>;

export const CheckResultSchema = z.object({
  /** The attribute of the check: the value of `{attr}`. The output is in `checks/<attr>.<name>.txt` of the run directory. */
  attr: z.string().regex(ATTR),
  name: Name,
  /** `pass`: the output agrees with `pass`. `fail`: it does not. `error`: the command did not stop with code 0, or in time. */
  status: z.enum(["pass", "fail", "error"]),
  code: z.number().int().nullable(),
  seconds: z.number(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

/**
 * A `run.yaml` of a previous version has the key `attr` and no `key`: the run was a run on that entry, in
 * `tasks/<attr>/`. Then the key and the declared attributes come from `attr`, and each check without `attr` is a check
 * of that attribute.
 */
function previousRun(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const run = value as Record<string, unknown>;
  const attr = typeof run["attr"] === "string" ? run["attr"] : undefined;
  const key = run["key"] ?? attr;
  const checks = Array.isArray(run["checks"])
    ? run["checks"].map((c: unknown) => (typeof c === "object" && c !== null && !("attr" in c) ? { ...c, attr: attr ?? key } : c))
    : run["checks"];
  return { ...run, key, attrs: run["attrs"] ?? (attr === undefined ? [] : [attr]), checks };
}

/**
 * `state/<campaign>/branches/<key>/runs/<id>/run.yaml`: one try of the agent on one branch, or one commit that the
 * `import` command got from a different checkout. `reply.md` of the run directory is the `stdout` of `claude`. The
 * pull request reads the branch, not a run. A file that patchix wrote before this version can have a `kind` key or a
 * `checks_of` key: zod removes them. patchix also reads a file with `attr` and without `key`: see `previousRun`.
 */
export const RunSchema = z.preprocess(
  previousRun,
  z.object({
    id: z.string().regex(RUN_ID),
    /** The key of the branch. The directory of the run gives it: see `listRuns`. */
    key: z.string().regex(KEY),
    /**
     * The attributes of the task list that this change fixes, as the agent gave them in `attrs.txt` of the run
     * directory. Without the file, the key when it is an attribute of the task list. The runner starts the checks for
     * each attribute of the task list in this list. An attribute that is not in the task list stays in the list, but it
     * gets no check.
     */
    attrs: z.array(z.string().regex(ATTR)).default([]),
    /**
     * Marks of the run for the person, for example `imported`. The web page shows each mark. No code examines the
     * value of a mark: the code uses the other fields of the run.
     */
    tags: z.array(z.string()).default([]),
    /**
     * The text of a person, also in `question.md` of the run directory: a question about the branch, or the work of a
     * free-text run. The server writes the text into `question.md` of the branch directory, and the runner moves the
     * file into the run directory. `null`: a run without a text. See `startRun` in the fleet package.
     */
    question: z.string().nullable().default(null),
    started: z.string(),
    finished: z.string().nullable(),
    /**
     * `running`: the agent or the checks operate. `ok`: `claude` stopped with code 0 and the branch has commits after
     * the base. The worktree is clean, the run has a description and each check is `pass`. A run with a question can
     * have no description. It can also keep the tip of the branch when a previous run has the checks of the tip for an
     * attribute (see `tipChecks`). Then the runner does not start the checks of that attribute again. `unverified`: the
     * agent completed the work, but a person must examine it and make the decision. One or more checks are `fail` and
     * no check is `error`. Or the work has a problem: no commit, changes without a commit in the worktree, or no
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
     * command line contains `run <campaign> <key>`. See `alive`.
     */
    pid: z.number().int().nullable(),
    /** The commit before the fix. */
    base: z.string(),
    /** The commit of the fix, when the agent made one. */
    head: z.string().nullable(),
    commits: z.number().int(),
    /** The checks of this run: each check of the campaign for each declared attribute of the task list. */
    checks: z.array(CheckResultSchema),
    /** The number of memelint findings in `description.md`. */
    lint: z.number().int().nullable(),
    error: z.string().nullable(),
  }),
);
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
 * `state/<campaign>/branches/<key>/pr.yaml`: the text of the persons for the pull request of a branch, before and
 * after it is made. `pr.md` in the same directory is the description source: a copy of `description.md` of a run, with
 * the changes of the persons (see `makeDraft`). See `render.ts` for the marks that it can contain. The commits, the
 * checks and the models come from the branch. A file that patchix wrote before this version can have a `review` key or
 * a `run` key: zod removes them.
 */
export const PrSchema = z.object({
  title: z.string().min(1),
  labels: z.array(z.string().min(1)),
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

/**
 * The state of an entry of the task list, calculated from the files. Without `external`, it is also the state of a
 * branch: see `BranchStateSchema`.
 */
export const TaskStateSchema = z.enum([
  /**
   * The tick box of the issue entry is set, or the entry has a pull request, and the branch of the entry has no
   * draft. Thus a person did the task without patchix.
   */
  "external",
  /** The draft of the branch has the number of a pull request, and the pull request is open. */
  "pr",
  /** The draft of the branch has the number of a pull request, and the pull request is merged. */
  "merged",
  /** The draft of the branch has the number of a pull request, and the pull request is closed without a merge. */
  "closed",
  /**
   * No pull request, the newest run is `ok` or `unverified`, each entry of the branch has checks of the tip, and each
   * check is `pass` (see `tipChecks`). A person can examine the branch and make the pull request.
   */
  "ready",
  /**
   * No pull request, and the newest run is `ok` or `unverified`. But a check of the tip did not agree with its `pass`
   * expression, or an entry of the branch has no checks of the tip. Or the branch has no entry. A person examines
   * the branch and makes the decision. With the checks of the tip for each entry, the person can make the pull request.
   */
  "unverified",
  "running",
  /** The newest run is `failed` or `stopped`, or a check of the tip stopped with an error. */
  "failed",
  /** The newest run is `wontfix`: the agent found no small fix. A person must change the issue entry. */
  "wontfix",
  /** No run at this time. For an entry: the entry has no branch. */
  "todo",
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

/** The state of a branch: see `branchState`. */
export const BranchStateSchema = TaskStateSchema.exclude(["external"]);
export type BranchState = z.infer<typeof BranchStateSchema>;

/** An entry of the task list and its state: the state of its branch, see `taskState`. */
export const TaskViewSchema = TaskSchema.extend({
  state: TaskStateSchema,
});
export type TaskView = z.infer<typeof TaskViewSchema>;

/** A branch of the campaign: a directory `branches/<key>/`, or the key of an entry link. */
export const BranchViewSchema = z.object({
  key: z.string().regex(KEY),
  /** `<branch_prefix><key>`. */
  name: z.string(),
  state: BranchStateSchema,
  /** The tip of the branch: the commit of `name` in the repository of patchix, when the repository has it. */
  head: z.string().nullable(),
  /** The runs, the newest first. */
  runs: z.array(RunSchema),
  pr_meta: PrSchema.nullable(),
  /** The path of the worktree of the branch, when there is one. */
  worktree: z.string().nullable(),
  /** The attributes of the entries that link to this branch (`Task.branch`), in the sequence of the task list. */
  covers: z.array(z.string()),
});
export type BranchView = z.infer<typeof BranchViewSchema>;
