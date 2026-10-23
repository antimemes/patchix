/**
 * One ask: a question of a person to the agent, in the worktree of the task. The server writes `question.md`. The
 * runner writes `ask.yaml` (`running`, with its `pid`) and starts `claude -p --continue`: thus the agent continues
 * the newest session of `claude` in the worktree. The prompt has the instructions of the campaign (see
 * `campaignInstructions`) and the question. `prompt.md` gets the prompt, `reply.md` gets the `stdout` of
 * `claude`, and `log.txt` gets the lines of the runner, the `stdout` and the `stderr`. Only the runner writes `ask.yaml`.
 */
import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Ask } from "@patchix/common";
import { claudeBin, runClaude } from "./claude.ts";
import { addWorktree, changedFiles, diff, revParse, untracked } from "./git.ts";
import { describe, type StartResult } from "./proc.ts";
import { askDir, exists, fail, listRuns, message, now, readCampaign, readSettings, readText, runDir, writeAsk, type Ctx } from "./store.ts";
import { campaignInstructions, GIT_RULE } from "./run.ts";

/** When `claude --continue` stops with an error in this time, the worktree has no session of `claude`: the runner starts `claude` again without `--continue`. */
const FAST_MS = 30_000;

/** Gives the question of the ask `id` to the agent, with the model of the settings, and gives the last record of the ask. */
export async function runAsk(ctx: Ctx, c: string, attr: string, id: string, signal?: AbortSignal): Promise<Ask> {
  const campaign = await readCampaign(ctx, c);
  const { model } = await readSettings(ctx);
  const dir = askDir(ctx, c, attr, id);
  const question = (await readText(join(dir, "question.md"))) ?? fail(404, `the ask ${id} of ${attr} has no question.md`);
  if (await exists(join(dir, "ask.yaml"))) fail(409, `the ask ${id} of ${attr} is not a new ask: it has an ask.yaml`);
  let ask: Ask = { id, attr, question: question.trim(), started: now(), finished: null, status: "running", model, pid: process.pid, files: [], error: null };
  await writeAsk(ctx, c, ask);
  const log = createWriteStream(join(dir, "log.txt"), { flags: "a" });
  log.on("error", () => undefined);
  try {
    const wt = await addWorktree(ctx, campaign, attr);
    const before = (await revParse(wt.path, "HEAD")) ?? "HEAD";
    const run = (await listRuns(ctx, c, attr))[0];
    const prompt = [
      `# A question about the task \`${attr}\` of the campaign "${campaign.title}"`,
      "",
      `The newest run is ${run === undefined ? "(none)" : `\`${run.id}\` (${run.status}${run.error === null ? "" : `: ${run.error}`}), in \`${runDir(ctx, c, attr, run.id)}\``}.`,
      "Reply to the question. Change the files of the worktree only when the question tells you to.",
      GIT_RULE,
      "",
      "# The instructions of the campaign",
      "",
      "When the question asks you to examine the commit against the instructions, read `git show HEAD` and give each instruction that the commit does not obey, with the line.",
      "",
      await campaignInstructions(ctx, c),
      "",
      "# The question",
      "",
      question.trim(),
      "",
    ].join("\n");
    await writeFile(join(dir, "prompt.md"), prompt);
    log.write(`[patchix ${now()}] ${claudeBin()} -p <prompt.md> --continue --model ${model}\n`);
    const once = async (cont: boolean): Promise<StartResult> => {
      const reply = createWriteStream(join(dir, "reply.md"));
      try {
        const opts = { cwd: wt.path, prompt, model, dir, out: log, stdout: reply, timeoutMs: campaign.timeout_minutes * 60_000, signal, cont };
        return await runClaude(opts);
      } finally {
        await new Promise<void>((r) => reply.end(r));
      }
    };
    const began = Date.now();
    let result = await once(true);
    if (!result.stopped && result.code !== 0 && Date.now() - began < FAST_MS) {
      log.write(`[patchix ${now()}] claude --continue: ${describe(result)}; again without --continue\n`);
      result = await once(false);
    }
    log.write(`[patchix ${now()}] claude: ${describe(result)}\n`);
    const added = await untracked(wt.path);
    await writeFile(join(dir, "diff.patch"), (await diff(wt.path, before)) + added.map((f) => `new file, not committed: ${f}\n`).join(""));
    const status = signal?.aborted ? "stopped" : result.code === 0 ? "ok" : "failed";
    ask = { ...ask, status, files: await changedFiles(wt.path, before), error: status === "failed" ? `claude: ${describe(result)}` : null };
  } catch (e) {
    log.write(`[patchix ${now()}] error: ${message(e)}\n`);
    ask = { ...ask, status: signal?.aborted ? "stopped" : "failed", error: message(e) };
  } finally {
    await new Promise<void>((r) => log.end(r));
  }
  ask = { ...ask, finished: now(), pid: null };
  await writeAsk(ctx, c, ask);
  return ask;
}
