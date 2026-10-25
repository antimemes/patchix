/**
 * The interface between the server and the web client.
 *
 * Each error is a JSON body `{ "error": string }` with a status of 400 or more (`ErrorSchema`). An error of
 * `POST .../branches/:key/pr` also has `publish_log` (`PublishErrorSchema`).
 *
 * The unit of work is a branch of the campaign, `<branch_prefix><key>`: `state/<campaign>/branches/<key>/` has its
 * runs, its draft and its pull request. An entry of the task list links to its branch (`Task.branch`).
 * The routes are:
 * - `GET /api/campaigns` gives `CampaignSummary[]`.
 * - `GET /api/campaigns/:c` gives `CampaignView`: the entries of the task list and the branches.
 * - `POST /api/campaigns/:c/sync` makes the state agree with GitHub and gives `SyncView`. It reads the tracking issue
 *   (and the `source` command) again. Then it reads the pull requests as `POST .../refresh` does. Then it reads the
 *   branches `<branch_prefix>*` of the fork with `git ls-remote`. It gets each branch that the repository of patchix
 *   does not have, with a depth of 2 commits. A branch of the fork without a directory gets a directory with one run
 *   with the tag `imported`. A branch with an open or merged pull request and without a draft gets a draft from the
 *   pull request. An entry without a branch gets a link to the branch of its attribute, when the fork has that
 *   branch. If not, it gets a link to the branch of the pull request number of its issue line, when a draft has that
 *   number. A branch of the fork without a pull request and without checks of the tip gets a check-only run in the
 *   queue (see `POST .../branches/:key/check`). Then the server starts the fleet. `SyncView.result` gives the numbers
 *   of each step. See `sync` in the fleet package.
 * - `POST /api/campaigns/:c/refresh` reads the pull requests of the fork on GitHub (one `gh pr list`) and gives
 *   `CampaignView`. It writes the `state`, `merged` and `url` of each draft with the number of a pull request of the list.
 *   A draft without a number gets the number of the pull request of its branch. See `refreshPrs`.
 * - `PUT /api/campaigns/:c/tasks/:attr/branch` with a `LinkInput` body writes the link of the entry and gives
 *   `CampaignView`. A key links the entry to that branch, also when the entry links to a different branch. `null`
 *   removes the link. The branch must be there: see `GET .../branches/:key`.
 * - `GET /api/campaigns/:c/tasks/:attr` gives the `BranchDetail` of the branch of the entry, or 404 when the entry
 *   has no branch.
 * - `GET /api/campaigns/:c/branches/:key` gives `BranchDetail`. When the branch has a draft, memelint examines
 *   `pr.md` for each request: see `BranchDetail.lint`. A branch is there when it has a directory or an entry links to
 *   it. Its key can also be an attribute of the task list, or the repository of patchix has it. If not, 404.
 * - `GET /api/campaigns/:c/branches/:key/runs/:run/log` gives the log of the run as text: the lines of the runner and
 *   the output of `claude`. `.../reply` gives the reply of the agent: `reply.md`, the `stdout` of `claude`.
 *   `.../prompt` gives the prompt of the agent (`prompt.md`), `.../description` the `description.md` of the agent,
 *   `.../attrs` the `attrs.txt` of the agent, `.../checks/:attr/:name` the output of one check for one attribute.
 * - `GET /api/campaigns/:c/branches/:key/commits` gives `Commit[]`: the commits of the branch from its base to its
 *   tip, the newest first. They come from `git log <base>..<tip>` in the repository of patchix. The base is the `base`
 *   of the newest run with a base, and the tip is `BranchView.head`. Each commit has its full message and its patch, as
 *   `git show` gives them. Without a base or a tip, the list is empty. `.../diff` gives `git diff <base> <tip>` as text:
 *   the change that `POST .../pr` pushes. It does not have the changes of the worktree without a commit: see
 *   `BranchDetail.clean`. See `branchGit` in the fleet package.
 * - `GET /api/campaigns/:c/labels` gives `Label[]`: the labels of the issue repository, from
 *   `gh label list --repo <repo> --limit 1000 --json name,color,description`. The server keeps the list for one hour.
 * - `GET /api/campaigns/:c/jobs` gives `JobsView`: the runs that operate at this time in the zellij session, the queue
 *   and the state of the fleet. `POST` with a `JobInput` body adds each branch to the queue, but not a branch with a
 *   job. Then it starts the fleet of the campaign when no fleet operates, and gives `JobsView` with status 202. The
 *   fleet starts the runs of the queue: see `runFleet`. `DELETE /api/campaigns/:c/jobs/:key` removes the branch from
 *   the queue, with its question (see `dequeue`). When the branch is not in the queue, it stops the job of the branch.
 *   It gives `JobsView`, or 404 when the branch has no entry and no job. `DELETE /api/campaigns/:c/queue` removes each
 *   entry of the queue and gives `JobsView`.
 * - `POST /api/campaigns/:c/branches/:key/run` with a `RunInput` body adds the branch to the queue for one run. With
 *   a question, it first writes the question into `question.md` of the branch directory: the next run of the branch
 *   gets it (see `RunSchema.question`). Without a question, it writes no `question.md` and removes a `question.md` that
 *   is there: the run is a usual run. A request without a body is a request without a question. Then it starts the
 *   fleet as `POST .../jobs` does, and gives `JobsView` with status 202. A branch with a job or with an entry in the
 *   queue gives 409: the person starts the run after the job. See `queueRun` in the fleet package.
 * - `POST /api/campaigns/:c/branches/:key/check` adds the branch to the queue for one check-only run, and starts the
 *   fleet. It gives `JobsView` with status 202. A check-only run does not start the agent. It starts the checks of the
 *   entries of the branch on its tip: see `startRun` in the fleet package. A branch with a job or with an entry in the
 *   queue gives 409.
 * - `POST /api/campaigns/:c/run` with a `FreeRunInput` body does the same for the key of the body. A key that is not
 *   there is a free-text run: the text is necessary, and the runner makes the branch from the base. The key of an entry
 *   or of a branch that is there gets a usual run, with the text as the question.
 * - `PUT /api/campaigns/:c/branches/:key/draft` with a `DraftInput` body writes `pr.yaml` and `pr.md` and gives
 *   `BranchDetail`, with the findings of memelint on the new `pr.md` in `lint`. `POST .../draft` without a body
 *   makes the draft from the newest run with a description and from the tip of the branch (see `makeDraft`). It
 *   replaces the draft and keeps the labels and the pull request number. A new draft gets the `labels` of the
 *   campaign. Without such a run, it gives 409.
 * - `POST /api/campaigns/:c/branches/:key/pr` with a `PublishInput` body pushes the branch, makes the pull request or
 *   writes its description again, sets the labels and gives `BranchDetail`. A different body or no body gives 409 with
 *   the error `CONFIRM_ERROR`. When the request has no error, `pr.yaml` gets the time of the request in `confirmed`.
 *   The branch must have commits after its base and one or more entries. Each entry must have checks of the tip without
 *   an `error` (see `tipChecks` and `tipProblem`). The worktree must be clean (see
 *   `BranchDetail.clean`) and the branch must have no job. If not, it gives 409. It also gives 409 for a pull request
 *   that is `merged` or `closed`, and for a commit of the branch with a problem (see `BranchDetail.commit_problems`).
 *   A draft with a mark problem gives 409 too: the error text gives each problem (see `BranchDetail.mark_problems`).
 *   memelint findings of the draft do not stop the request: the page shows them. After these conditions, each command
 *   (`git push`, `gh api` for the pull request and for the labels) and its `stdout` and `stderr` go into `publish.log`
 *   of the branch. Each request writes the file again. The `BranchDetail` has the file in `publish_log`.
 *   Each error of this route is a `PublishError`: its `publish_log` is the log of this request, or `null` when no
 *   command started. The push replaces the branch on the fork only when the fork has the commit of `Pr.pushed`.
 *   Without `Pr.pushed`, the push only adds commits to the branch on the fork. When the fork rejects the push, the
 *   request gives the error with the output of `git`. Then the person can set the tick box `Force push` of the page.
 *   With it, the next request has `force: true`. Then `git push --force` replaces the branch on the fork when the
 *   draft has no `pushed` commit. See `PublishInput.force`.
 * - `GET /api/campaigns/:c/branches/:key/publish-log` gives `publish.log` of the branch as text, or 404 when the file
 *   is not there. After the conditions of `POST .../pr`, the first line of the request replaces the file. Then the file
 *   gets each command when it starts, and its output when it stops. Thus the page reads this route each second while
 *   `POST .../pr` operates. Until the request examined the conditions, the file has the log of the previous request.
 * - `POST /api/campaigns/:c/branches/:key/worktree` makes the worktree of the branch for a person and gives
 *   `Worktree`. `DELETE` removes it and gives `BranchDetail`. A worktree with changes that are not committed is not
 *   removed.
 * - `POST /api/campaigns/:c/base` gets the newest commit of the base branch into the repository of patchix (one fetch
 *   with depth 1) and gives `CampaignView`. The worktrees that are there do not change.
 * - `POST /api/campaigns/:c/import` with an `ImportInput` body gets the branches `<branch_prefix>*` of a different
 *   checkout, with one fetch of depth 2 for each branch. It makes one run with the tag `imported` for each branch with
 *   entries of the task list, and links the entries without a branch. With `descriptions`, it also makes the drafts. It
 *   gives `CampaignView`. See `importBranches` in the fleet package.
 * - `GET /api/settings` gives `SettingsView`: `settings.yaml` of the data directory (see `SettingsSchema`), the fork
 *   that patchix uses, and the state of `GH_TOKEN`. `PUT /api/settings` with a `Settings` body writes `settings.yaml`
 *   and gives `SettingsView`. A value that is not in the body gets its default.
 * - `GET /api/events` is a stream of server-sent events. Each message is one `Event` as JSON, without an event name.
 */
