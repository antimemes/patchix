/**
 * The description of a pull request, from `pr.md` and the files of a run.
 *
 * `pr.md` can contain these marks:
 * - `{{disclosure}}`: the AI disclosure block.
 * - `{{check:NAME}}`: the reviewer command of the check NAME and its output in a `<details>` block.
 * - `{{check:NAME FLAG [VALUE] FLAG [VALUE] ...}}`: the same, with the flags and their values at the end of the
 *   reviewer command, in the sequence of the mark. Each FLAG is one of the `flags` of the check NAME in
 *   `campaign.yaml` (see `Check.flags`), and the mark has each FLAG one time only. A flag with `value: true` has one
 *   VALUE after it, and the VALUE agrees with `FLAG_VALUE`. A flag with `value: false` has no VALUE. One space is
 *   between two parts, and the mark has no space at its start or at its end.
 * - `{{template}}`: the task list of the pull request template of nixpkgs.
 * - `{pr}`: the pull request number, or `<this PR>` until the pull request is made.
 *
 * A mark that does not agree with this grammar gives a problem: see `Rendered.problems`. Each different `{{...}}`
 * text of `pr.md` also gives a problem. The text keeps a mark with a problem as it is. A problem stops the pull
 * request: see `createOrUpdatePr`. Only the text of `pr.md` can give a problem: the output of a check is data.
 */
import { FLAG_VALUE, type Campaign, type Check } from "@patchix/common";

export interface RenderInput {
  body: string;
  campaign: Campaign;
  attr: string;
  pr: number | null;
  /** The output of each check of the run, by name. */
  checks: ReadonlyMap<string, string>;
  /** The model ids that made the work, for example `claude-opus-5-5`. */
  models: readonly string[];
}

export const PATCHIX_URL = "https://github.com/antimemes/patchix";
export const MEMELINT_URL = "https://github.com/antimemes/memelint";

/** `claude-opus-5-5` gives `Claude Opus 5.5`. An unknown id is given as it is. */
export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(id);
  if (!m) return id;
  const family = m[1] ?? "";
  return `Claude ${family.charAt(0).toUpperCase()}${family.slice(1)} ${m[2]}.${m[3]}`;
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export const AI_POLICY_URL = "https://github.com/NixOS/nixpkgs/blob/master/CONTRIBUTING.md#automationai-policy";

/**
 * The AI disclosure: a fixed text with the names of the models. The last part uses the words of the
 * `automation/AI policy` of nixpkgs. Before the pull request, the person must set the tick box of the page: see
 * `Pr.confirmed`.
 */
export function disclosure(models: readonly string[]): string {
  const names = [...new Set(models.map(modelName))];
  const used = names.length > 0 ? ` Claude Code used ${list(names)}.` : "";
  return [
    "> [!NOTE]",
    `> **AI Disclosure**: Claude Code made the code change, the commit message and the first version of this pull request description, with [patchix](${PATCHIX_URL}).${used} This pull request description is written in ASD-STE100 (Simplified Technical English), examined with [memelint](${MEMELINT_URL}) in \`strict\` mode. As the [automation/AI policy](${AI_POLICY_URL}) requires, I established confidence in this output: by manual review of the code change and of this description, and with the verification tooling that this description discloses.`,
  ].join("\n");
}

/** A code block limit that is longer than each limit in the text. */
function fence(text: string): string {
  let longest = 2;
  for (const m of text.matchAll(/`{3,}/g)) longest = Math.max(longest, (m[0] ?? "").length);
  return "`".repeat(longest + 1);
}

export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
}

/**
 * The check and the words after its name in a check mark, or the problems of the mark. `inside` is the text after
 * `check:`. A problem does not contain the mark.
 */
function parseCheck(campaign: Campaign, inside: string): { check: Check; words: string[] } | { problems: string[] } {
  if (inside === "") return { problems: ["no check name"] };
  if (/[^\S ]/.test(inside)) return { problems: ["a tab or a line break"] };
  if (inside.startsWith(" ")) return { problems: ["a space at the start"] };
  if (inside.endsWith(" ")) return { problems: ["a space at the end"] };
  if (inside.includes("  ")) return { problems: ["two spaces"] };
  const [name = "", ...words] = inside.split(" ");
  const check = campaign.checks.find((c) => c.name === name);
  if (check === undefined) return { problems: [`the campaign has no check \`${name}\``] };
  const problems: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";
    const flag = check.flags?.find((f) => f.name === word);
    if (flag === undefined) {
      problems.push(`the check \`${name}\` has no flag \`${word}\``);
      continue;
    }
    if (seen.has(word)) problems.push(`the flag \`${word}\` occurs two times`);
    seen.add(word);
    // A part after a flag that does not start with `--` is the value of the flag.
    const next = words[i + 1];
    const value = next !== undefined && !next.startsWith("--") ? next : null;
    if (value !== null) i++;
    if (flag.value && value === null) problems.push(`the flag \`${word}\` needs a value`);
    if (flag.value && value !== null && !FLAG_VALUE.test(value)) problems.push(`the value \`${value}\` of the flag \`${word}\` must contain only \`A-Za-z0-9._-\``);
    if (!flag.value && value !== null) problems.push(`the flag \`${word}\` takes no value`);
  }
  return problems.length > 0 ? { problems } : { check, words };
}

