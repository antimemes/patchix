/** Functions on the runs of a branch. This module has no zod: the web client imports it without the schemas. */

/** A check result: see `CheckResultSchema`. */
interface Result {
  attr: string;
  name: string;
  status: string;
}

/** The fields of a run that these functions read. See `RunSchema`. */
interface Checked {
  status: string;
  head: string | null;
  checks: readonly Result[];
}

/** The checks of the tip of a branch for one attribute: see `tipChecks`. */
export interface TipCheck<R extends Checked> {
  attr: string;
  /** The newest run with the checks of the tip for `attr`, or `undefined`. */
  run: R | undefined;
  /** The checks of `attr` in that run. Empty without such a run. */
  checks: R["checks"][number][];
}

/**
 * The checks of the tip of the branch for each attribute of `attrs`, in the same sequence. For one attribute, it is
 * the newest run with the head `tip` and with checks of the attribute. A run with a question can have no checks (see
 * `RunSchema.status`), and a `stopped` run can have a part of the checks only. Thus two attributes can get their
 * checks from two runs of the same tip. Without a tip, or when no run has the checks of the tip for an attribute, that
 * attribute has no checks.
 */
export function tipChecks<R extends Checked>(runs: readonly R[], tip: string | null, attrs: readonly string[]): TipCheck<R>[] {
  return attrs.map((attr) => {
    const run = tip === null ? undefined : runs.find((r) => r.head === tip && r.status !== "stopped" && r.checks.some((c) => c.attr === attr));
    return { attr, run, checks: run === undefined ? [] : run.checks.filter((c) => c.attr === attr) };
  });
}

/**
 * The problem of the checks of the tip for a pull request, or `null`. `tip` is the result of `tipChecks` for the
 * entries of the branch. A check that is `fail` is not a problem: a person examines its output and makes the decision.
 */
export function tipProblem(tip: readonly TipCheck<Checked>[]): string | null {
  if (tip.length === 0) return "the branch covers no entry of the task list";
  const missing = tip.filter((t) => t.checks.length === 0).map((t) => t.attr);
  if (missing.length > 0) return `the tip of the branch has no checks for ${missing.join(", ")}`;
  const errors = tip.flatMap((t) => t.checks.filter((c) => c.status === "error").map((c) => `${c.name} of ${t.attr}`));
  return errors.length === 0 ? null : `a check of the tip stopped with an error: ${errors.join(", ")}`;
}

/** The fields of a draft that these functions read. See `PrSchema`. */
interface Draft {
  number: number | null;
  state: "open" | "merged" | "closed";
}

/** The states of `BranchStateSchema`, without zod. */
export type BranchStateName = "pr" | "merged" | "closed" | "ready" | "unverified" | "running" | "failed" | "wontfix" | "todo";

/**
 * The state of a branch. See `TaskStateSchema`. The runs are the newest first, `tip` is the commit of the branch and
 * `covers` gives the entries of the branch. The pull request of the draft is first, then the newest run. When the
 * newest run is `ok` or `unverified`, the checks of the tip for each entry give the state: see `tipChecks`.
 */
export function branchState(covers: readonly string[], runs: readonly Checked[], pr: Draft | null, tip: string | null): BranchStateName {
  if (pr !== null && pr.number !== null) return pr.state === "open" ? "pr" : pr.state;
  const status = runs[0]?.status;
  if (status === undefined) return "todo";
  if (status === "running" || status === "wontfix") return status;
  if (status === "failed" || status === "stopped") return "failed";
  if (covers.length === 0) return "unverified";
  const checked = tipChecks(runs, tip, covers);
  if (checked.some((t) => t.checks.some((c) => c.status === "error"))) return "failed";
  return checked.every((t) => t.checks.length > 0 && t.checks.every((c) => c.status === "pass")) ? "ready" : "unverified";
}

/**
 * The state of an entry of the task list. `branch` is the branch of `Task.branch`, or `undefined` when the entry has
 * no branch. A pull request of the draft of the branch is first. Then an issue entry with a tick box or a pull request,
 * when the branch has no draft: `external`. Then the state of the branch, or `todo` without a branch.
 */
export function taskState(task: { checked: boolean; pr: number | null }, branch: { state: BranchStateName; pr_meta: Draft | null } | undefined): BranchStateName | "external" {
  if (branch?.pr_meta != null && branch.pr_meta.number !== null) return branch.state;
  if (branch?.pr_meta == null && (task.checked || task.pr !== null)) return "external";
  return branch === undefined ? "todo" : branch.state;
}