import { z } from "zod";
import { BranchViewSchema, CampaignSchema, GIT_URL, KEY, Name, PrSchema, RUN_ID, RunSchema, SettingsSchema, TaskStateSchema, TaskViewSchema } from "./model.ts";

export const ErrorSchema = z.object({ error: z.string() });
export type ErrorBody = z.infer<typeof ErrorSchema>;

/** The error body of `POST .../branches/:key/pr`. */
export const PublishErrorSchema = ErrorSchema.extend({
  /** The commands of this request and their output, as in `publish.log`. `null` when no command started. */
  publish_log: z.string().nullable(),
});
export type PublishError = z.infer<typeof PublishErrorSchema>;

export const CampaignSummarySchema = z.object({
  name: z.string(),
  title: z.string(),
  issue: z.object({ repo: z.string(), number: z.number().int() }),
  synced: z.string().nullable(),
  /** The number of entries of the task list in each state. Each state is a key, also with the value 0. */
  counts: z.record(TaskStateSchema, z.number().int()),
  /** The number of jobs that operate at this time. */
  jobs: z.number().int(),
  /** The number of branches in the queue. */
  queued: z.number().int(),
});
export type CampaignSummary = z.infer<typeof CampaignSummarySchema>;

export const CampaignViewSchema = z.object({
  campaign: CampaignSchema,
  synced: z.string().nullable(),
  /** The entries of the task list, in the sequence of the list. */
  tasks: z.array(TaskViewSchema),
  /** The branches of the campaign, by key. A branch without entries is also in the list. */
  branches: z.array(BranchViewSchema),
});
export type CampaignView = z.infer<typeof CampaignViewSchema>;

