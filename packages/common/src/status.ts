/** Functions on the status of a run. This module has no zod: the web client imports it without the schemas. */

/** A run that can give a pull request: `ok`, or `unverified` when a person examined it. See `RunSchema`. */
export function publishable(run: { status: string } | undefined): boolean {
  return run?.status === "ok" || run?.status === "unverified";
}
