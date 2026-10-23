/**
 * The import of the work of a person from a different checkout: its branches `<branch_prefix>*` and, as an option,
 * a directory of pull request descriptions. Each branch has one commit on its base. The import makes one run with the
 * tag `imported` for each task of a branch. It also makes a draft for each task with a description and no draft.
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { ATTR, GIT_URL, type Campaign, type CheckResult, type Run } from "@patchix/common";
import { escapeRegex } from "./checks.ts";
import { branchName, cloneBase, diff, fetchRef, git, revParse, subject } from "./git.ts";
import { forkOf, prList, type ListedPr } from "./github.ts";
import { draftFromRun, refreshPrs } from "./pr.ts";
import { campaignWords, checkFile, exists, fail, listRuns, newId, now, readCampaign, readPr, readSettings, readTasks, readText, runDir, taskDir, tomlWords, writeRun, writeTasks, type Ctx } from "./store.ts";

export interface ImportResult {
  /** The branches with one or more tasks of the campaign. `run` is the id of the run of the tasks of the branch. */
  imported: { branch: string; attrs: string[]; run: string }[];
  /**
   * The branches without a task of this campaign: they can be branches of a different campaign. Also the branches
   * that the repository of patchix has with a different commit, when that commit is not the tip of the `base_branch`.
   * These branches can have work. Thus the import does not change them.
   */
  unmatched_branches: string[];
  /** The description files that are not the description of a task of the branches. */
  unmatched_files: string[];
}

interface Branch {
  branch: string;
  tip: string;
  /** The parent of the tip. */
  base: string;
  attrs: string[];
}

/** A description of a person as `pr.md`. */
interface Description {
  text: string;
  /** The output of the check, from the `console` code blocks. */
  output: string | null;
  words: string[];
}

/**
 * The attributes of a branch. They come from the first line of the commit message before the first `:`, with
 * `{a,b}` expanded. The name of the branch after the prefix is also an attribute. The line `rubyPackages.{a,b}: fix` gives `rubyPackages.a` and `rubyPackages.b`.
 */
export function branchAttrs(prefix: string, branch: string, subject: string): string[] {
  const head = subject.includes(":") ? subject.slice(0, subject.indexOf(":")).trim() : "";
  const m = /^([^{}]*)\{([^{}]*)\}([^{}]*)$/.exec(head);
  const attrs = m === null ? [head] : (m[2] ?? "").split(",").map((part) => `${m[1] ?? ""}${part.trim()}${m[3] ?? ""}`);
  return [...new Set([...attrs, branch.slice(prefix.length)])].filter((a) => ATTR.test(a));
}

