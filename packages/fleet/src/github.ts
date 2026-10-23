/** The GitHub operations, with `gh`. `gh` gets the token from `GH_TOKEN`. `PATCHIX_GH_BIN` gives a different command. */
import { z } from "zod";
import { GITHUB_LOGIN, LabelSchema, type Label } from "@patchix/common";
import { capture } from "./proc.ts";
import { message, readSettings, type Ctx } from "./store.ts";

const ghBin = () => process.env["PATCHIX_GH_BIN"] || "gh";

/** Starts `gh`. With `log`, the command and its output go into the log for a person (see `CaptureOptions`). */
const gh = (args: readonly string[], log?: string[]) => capture(ghBin(), args, { timeoutMs: 2 * 60_000, log });

/** The time that a process keeps the login of `gh api user`. */
const LOGIN_MS = 60 * 60_000;
/** The login of each `gh` command, and the time that `gh` gave it. */
const logins = new Map<string, { at: number; login: string }>();

/** The GitHub login of `gh`: `gh api user --jq .login`. The process keeps it for one hour. */
export async function ghLogin(): Promise<string> {
  const bin = ghBin();
  const kept = logins.get(bin);
  if (kept !== undefined && Date.now() - kept.at < LOGIN_MS) return kept.login;
  const login = (await gh(["api", "user", "--jq", ".login"])).trim();
  if (!GITHUB_LOGIN.test(login)) throw new Error(`gh api user gave no GitHub login: ${login.slice(0, 80)}`);
  logins.set(bin, { at: Date.now(), login });
  return login;
}

/**
 * The GitHub user of the fork: the `fork` of the settings, or the login of `gh` when the settings have no fork. The
 * CLI, the fleet and the server use this function.
 */
export async function forkOf(ctx: Ctx): Promise<string> {
  const { fork } = await readSettings(ctx);
  if (fork !== null) return fork;
  try {
    return await ghLogin();
  } catch (e) {
    throw new Error(`no fork: set the fork on the settings page, or log in to gh (${message(e)})`, { cause: e });
  }
}

async function api<T>(schema: z.ZodType<T>, args: readonly string[], log?: string[]): Promise<T> {
  return schema.parse(JSON.parse(await gh(["api", ...args], log)));
}

export async function issueBody(repo: string, number: number): Promise<string> {
  return (await api(z.object({ body: z.string().nullable() }), [`repos/${repo}/issues/${number}`])).body ?? "";
}

const PullSchema = z.object({ number: z.number().int(), html_url: z.string(), state: z.string() });
/** The fields of `PullSchema` only: thus the log gets one short line, not all the fields of the pull request. */
const PULL_FIELDS = ["--jq", "{number, html_url, state}"];

/** Makes the pull request. `head` is `<fork>:<branch>`. The body comes from the file. */
export async function prCreate(repo: string, base: string, head: string, title: string, bodyFile: string, log?: string[]): Promise<{ number: number; url: string }> {
  const args = ["-X", "POST", `repos/${repo}/pulls`, "-f", `base=${base}`, "-f", `head=${head}`, "-f", `title=${title}`, "-F", `body=@${bodyFile}`, ...PULL_FIELDS];
  const pr = await api(PullSchema, args, log);
  return { number: pr.number, url: pr.html_url };
}

/** Writes the title and the body of the pull request again. */
export async function prEdit(repo: string, number: number, title: string, bodyFile: string, log?: string[]): Promise<void> {
  await api(PullSchema, ["-X", "PATCH", `repos/${repo}/pulls/${number}`, "-f", `title=${title}`, "-F", `body=@${bodyFile}`, ...PULL_FIELDS], log);
}

/** Adds the labels. The labels that the pull request has stay. The output is the name of each label of the pull request. */
export async function addLabels(repo: string, number: number, labels: readonly string[], log?: string[]): Promise<void> {
  if (labels.length === 0) return;
  await gh(["api", "-X", "POST", `repos/${repo}/issues/${number}/labels`, ...labels.flatMap((l) => ["-f", `labels[]=${l}`]), "--jq", ".[].name"], log);
}

const ListedPrSchema = z.object({
  number: z.number().int().positive(),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  /** The time of the merge, or `null`. */
  mergedAt: z.string().nullable(),
  url: z.string(),
  headRefName: z.string(),
});
export type ListedPr = z.infer<typeof ListedPrSchema>;

/** The pull requests that the GitHub user `author` made in the repository, open and closed, the newest first: 300 or less. */
export async function prList(repo: string, author: string): Promise<ListedPr[]> {
  const out = await gh(["pr", "list", "--repo", repo, "--author", author, "--state", "all", "--limit", "300", "--json", "number,state,mergedAt,url,headRefName"]);
  return ListedPrSchema.array().parse(JSON.parse(out));
}

/** The labels of the repository: 1000 or less. */
export async function labelList(repo: string): Promise<Label[]> {
  const out = await gh(["label", "list", "--repo", repo, "--limit", "1000", "--json", "name,color,description"]);
  return LabelSchema.array().parse(JSON.parse(out));
}

export async function prView(repo: string, number: number): Promise<{ state: string; url: string }> {
  const pr = await api(PullSchema, [`repos/${repo}/pulls/${number}`]);
  return { state: pr.state, url: pr.html_url };
}
