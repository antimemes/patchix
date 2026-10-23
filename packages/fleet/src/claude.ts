/** One `claude -p` operation in the worktree of a task. Its output goes into the log of the run or of the ask. */
import type { Writable } from "node:stream";
import { start, type StartResult } from "./proc.ts";

const MAX_PROMPT_BYTES = 120_000;
export const TOOLS = ["Bash", "Read", "Edit", "Write", "Grep", "Glob"] as const;

/** Gives `PATCHIX_CLAUDE_BIN` when it is set. If not, gives `claude`, which the `PATH` supplies. */
export function claudeBin(): string {
  const bin = process.env["PATCHIX_CLAUDE_BIN"];
  return bin !== undefined && bin !== "" ? bin : "claude";
}

/** The agent writes its files into the run directory: `--add-dir` lets it write there. `--continue` continues the newest session of `claude` in the worktree. */
export function claudeArgs(prompt: string, model: string, dir: string, cont = false): string[] {
  return ["-p", prompt, ...(cont ? ["--continue"] : []), "--output-format", "text", "--model", model, "--add-dir", dir, "--allowedTools", ...TOOLS];
}

export interface ClaudeOptions {
  cwd: string;
  prompt: string;
  model: string;
  /** The run or ask directory. */
  dir: string;
  out: Writable;
  stdout?: Writable;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  cont?: boolean;
}

/** Starts `claude -p` and waits until it stops. The child gets the run or ask directory in `PATCHIX_RUN_DIR`. */
export function runClaude(opts: ClaudeOptions): Promise<StartResult> {
  const bytes = Buffer.byteLength(opts.prompt);
  if (bytes > MAX_PROMPT_BYTES) return Promise.reject(new Error(`the prompt has ${bytes} bytes, more than ${MAX_PROMPT_BYTES}`));
  return start(claudeBin(), claudeArgs(opts.prompt, opts.model, opts.dir, opts.cont), {
    cwd: opts.cwd,
    out: opts.out,
    ...(opts.stdout === undefined ? {} : { stdout: opts.stdout }),
    timeoutMs: opts.timeoutMs,
    env: { PATCHIX_RUN_DIR: opts.dir },
    signal: opts.signal,
  });
}