/** The text of each `console` code block of the lines. */
function consoleTexts(lines: readonly string[]): string[] {
  const texts: string[] = [];
  let fence: string | null = null;
  let text: string[] = [];
  for (const line of lines) {
    if (fence === null) {
      fence = /^(`{3,})console\s*$/.exec(line)?.[1] ?? null;
      text = [];
    } else if (line.trim() === fence) {
      texts.push(`${text.join("\n").trimEnd()}\n`);
      fence = null;
    } else {
      text.push(line);
    }
  }
  return texts;
}

/**
 * The `sh` code block that starts at the line `start`, and the `<details>` blocks after it. Gives the index of the
 * last `</details>` line and the `console` texts in the blocks, or `null` when no `<details>` block follows.
 */
function checkBlock(lines: readonly string[], start: number): { end: number; output: string } | null {
  let i = start + 1;
  while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) i++;
  let end = -1;
  const texts: string[] = [];
  for (let j = i + 1; j < lines.length; j++) {
    const line = (lines[j] ?? "").trim();
    if (line === "") continue;
    if (line !== "<details>") break;
    const close = lines.findIndex((l, k) => k > j && l.trim() === "</details>");
    if (close < 0) break;
    texts.push(...consoleTexts(lines.slice(j, close)));
    end = j = close;
  }
  return end < 0 ? null : { end, output: texts.join("\n") };
}

/**
 * Makes `pr.md` from a description of a person, with the marks of `render.ts`:
 * - the `> [!NOTE]` block or the `> [!WARNING]` block (the AI disclosure) becomes `{{disclosure}}`;
 * - the `sh` code block of the reviewer command and the `<details>` blocks after it become `{{check:<check>}}`. The
 *   text of their `console` code blocks is the output of the check;
 * - the text from `## Things done` to the end becomes `{{template}}`;
 * - `<this PR>` and the number `pr` become `{pr}`.
 */
export function convertDescription(md: string, check: string | null, pr: number | null): { text: string; output: string | null } {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let output: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("## Things done")) {
      out.push("{{template}}");
      break;
    }
    // A description from before the change to `[!NOTE]` has the `[!WARNING]` block.
    if (line.startsWith("> [!NOTE]") || line.startsWith("> [!WARNING]")) {
      while (lines[i + 1]?.startsWith(">")) i++;
      out.push("{{disclosure}}");
      continue;
    }
    const block: { end: number; output: string } | null = check !== null && output === null && /^```sh\s*$/.test(line) ? checkBlock(lines, i) : null;
    if (block !== null) {
      out.push(`{{check:${check}}}`);
      output = block.output;
      i = block.end;
      continue;
    }
    out.push(line);
  }
  let text = out.join("\n").replaceAll("<this PR>", "{pr}");
  if (pr !== null) text = text.replace(new RegExp(`(?<!\\w)${pr}(?!\\w)`, "g"), "{pr}");
  return { text: `${text.trimEnd()}\n`, output };
}

/**
 * The `words` of the `[scopes.<name>]` tables of a memelint configuration that have `file` in their `paths`. `file`
 * is a path from the directory of the configuration. A table with only a directory in `paths` does not name the file.
 */
export function scopeWords(toml: string, file: string): string[] {
  const words: string[] = [];
  for (const table of toml.split(/^(?=\[)/m)) {
    if (!/^\[scopes\.[^\]]+\]/.test(table)) continue;
    const paths = /^paths\s*=\s*\[([^\]]*)\]/m.exec(table)?.[1] ?? "";
    if ([...paths.matchAll(/"([^"]*)"|'([^']*)'/g)].some((m) => (m[1] ?? m[2]) === file)) words.push(...(tomlWords(table)?.words ?? []));
  }
  return [...new Set(words)];
}

/**
 * The description file of each task, by attribute: `<attr>.md` or `<branch suffix>.md`. The last part of one of the
 * two after a `.` is also possible, for example `wassima.md` for `python3Packages.wassima`. A task without such a file can get
 * a file that no other task has. That file must have the attribute in its text. An example is `ruby-gems.md`, with
 * `rubyPackages.excon` in its reviewer command.
 */
async function findFiles(dir: string, prefix: string, found: readonly Branch[]): Promise<{ files: Map<string, string>; unmatched: string[] }> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".md")).sort();
  const files = new Map<string, string>();
  for (const b of found) {
    for (const attr of b.attrs) {
      const suffix = b.branch.slice(prefix.length);
      const name = [attr, attr.split(".").pop(), suffix, suffix.split(".").pop()].map((n) => `${n}.md`).find((n) => names.includes(n));
      if (name !== undefined) files.set(attr, name);
    }
  }
  const free = names.filter((n) => ![...files.values()].includes(n));
  const texts = new Map<string, string>();
  for (const n of free) texts.set(n, (await readText(join(dir, n))) ?? "");
  for (const b of found) {
    for (const attr of b.attrs) {
      const mention = new RegExp(`(?<![\\w.-])${escapeRegex(attr)}(?![\\w-]|\\.\\w)`);
      const name = files.has(attr) ? undefined : free.find((n) => mention.test(texts.get(n) ?? ""));
      if (name !== undefined) files.set(attr, name);
    }
  }
  const used = new Set(files.values());
  return { files, unmatched: names.filter((n) => !used.has(n)) };
}

/**
 * Writes the run of one task of the branch. The run has one commit, the status `ok`, the parent of the commit as
 * `base`, a log of one line and the tag `imported`. Its model is the model of the settings.
 */
async function importRun(ctx: Ctx, campaign: Campaign, attr: string, b: Branch, url: string, patch: string, doc: Description | null, start: Date): Promise<Run> {
  const { model } = await readSettings(ctx);
  const id = await newId(join(taskDir(ctx, campaign.name, attr), "runs"), start);
  const dir = runDir(ctx, campaign.name, attr, id);
  await writeFile(join(dir, "diff.patch"), patch);
  await writeFile(join(dir, "log.txt"), `[patchix ${now()}] import of the branch ${b.branch} (${b.tip}) from ${url}\n`);
  const checks: CheckResult[] = [];
  const check = campaign.checks.find((c) => c.reviewer !== undefined);
  if (doc !== null) {
    await writeFile(join(dir, "description.md"), doc.text);
    await writeFile(join(dir, "words.txt"), doc.words.map((w) => `${w}\n`).join(""));
    if (doc.output !== null && check !== undefined) {
      await mkdir(join(dir, "checks"), { recursive: true });
      await writeFile(checkFile(dir, check.name), doc.output);
      checks.push({ name: check.name, status: "pass", code: null, seconds: 0 });
    }
  }
  const time = now();
  const run: Run = { id, attr, tags: ["imported"], started: time, finished: time, status: "ok", model, pid: null, base: b.base, head: b.tip, commits: 1, checks, lint: null, error: null };
  await writeRun(ctx, campaign.name, run);
  return run;
}

/**
 * Imports the branches `<branch_prefix>*` of the repository at `url`. Each branch gets one fetch with depth 2: the tip
 * and its parent, the base. A branch that the repository of patchix has with the same commit gets no fetch. The tasks
 * of a branch are the attributes of `branchAttrs`. Also, a task is a task of the branch when its issue entry has the
 * number of the pull request of the branch. A task that has a run with the commit of the branch gets no new run. With `descriptions`,
 * each task with a description file and no draft gets a draft. At the end, `refreshPrs` gives each draft the number
 * and the state of the pull request of the fork for its branch.
 */
export async function importBranches(ctx: Ctx, c: string, url: string, descriptions?: string): Promise<ImportResult> {
  if (!GIT_URL.test(url)) fail(400, `not an https:// or file:// URL: ${url}`);
  const campaign = await readCampaign(ctx, c);
  const tasks = ((await readTasks(ctx, c)) ?? fail(409, `the campaign ${c} has no task list; sync it first`)).tasks;
  const known = new Set(tasks.map((t) => t.attr));
  const listed = await prList(campaign.issue.repo, await forkOf(ctx));
  const prs = new Map<string, ListedPr>();
  for (const pr of listed) if (!prs.has(pr.headRefName)) prs.set(pr.headRefName, pr);
  const repo = await cloneBase(ctx, campaign);
  const base = await revParse(repo, `refs/heads/${campaign.base_branch}`);
  const found: Branch[] = [];
  const unmatched_branches: string[] = [];
  for (const line of (await git(repo, ["ls-remote", "--heads", url, `refs/heads/${campaign.branch_prefix}*`])).split("\n")) {
    const [sha = "", ref = ""] = line.split("\t");
    const branch = ref.replace(/^refs\/heads\//, "");
    if (sha === "" || !branch.startsWith(campaign.branch_prefix)) continue;
    const local = await revParse(repo, `refs/heads/${branch}`);
    if (local !== null && local !== sha && local !== base) {
      unmatched_branches.push(branch);
      continue;
    }
    const tip = local === sha ? local : await fetchRef(ctx, url, branch, 2);
    const number = prs.get(branch)?.number;
    const byPr = tasks.filter((t) => number !== undefined && t.pr === number).map((t) => t.attr);
    const attrs = [...new Set([...branchAttrs(campaign.branch_prefix, branch, await subject(repo, tip)).filter((a) => known.has(a)), ...byPr])];
    const parent = await revParse(repo, `${tip}^`);
    if (attrs.length === 0 || parent === null) unmatched_branches.push(branch);
    else found.push({ branch, tip, base: parent, attrs });
  }

  const dir = descriptions === undefined ? null : resolve(descriptions);
  const docs = dir === null ? null : await findFiles(dir, campaign.branch_prefix, found);
  const toml = dir === null ? null : join(dirname(dir), "memelint.toml");
  const tomlText = toml === null ? "" : ((await readText(toml)) ?? "");
  const own = new Set(await campaignWords(ctx, c));
  const check = campaign.checks.find((x) => x.reviewer !== undefined)?.name ?? null;

  const imported: ImportResult["imported"] = [];
  const branches = new Map<string, string>();
  for (const b of found) {
    const start = new Date();
    const patch = await diff(repo, b.base, b.tip);
    let first: string | null = null;
    for (const attr of b.attrs) {
      const name = docs?.files.get(attr);
      let doc: Description | null = null;
      if (dir !== null && toml !== null && name !== undefined) {
        const converted = convertDescription((await readText(join(dir, name))) ?? "", check, prs.get(b.branch)?.number ?? null);
        doc = { ...converted, words: scopeWords(tomlText, relative(dirname(toml), join(dir, name))).filter((w) => !own.has(w)) };
      }
      const run = (await listRuns(ctx, c, attr)).find((r) => r.head === b.tip) ?? (await importRun(ctx, campaign, attr, b, url, patch, doc, start));
      first ??= run.id;
      if (doc !== null && (await readPr(ctx, c, attr)) === null && (await exists(join(runDir(ctx, c, attr, run.id), "description.md")))) {
        await draftFromRun(ctx, c, attr, run.id);
      }
      if (b.branch !== branchName(campaign, attr)) branches.set(attr, b.branch);
    }
    imported.push({ branch: b.branch, attrs: b.attrs, run: first ?? "" });
  }
  const file = await readTasks(ctx, c);
  if (file !== null && branches.size > 0) await writeTasks(ctx, c, { ...file, tasks: file.tasks.map((t) => ({ ...t, branch: branches.get(t.attr) ?? t.branch })) });
  await refreshPrs(ctx, campaign, listed);
  return { imported, unmatched_branches, unmatched_files: docs?.unmatched ?? [] };
}
