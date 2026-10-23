/**
 * The server does not start the runs, the asks and the fleets as its processes: they operate in the zellij session
 * `patchix`. Thus they continue when the server stops. A person can look at them with `zellij attach patchix`.
 */
import { capture } from "./proc.ts";
import type { Ctx } from "./store.ts";

export const SESSION = "patchix";

/** A KDL string. This function does not accept a control sign: the KDL escapes of these signs are different from the JSON escapes. */
export function kdlString(s: string): string {
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new Error(`a control sign in ${JSON.stringify(s)}`);
  return `"${s.replace(/[\\"]/g, "\\$&")}"`;
}

/**
 * The layout of a tab that starts `node packages/fleet/src/cli.ts --root <root> --data <data> --path <PATH> <args>`
 * in the root. `node` is the path of this Node process. The tab does not use the environment of the session for these
 * values: the session can start before this process. zellij reads one node for each line: it does not accept `;`.
 * With `close_on_exit false`, the tab stays after the command stops: a person can read the output.
 */
export function cliLayout(ctx: Pick<Ctx, "root" | "data">, args: readonly string[], closeOnExit = false): string {
  const all = ["packages/fleet/src/cli.ts", "--root", ctx.root, "--data", ctx.data, "--path", process.env["PATH"] ?? "", ...args].map(kdlString).join(" ");
  return `layout {\n  pane command=${kdlString(process.execPath)} {\n    args ${all}\n    cwd ${kdlString(ctx.root)}\n    close_on_exit ${closeOnExit}\n  }\n}\n`;
}

/** Gives `PATCHIX_ZELLIJ_BIN` when it is set. If not, gives `zellij`. */
function zellij(): string {
  return process.env["PATCHIX_ZELLIJ_BIN"] || "zellij";
}

/**
 * Makes the session when it is not there. `zellij list-sessions` also shows a session that stopped, with the text
 * `EXITED`. zellij cannot open a tab in such a session: this function removes it and makes it again.
 * `zellij attach --create-background` stops with an error when the session is there.
 */
export async function ensureSession(name = SESSION): Promise<void> {
  const list = await capture(zellij(), ["list-sessions", "--no-formatting"], { timeoutMs: 30_000, codes: [0, 1] });
  const line = list.split("\n").find((l) => l === name || l.startsWith(`${name} `));
  if (line !== undefined && !line.includes("EXITED")) return;
  if (line !== undefined) await capture(zellij(), ["delete-session", name, "--force"], { timeoutMs: 30_000 });
  await capture(zellij(), ["attach", "--create-background", name], { timeoutMs: 30_000 });
}

/** The names of the tabs of the session. An error gives no names. */
async function tabNames(): Promise<string[]> {
  const out = await capture(zellij(), ["-s", SESSION, "action", "query-tab-names"], { timeoutMs: 30_000 }).catch(() => "");
  return out.split("\n");
}

/**
 * Makes the session when it is not there, and opens a tab with the name that starts the CLI command. With
 * `closeOnExit`, the tab closes when the command stops.
 *
 * zellij can start the command and not show the tab (its log has `Not enough room for panes`). Thus this function
 * reads the tab names a maximum of 3 times in approximately 3 seconds. It gives `tab: false` when the name is not
 * there, and the caller logs a warning. Do not start the command again: the first process can operate without a tab.
 */
export async function launch(ctx: Ctx, name: string, args: readonly string[], closeOnExit = false): Promise<{ tab: boolean }> {
  await ensureSession();
  await capture(zellij(), ["-s", SESSION, "action", "new-tab", "--name", name, "--layout-string", cliLayout(ctx, args, closeOnExit)], { timeoutMs: 30_000 });
  for (let i = 0; i < 3; i++) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1500));
    if ((await tabNames()).includes(name)) return { tab: true };
  }
  return { tab: false };
}
