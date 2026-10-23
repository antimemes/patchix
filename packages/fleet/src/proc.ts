/** The child processes: a short command with its output as text, and a long command with its output in a log. */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import type { Writable } from "node:stream";

const KILL_DELAY_MS = 15_000;

export interface CaptureOptions {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  /** The exit codes that are not an error. The default is `[0]`. */
  codes?: readonly number[];
  /**
   * The lines of a log for a person. `capture` adds the line `$ <command>`, then the `stdout` and the `stderr` in the
   * sequence that they come. When the exit code is not in `codes`, it adds the line `[exit code N]`.
   */
  log?: string[] | undefined;
}

/** The error of a command that gives a different exit code, or that a signal stopped. It has all the output. */
export class CaptureError extends Error {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  constructor(message: string, code: number | null, stdout: string, stderr: string) {
    super(message);
    this.name = "CaptureError";
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/** The command as one shell line, for a log. An argument with a sign that a shell changes goes between two `'` signs. */
export function commandLine(cmd: string, args: readonly string[]): string {
  return [cmd, ...args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`)).join(" ");
}

/**
 * Starts the command and gives its `stdout`. A different exit code causes a `CaptureError`: its message has the
 * command, all the `stderr` and all the `stdout`.
 */
export function capture(cmd: string, args: readonly string[], opts: CaptureOptions = {}): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    /** The `stdout` and the `stderr` in the sequence that they come, for the log. */
    let all = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 10 * 60_000);
    opts.log?.push(`$ ${commandLine(cmd, args)}`);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      all += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
      all += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      opts.log?.push(`[cannot start ${cmd}: ${e.message}]`);
      fail(new Error(`cannot start ${cmd}: ${e.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (opts.log !== undefined && all.trim() !== "") opts.log.push(all.replace(/\n$/, ""));
      if (code !== null && (opts.codes ?? [0]).includes(code)) return done(out);
      opts.log?.push(`[${signal === null ? `exit code ${code}` : `stopped by ${signal}`}]`);
      const output = [err.trim(), out.trim()].filter((t) => t !== "").join("\n");
      fail(new CaptureError(`${cmd} ${args.slice(0, 3).join(" ")} failed (${signal ?? code}): ${output}`, code, out, err));
    });
    child.stdin.end(opts.input ?? "");
  });
}

/**
 * The environment of each child process: the commands of `capture` and of `start`. When `GH_TOKEN` is set,
 * `NIX_CONFIG` gets the line `access-tokens = github.com=<token>`: thus `nix` uses the token for the GitHub API and
 * does not get the rate limit. The line goes after the lines of `NIX_CONFIG` that are there. The token goes only into
 * the environment: do not put it into a command, a prompt or a log.
 *
 * When `TMPDIR` is set but is not a directory, the child does not get `TMPDIR`. The cause: `nix-shell --run` sets
 * `TMPDIR` to a temporary directory and removes that directory when it stops. A server that `nix-shell --run`
 * started keeps that value. Then `zellij` cannot write its log there and stops with an error.
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  const tmp = out["TMPDIR"];
  if (tmp !== undefined && statSync(tmp, { throwIfNoEntry: false })?.isDirectory() !== true) delete out["TMPDIR"];
  const token = out["GH_TOKEN"];
  if (token === undefined || token === "") return out;
  const line = `access-tokens = github.com=${token}`;
  const old = (out["NIX_CONFIG"] ?? "").replace(/\n$/, "");
  out["NIX_CONFIG"] = old === "" ? line : `${old}\n${line}`;
  return out;
}

export interface StartOptions {
  cwd: string;
  out: Writable;
  /** Also gets the `stdout`, without the `stderr`. */
  stdout?: Writable;
  timeoutMs: number;
  env?: Record<string, string>;
  signal?: AbortSignal | undefined;
}

export interface StartResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** The `signal` stopped the command. */
  stopped: boolean;
}

/**
 * Starts the command in a new process group and writes its `stdout` and `stderr` into `out`. After the time
 * limit or the `signal`, it sends `SIGTERM` to the group. After 15 more seconds, it sends `SIGKILL`. The environment
 * is `childEnv()` with `env`.
 */
export function start(cmd: string, args: readonly string[], opts: StartOptions): Promise<StartResult> {
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...childEnv(), ...opts.env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let timedOut = false;
    let stopped = false;
    let killer: NodeJS.Timeout | undefined;
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, sig);
      } catch {
        child.kill(sig);
      }
    };
    const halt = () => {
      kill("SIGTERM");
      killer ??= setTimeout(() => kill("SIGKILL"), KILL_DELAY_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      halt();
    }, opts.timeoutMs);
    const onAbort = () => {
      stopped = true;
      halt();
    };
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener("abort", onAbort);
    const end = () => {
      clearTimeout(timer);
      clearTimeout(killer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    child.stdout.on("data", (d: Buffer) => {
      opts.out.write(d);
      opts.stdout?.write(d);
    });
    child.stderr.on("data", (d: Buffer) => opts.out.write(d));
    child.on("error", (e) => {
      end();
      fail(new Error(`cannot start ${cmd}: ${e.message}`));
    });
    child.on("close", (code, signal) => {
      end();
      done({ code, signal, timedOut, stopped });
    });
  });
}

/** One line for the log: the cause that stopped the command. */
export function describe(r: StartResult): string {
  if (r.stopped) return "stopped by a person";
  if (r.timedOut) return "the time limit stopped it";
  if (r.signal !== null) return `stopped by ${r.signal}`;
  return `exit code ${r.code}`;
}
