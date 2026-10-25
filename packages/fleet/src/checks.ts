/** The checks of a campaign. A check is a shell command. When its output agrees with the `pass` regular expression, the check gives `pass`. */
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Campaign, CheckResult } from "@patchix/common";
import { fill } from "./render.ts";
import { start } from "./proc.ts";
import { checkFile } from "./store.ts";

/** The values of the marks `{attr}`, `{base}` and `{after}`. */
export interface CheckValues {
  attr: string;
  base: string;
  after: string;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The `pass` expression with the marks replaced. The values are escaped: thus a `.` in an attribute agrees only with a `.`. */
export function passRegex(pass: string, values: CheckValues): RegExp {
  const escaped = { attr: escapeRegex(values.attr), base: escapeRegex(values.base), after: escapeRegex(values.after) };
  return new RegExp(fill(pass, { ...escaped }), "m");
}

export function checkCommand(command: string, values: CheckValues): string {
  return fill(command, { ...values });
}

export interface ChecksOptions {
  cwd: string;
  /** The run directory. The output of each check goes into `checks/<attr>.<name>.txt`: see `checkFile`. */
  dir: string;
  values: CheckValues;
  signal?: AbortSignal | undefined;
  log: (line: string) => void;
}

/** Starts the checks of the campaign for the attribute `values.attr` one after the other, with `sh -c` in the worktree. */
export async function runChecks(campaign: Campaign, opts: ChecksOptions): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of campaign.checks) {
    if (opts.signal?.aborted) break;
    const file = checkFile(opts.dir, opts.values.attr, check.name);
    await mkdir(dirname(file), { recursive: true });
    const out = createWriteStream(file);
    out.on("error", () => undefined);
    const command = checkCommand(check.command, opts.values);
    opts.log(`check ${check.name} of ${opts.values.attr}: ${command}`);
    const began = performance.now();
    let result;
    try {
      result = await start("sh", ["-c", command], { cwd: opts.cwd, out, timeoutMs: check.timeout_minutes * 60_000, signal: opts.signal });
    } finally {
      await new Promise<void>((r) => out.end(r));
    }
    const seconds = Math.round((performance.now() - began) / 100) / 10;
    const output = await readFile(file, "utf8");
    const status = result.timedOut || result.stopped || result.code !== 0 ? "error" : passRegex(check.pass, opts.values).test(output) ? "pass" : "fail";
    opts.log(`check ${check.name} of ${opts.values.attr}: ${status} (exit code ${result.code ?? result.signal}, ${seconds} s)`);
    results.push({ attr: opts.values.attr, name: check.name, status, code: result.code, seconds });
  }
  return results;
}
