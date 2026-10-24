/**
 * The interface between the server and the web client.
 *
 * Each error is a JSON body `{ "error": string }` with a status of 400 or more (`ErrorSchema`). An error of
 * `POST .../tasks/:attr/pr` also has `publish_log` (`PublishErrorSchema`).
 *
 * The routes are:
 * - `GET /api/campaigns` gives `CampaignSummary[]`.
 * - `GET /api/campaigns/:c` gives `CampaignView`.
 * - `POST /api/campaigns/:c/sync` reads the tracking issue (and the `source` command) again, then the pull requests
 *   as `POST .../refresh` does, and gives `CampaignView`.
 * - `POST /api/campaigns/:c/refresh` reads the pull requests of the fork on GitHub (one `gh pr list`) and gives
 *   `CampaignView`. It writes the `state`, `merged` and `url` of each draft with the number of a pull request of the list.
 *   A draft without a number gets the number of the pull request of the branch of its task. See `refreshPrs`.
 * - `GET /api/campaigns/:c/tasks/:attr` gives `TaskDetail`. When the task has a draft, memelint examines `pr.md`
 *   for each request: see `TaskDetail.lint`.
 * - `GET /api/campaigns/:c/tasks/:attr/runs/:run/log` gives the log of the run as text: the lines of the runner and
 *   the output of `claude`. `.../prompt` gives the prompt of the agent (`prompt.md`), `.../diff` the diff of the run,
 *   `.../description` the `description.md` of the agent, `.../checks/:name` the output of one check.
 * - `GET /api/campaigns/:c/tasks/:attr/runs/:run/commits` gives `Commit[]`: the commits from the `base` to the `head`
 *   of the run, the newest first, from `git log <base>..<head>` in the repository of patchix. Each commit has its full
 *   message (`git log -1 --format=%B <sha>`) and its patch (`git show --format= <sha>`), as `git show` gives them.
 *   A run without a `head` gives `[]`. When the repository does not have the `base` or the `head`, it gives 404.
 * - `GET /api/campaigns/:c/labels` gives `Label[]`: the labels of the issue repository, from
 *   `gh label list --repo <repo> --limit 1000 --json name,color,description`. The server keeps the list for one hour.
 * - `GET /api/campaigns/:c/jobs` gives `JobsView`: the runs and asks that operate at this time in the zellij session,
 *   the queue and the state of the fleet. `POST` with a `JobInput` body adds each task to the queue, but not a task
 *   with a job. Then it starts the fleet of the campaign when no fleet operates, and gives `JobsView` with status 202.
 *   The fleet starts the runs of the queue: see `runFleet`. `DELETE /api/campaigns/:c/jobs/:attr` removes the task
 *   from the queue. When the task is not in the queue, it stops the job of the task. It gives `JobsView`, or 404 when
 *   the task has no entry and no job. `DELETE /api/campaigns/:c/queue` removes each entry of the queue and gives
 *   `JobsView`.
 * - `POST /api/campaigns/:c/tasks/:attr/ask` with an `AskInput` body writes the question and starts `claude` in the
 *   worktree of the task, and gives `Ask`. The server does not write `ask.yaml`: see `AskSchema`. An ask is a job.
 *   It gives 409 when the task has a job, or when the campaign has the `concurrency` of the settings as its number of
 *   jobs. The worktree is made when there is none. `GET .../asks/:id/reply` gives the reply as text,
 *   `.../asks/:id/prompt` the prompt (`prompt.md`), `.../asks/:id/log` the log, `.../asks/:id/diff` the diff.
 * - `PUT /api/campaigns/:c/tasks/:attr/draft` with a `DraftInput` body writes `pr.yaml` and `pr.md` and gives
 *   `TaskDetail`, with the findings of memelint on the new `pr.md` in `lint`. `POST .../draft` with a `DraftFromRun`
 *   body makes the draft from a run; it replaces the draft and keeps the pull request number. A new draft gets the
 *   `labels` of the campaign.
 * - `POST /api/campaigns/:c/tasks/:attr/pr` with a `PublishInput` body pushes the branch, makes the pull request or
 *   writes its description again, sets the labels and gives `TaskDetail`. A different body or no body gives 409 with
 *   the error `CONFIRM_ERROR`. When the request has no error, `pr.yaml` gets the time of the request in `confirmed`. The draft must have
 *   no lint findings, the newest run must be `ok` and the task must have no job: if not, it gives 409. It also gives 409 for a pull request that is `merged` or
 *   `closed`, and for a commit of the branch with a problem (see `TaskDetail.commit_problems`). When the pull request is made, the worktree is removed. After these conditions, each command (`git push`,
 *   `git worktree remove`, `gh api` for the pull request and for the labels) and its `stdout` and `stderr` go into
 *   `publish.log` of the task. Each request writes the file again. The `TaskDetail` has the file in `publish_log`.
 *   Each error of this route is a `PublishError`: its `publish_log` is the log of this request, or `null` when no
 *   command started.
 * - `GET /api/campaigns/:c/tasks/:attr/publish-log` gives `publish.log` of the task as text, or 404 when the file is
 *   not there. After the conditions of `POST .../pr`, the first line of the request replaces the file. Then the file
 *   gets each command when it starts, and its output when it stops. Thus the page reads this route each second while
 *   `POST .../pr` operates. Until the request examined the conditions, the file has the log of the previous request.
 * - `POST /api/campaigns/:c/tasks/:attr/worktree` makes the worktree of the task for a person and gives `Worktree`.
 *   `DELETE` removes it and gives `TaskDetail`. A worktree with changes that are not committed is not removed.
 * - `POST /api/campaigns/:c/base` gets the newest commit of the base branch into the repository of patchix (one fetch
 *   with depth 1) and gives `CampaignView`. The worktrees that are there do not change.
 * - `POST /api/campaigns/:c/import` with an `ImportInput` body gets the branches `<branch_prefix>*` of a different
 *   checkout, with one fetch of depth 2 for each branch. It makes one run with the tag `imported` for each task of a
 *   branch. With `descriptions`, it also makes the drafts. It gives `CampaignView`. See `importBranches` in the fleet
 *   package.
 * - `GET /api/settings` gives `SettingsView`: `settings.yaml` of the data directory (see `SettingsSchema`), the fork
 *   that patchix uses, and the state of `GH_TOKEN`. `PUT /api/settings` with a `Settings` body writes `settings.yaml`
 *   and gives `SettingsView`. A value that is not in the body gets its default.
 * - `GET /api/events` is a stream of server-sent events. Each message is one `Event` as JSON, without an event name.
 */