/** The text of a correct check mark: the reviewer command with the words of the mark, and the output of the check. */
function checkBlock(input: RenderInput, check: Check, words: readonly string[]): string {
  const output = input.checks.get(check.name) ?? "<no output>";
  const values = { attr: input.attr, pr: input.pr === null ? "<this PR>" : String(input.pr) };
  const lines: string[] = [];
  if (check.reviewer) lines.push("```sh", [fill(check.reviewer, values), ...words].join(" "), "```", "");
  const f = fence(output);
  lines.push("<details>", `<summary>Output of ${check.name}: ${input.attr}</summary>`, "", `${f}console`, output.trimEnd(), f, "", "</details>");
  return lines.join("\n");
}

/** A mark in `{{` and `}}` without `{` or `}` in it, or `{pr}`. */
const MARK = /\{\{([^{}]*)\}\}|\{pr\}/g;

/** The description and its problems. */
export interface Rendered {
  text: string;
  /**
   * One text for each problem of a mark, in the sequence of the text. For example "the mark `{{foo}}` is not
   * known" or "the mark `{{check:harness --x}}`: the check `harness` has no flag `--x`".
   */
  problems: string[];
}

export function render(input: RenderInput): Rendered {
  const pr = input.pr === null ? "<this PR>" : String(input.pr);
  const problems: string[] = [];
  // One replacement for all the marks: the text of a mark, for example the output of a check, is not examined again.
  const text = input.body.replace(MARK, (mark: string, inside: string | undefined) => {
    if (inside === undefined) return pr;
    if (inside === "disclosure") return disclosure(input.models);
    if (inside === "template") return TEMPLATE;
    if (inside.startsWith("check:")) {
      const parsed = parseCheck(input.campaign, inside.slice("check:".length));
      if ("check" in parsed) return checkBlock(input, parsed.check, parsed.words);
      problems.push(...parsed.problems.map((p) => `the mark \`${mark}\`: ${p}`));
      return mark;
    }
    problems.push(`the mark \`${mark}\` is not known`);
    return mark;
  });
  // A `{{...}}` text with `{` or `}` in it, for example `{{check:harness --shim {pr}}}`, is not a mark of `MARK`.
  for (const m of input.body.replace(/\{\{[^{}]*\}\}/g, "").matchAll(/\{\{[\s\S]*?\}\}(?!\})/g)) problems.push(`the mark \`${m[0]}\` is not known`);
  return { text: `${text.trimEnd()}\n`, problems };
}

/** The task list of the pull request template of nixpkgs. memelint does not examine it: see the campaign words. */
export const TEMPLATE = `## Things done

<!--
Please check what applies. Note that these are not hard requirements but merely serve as information for reviewers.
However, please do not remove the template, even when nothing is checked!
-->

- [x] Fits [CONTRIBUTING.md], [pkgs/README.md], [maintainers/README.md] and other READMEs.
- [x] Follows the [automation/AI policy].
- Built on platform:
  - [x] x86_64-linux
  - [ ] aarch64-linux
  - [ ] aarch64-darwin
- Tested, as applicable:
  - [ ] Basic functionality of all binary files, usually in \`./result/bin/\`.
  - [ ] Ran \`nixpkgs-review\` on this PR. See [nixpkgs-review usage].
  - [ ] [Package tests] at \`passthru.tests\`.
  - [ ] [NixOS tests] in [nixos/tests].
  - [ ] Tests in [lib/tests] or [pkgs/test] for functions and "core" functionality.
- Nixpkgs Release Notes
  - [ ] Package update: when the change is major or breaking.
- NixOS Release Notes
  - [ ] Module addition: when adding a new NixOS module.
  - [ ] Module update: when the change is significant.

[Package tests]: https://github.com/NixOS/nixpkgs/blob/master/pkgs/README.md#package-tests
[NixOS tests]: https://nixos.org/manual/nixos/unstable/index.html#sec-nixos-tests
[nixpkgs-review usage]: https://github.com/Mic92/nixpkgs-review#usage

[CONTRIBUTING.md]: https://github.com/NixOS/nixpkgs/blob/master/CONTRIBUTING.md
[automation/AI policy]: https://github.com/NixOS/nixpkgs/blob/master/CONTRIBUTING.md#automationai-policy
[lib/tests]: https://github.com/NixOS/nixpkgs/blob/master/lib/tests
[maintainers/README.md]: https://github.com/NixOS/nixpkgs/blob/master/maintainers/README.md
[nixos/tests]: https://github.com/NixOS/nixpkgs/blob/master/nixos/tests
[pkgs/README.md]: https://github.com/NixOS/nixpkgs/blob/master/pkgs/README.md
[pkgs/test]: https://github.com/NixOS/nixpkgs/blob/master/pkgs/test`;
