/** Functions on the runs of a task. This module has no zod: the web client imports it without the schemas. */

/** The fields of a run that these functions read. See `RunSchema`. */
interface Checked {
  status: string;
  head: string | null;
  checks: readonly { name: string; status: string }[];
}

/**
 * The newest run with the checks of the tip of the branch: its `head` is `tip`, and it has checks. A run with a
 * question can have no checks (see `RunSchema.status`), and a `stopped` run can have a part of the checks only.
 * `undefined` when `tip` is `null`, or when no run has the checks of the tip.
 */
export function tipRun<R extends Checked>(runs: readonly R[], tip: string | null): R | undefined {
  return tip === null ? undefined : runs.find((r) => r.head === tip && r.checks.length > 0 && r.status !== "stopped");
}

/**
 * The problem of the checks of the tip for a pull request, or `null`. `run` is the run of `tipRun`. A check that is
 * `fail` is not a problem: a person examines its output and makes the decision.
 */
export function tipProblem(run: Checked | undefined): string | null {
  if (run === undefined) return "the tip of the branch has no checks";
  const errors = run.checks.filter((c) => c.status === "error").map((c) => c.name);
  return errors.length === 0 ? null : `a check of the tip stopped with an error: ${errors.join(", ")}`;
}