import { z } from "zod";
import { AskSchema, ATTR, CampaignSchema, GIT_URL, Name, PrSchema, RUN_ID, RunSchema, SettingsSchema, TaskStateSchema, TaskViewSchema } from "./model.ts";

export const ErrorSchema = z.object({ error: z.string() });
export type ErrorBody = z.infer<typeof ErrorSchema>;

/** The error body of `POST .../tasks/:attr/pr`. */
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
  /** The number of tasks in each state. Each state is a key, also with the value 0. */
  counts: z.record(TaskStateSchema, z.number().int()),
  /** The number of jobs that operate at this time. */
  jobs: z.number().int(),
  /** The number of tasks in the queue. */
  queued: z.number().int(),
});
export type CampaignSummary = z.infer<typeof CampaignSummarySchema>;

export const CampaignViewSchema = z.object({
  campaign: CampaignSchema,
  synced: z.string().nullable(),
  tasks: z.array(TaskViewSchema),
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

/** One commit of the branch with a problem: see `TaskDetail.commit_problems`. */
export const CommitProblemsSchema = z.object({
  /** The full commit id. */
  sha: z.string(),
  /** The first line of the commit message. */
  subject: z.string(),
  /** For example "no `Assisted-by: <tool> (<model>) with patchix` line" or "a `Co-authored-by` line names an AI: <line>". */
  problems: z.array(z.string()),
});
export type CommitProblems = z.infer<typeof CommitProblemsSchema>;

export const TaskDetailSchema = z.object({
  campaign: CampaignSchema,
  task: TaskViewSchema,
  /** The asks, the newest first. */
  asks: z.array(AskSchema),
  /** `pr.md`, when the task has a draft. */
  draft: z.string().nullable(),
  /** The description with each mark replaced, as it goes to GitHub. */
  rendered: z.string().nullable(),
  /**
   * The findings of memelint on `pr.md`, with the words of `campaigns/:c/memelint.toml` and the `words` of the draft.
   * `null` when the task has no draft, or when memelint gave an error (the server log has it).
   */
  lint: LintResultSchema.nullable(),
  /** The curated words of `campaigns/:c/memelint.toml`, for the editor. */
  campaign_words: z.array(z.string()),
  /** `publish.log`: the commands of the newest `POST .../pr` and their output. `null` when the file is not there. */
  publish_log: z.string().nullable(),
  /**
   * The commits from the `base` of the newest run to the tip of the branch that do not agree with the
   * `automation/AI policy` of nixpkgs, the newest first. Each commit must have a line that agrees with
   * `^Assisted-by: .+ \(.+\) with patchix$`. A line that agrees with `/^Co-authored-by:/i` must not name an AI,
   * for example `/claude|copilot|gemini/i`. A line that names a person has no problem. An empty list when each
   * commit agrees, or when the task has no run or no branch. With a commit in this list, `POST .../pr` gives 409.
   */
  commit_problems: z.array(CommitProblemsSchema),
});
export type TaskDetail = z.infer<typeof TaskDetailSchema>;

export const JobInputSchema = z.object({
  attrs: z.array(z.string().regex(ATTR)).min(1),
});
export type JobInput = z.infer<typeof JobInputSchema>;

export const JobStatusSchema = z.object({
  attr: z.string(),
  kind: z.enum(["run", "ask"]),
  /** The id of the run or the ask. */
  id: z.string().regex(RUN_ID),
  started: z.string(),
});
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** The jobs, the queue and the fleet of a campaign. */
export const JobsViewSchema = z.object({
  /** The runs and asks that operate at this time. */
  jobs: z.array(JobStatusSchema),
  /** The attributes of `state/<campaign>/queue/`, the first entry first. The fleet starts their runs in this sequence. */
  queue: z.array(z.string()),
  /** A fleet process of the campaign operates: see `FleetSchema`. */
  fleet: z.boolean(),
});
export type JobsView = z.infer<typeof JobsViewSchema>;

/** One commit of a run, as `git show <sha>` gives it. */
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

export const AskInputSchema = z.object({
  question: z.string().trim().min(1).max(4000),
});
export type AskInput = z.infer<typeof AskInputSchema>;

export const DraftInputSchema = z.object({
  title: z.string().trim().min(1),
  labels: z.array(z.string().trim().min(1)),
  description: z.string(),
  /** The memelint words of this description that are not in the campaign list. See `Pr.words`. */
  words: z.array(z.string().trim().min(1)),
});
export type DraftInput = z.infer<typeof DraftInputSchema>;

export const DraftFromRunSchema = z.object({ run: z.string().regex(RUN_ID) });
export type DraftFromRun = z.infer<typeof DraftFromRunSchema>;

/**
 * The body of `POST .../tasks/:attr/pr`. The person sets the tick box of the page: with it, the person agrees with the
 * last part of the AI disclosure. See `Pr.confirmed`.
 */
export const PublishInputSchema = z.object({ confirmed: z.literal(true) });
export type PublishInput = z.infer<typeof PublishInputSchema>;

/** The error of `POST .../tasks/:attr/pr` without the body `{ "confirmed": true }`. */
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

export const WorktreeSchema =z.object({ path: z.string(), branch: z.string() });
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
  /** The files of a campaign changed: read the campaign or the task again. */
  z.object({ type: z.literal("campaign"), campaign: z.string(), attr: z.string().nullable() }),
  /** The jobs, the queue or the fleet changed. The event has the new `JobsView`. */
  JobsViewSchema.extend({ type: z.literal("jobs"), campaign: z.string() }),
]);
export type Event = z.infer<typeof EventSchema>;

export { Name, PrSchema, RunSchema };