export const LintFindingSchema = z.object({
  /** `pr.md`. */
  file: z.string(),
  line: z.number().int(),
  message: z.string(),
});
export const LintResultSchema = z.object({
  findings: z.array(LintFindingSchema),
});
export type LintResult = z.infer<typeof LintResultSchema>;

/** One commit of the branch with a problem: see `BranchDetail.commit_problems`. */
export const CommitProblemsSchema = z.object({
  /** The full commit id. */
  sha: z.string(),
  /** The first line of the commit message. */
  subject: z.string(),
  /** For example "no `Assisted-by: <tool> (<model>) with patchix` line" or "a `Co-authored-by` line names an AI: <line>". */
  problems: z.array(z.string()),
});
export type CommitProblems = z.infer<typeof CommitProblemsSchema>;

export const BranchDetailSchema = z.object({
  campaign: CampaignSchema,
  branch: BranchViewSchema,
  /**
   * The issue entries of the branch: each entry that links to the branch (`BranchView.covers`). Also the entry with the
   * attribute of the key when the task list has one: the runner gives that entry to the agent.
   */
  tasks: z.array(TaskViewSchema),
  /**
   * `question.md` of the branch directory: the question of a person for the next run of the branch. The run in the
   * queue gets it. `null` when the branch has no such question.
   */
  question: z.string().nullable(),
  /** `pr.md`, when the branch has a draft. */
  draft: z.string().nullable(),
  /** The description with each mark replaced, as it goes to GitHub. */
  rendered: z.string().nullable(),
  /**
   * The problems of the marks of `pr.md`, for example "the mark `{{foo}}` is not known". The rendered text keeps
   * a mark with a problem as it is. An empty list when the branch has no draft. With a problem in this list,
   * `POST .../pr` gives 409. See `render` in the fleet package.
   */
  mark_problems: z.array(z.string()),
  /**
   * The findings of memelint on `pr.md`, with the words of `campaigns/:c/memelint.toml` and the `words` of the draft.
   * `null` when the branch has no draft, or when memelint gave an error (the server log has it).
   */
  lint: LintResultSchema.nullable(),
  /** The curated words of `campaigns/:c/memelint.toml`, for the editor. */
  campaign_words: z.array(z.string()),
  /** `publish.log`: the commands of the newest `POST .../pr` and their output. `null` when the file is not there. */
  publish_log: z.string().nullable(),
  /**
   * The commits of the branch (see `GET .../commits`) that do not agree with the `automation/AI policy` of nixpkgs, the
   * newest first. Each commit must have a line that agrees with `^Assisted-by: .+ \(.+\) with patchix$`. A line that
   * agrees with `/^Co-authored-by:/i` must not name an AI, for example `/claude|copilot|gemini/i`. A line that names a
   * person has no problem. An empty list when each commit agrees, or when the branch has no base or no tip. With a
   * commit in this list, `POST .../pr` gives 409.
   */
  commit_problems: z.array(CommitProblemsSchema),
  /**
   * The worktree of the branch has no change without a commit and no new file (`git status --porcelain`), or the
   * branch has no worktree. The branch does not have such changes, and `POST .../pr` gives 409 for them.
   */
  clean: z.boolean(),
});
export type BranchDetail = z.infer<typeof BranchDetailSchema>;

export const JobInputSchema = z.object({
  keys: z.array(z.string().regex(KEY)).min(1),
});
export type JobInput = z.infer<typeof JobInputSchema>;

/** A run that operates. */
export const JobStatusSchema = z.object({
  /** The key of the branch. */
  key: z.string(),
  /** The id of the run. */
  id: z.string().regex(RUN_ID),
  started: z.string(),
});
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** The jobs, the queue and the fleet of a campaign. */
export const JobsViewSchema = z.object({
  /** The runs that operate at this time. */
  jobs: z.array(JobStatusSchema),
  /** The keys of `state/<campaign>/queue/`, the first entry first. The fleet starts their runs in this sequence. */
  queue: z.array(z.string()),
  /** The keys of `queue` that wait for a check-only run: see `POST .../branches/:key/check`. */
  check: z.array(z.string()),
  /** A fleet process of the campaign operates: see `FleetSchema`. */
  fleet: z.boolean(),
});
export type JobsView = z.infer<typeof JobsViewSchema>;

/** One commit of a branch, as `git show <sha>` gives it. */
export const CommitSchema = z.object({
  /** The full commit id. */
  sha: z.string(),
  /** The first line of the commit message (`%s`). */
  subject: z.string(),
  /** The full commit message (`%B`), with its last lines, for example `Assisted-by:`. */
  message: z.string(),
  /** The diff of this commit only, from its parent: `git show --format= <sha>`. */
  patch: z.string(),
});
export type Commit = z.infer<typeof CommitSchema>;

/** The longest text of a person for a run. */
const TEXT = z.string().trim().max(4000).default("");

/** The body of `POST .../branches/:key/run`. */
export const RunInputSchema = z.object({
  /** The question of a person for the run. An empty string, or only spaces: a run without a question. */
  question: TEXT,
});
/** The body that a client sends: without `question`, the server uses an empty string. */
export type RunInput = z.input<typeof RunInputSchema>;

/** The body of `POST /api/campaigns/:c/run`. */
export const FreeRunInputSchema = z.object({
  /** The key of the branch, for example an attribute of the task list or a new name. */
  key: z.string().regex(KEY),
  /** The text of the person. For a key that is not there, the text is necessary: it is the work of the run. */
  question: TEXT,
});
export type FreeRunInput = z.input<typeof FreeRunInputSchema>;

/** The body of `PUT /api/campaigns/:c/tasks/:attr/branch`. */
export const LinkInputSchema = z.object({
  /** The key of the branch of the entry, or `null`: the entry has no branch. */
  key: z.string().regex(KEY).nullable(),
});
export type LinkInput = z.infer<typeof LinkInputSchema>;

export const DraftInputSchema = z.object({
  title: z.string().trim().min(1),
  labels: z.array(z.string().trim().min(1)),
  description: z.string(),
  /** The memelint words of this description that are not in the campaign list. See `Pr.words`. */
  words: z.array(z.string().trim().min(1)),
});
export type DraftInput = z.infer<typeof DraftInputSchema>;

/**
 * The body of `POST .../branches/:key/pr`. The person sets the tick box of the page: with it, the person agrees with
 * the last part of the AI disclosure. See `Pr.confirmed`.
 */
export const PublishInputSchema = z.object({
  confirmed: z.literal(true),
  /**
   * The person set the tick box `Force push`, for example after the fork rejected a push. Then the push replaces the
   * branch on the fork. When `Pr.pushed` is set, the push replaces it only when the fork has that commit. See `push` in
   * the fleet package.
   */
  force: z.boolean().default(false),
});
/** The body that a client sends: without `force`, the server uses `false`. */
export type PublishInput = z.input<typeof PublishInputSchema>;

/** The error of `POST .../branches/:key/pr` without the body `{ "confirmed": true }`. */
export const CONFIRM_ERROR = "confirm that you established confidence in this output";

/** One label of a GitHub repository, as `gh label list` gives it. */
export const LabelSchema = z.object({
  name: z.string().min(1),
  /** The color as `RRGGBB`, without `#`. */
  color: z.string(),
  /** An empty string when the label has no description. */
  description: z.string(),
});
export type Label = z.infer<typeof LabelSchema>;

export const ImportInputSchema = z.object({
  /** The repository that has the branches, for example `file:///path/to/nixpkgs`. */
  url: z.string().regex(GIT_URL),
  /**
   * A directory of pull request descriptions, `<name>.md`, on the server. The `memelint.toml` file of its parent
   * directory gives the words of each description.
   */
  descriptions: z.string().min(1).optional(),
});
export type ImportInput = z.infer<typeof ImportInputSchema>;

/** The numbers of the steps of `POST /api/campaigns/:c/sync`. See `sync` in the fleet package. */
export const SyncResultSchema = z.object({
  /** The number of entries of the task list. */
  tasks: z.number().int(),
  /** The keys of the drafts that `refreshPrs` changed. */
  prs: z.array(z.string()),
  /** The branches `<branch_prefix>*` of the fork. */
  listed: z.number().int(),
  /** The branches of the fork that the sync got with depth 2. */
  fetched: z.number().int(),
  /** The branch directories that the sync made, each with one run with the tag `imported`. */
  made: z.number().int(),
  /** The drafts that the sync made from the pull requests of the fork. */
  drafts: z.number().int(),
  /** The entries without a branch that got a link to a branch. */
  links: z.number().int(),
  /** The check-only runs that the sync added to the queue. */
  queued: z.number().int(),
  /** For example a branch of the fork that the repository of patchix has with a different commit. */
  warnings: z.array(z.string()),
});
export type SyncResult = z.infer<typeof SyncResultSchema>;

/** The body of `POST /api/campaigns/:c/sync`: the campaign after the sync, and the numbers of the sync. */
export const SyncViewSchema = CampaignViewSchema.extend({ result: SyncResultSchema });
export type SyncView = z.infer<typeof SyncViewSchema>;

export const WorktreeSchema = z.object({ path: z.string(), branch: z.string() });
export type Worktree = z.infer<typeof WorktreeSchema>;

/** The body of `GET /api/settings` and `PUT /api/settings`. */
export const SettingsViewSchema = SettingsSchema.extend({
  /** The fork that patchix uses: `fork`, or the login of `gh api user`. `null` when `fork` is `null` and `gh` gave an error. */
  fork_effective: z.string().nullable(),
  /** `GH_TOKEN` is set in the environment of the server. The server does not give its value. */
  token: z.boolean(),
  /** The data directory of the server. It contains `settings.yaml` and `.env`. */
  data: z.string(),
});
export type SettingsView = z.infer<typeof SettingsViewSchema>;

export const EventSchema = z.discriminatedUnion("type", [
  /** The files of a campaign changed: read the campaign or the branch `key` again. `null`: a file of the campaign. */
  z.object({ type: z.literal("campaign"), campaign: z.string(), key: z.string().nullable() }),
  /** The jobs, the queue or the fleet changed. The event has the new `JobsView`. */
  JobsViewSchema.extend({ type: z.literal("jobs"), campaign: z.string() }),
]);
export type Event = z.infer<typeof EventSchema>;

export { Name, PrSchema, RunSchema };
