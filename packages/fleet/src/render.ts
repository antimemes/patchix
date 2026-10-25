/**
 * The description of a pull request, from `pr.md` and the files of a run.
 *
 * `pr.md` can contain these marks:
 * - `{{disclosure}}`: the AI disclosure block.
 * - `{{check:NAME}}`: the reviewer command of the check NAME and its output in a `<details>` block.
 * - `{{check:NAME FLAG FLAG}}`: the same, with the flags at the end of the reviewer command. NAME is `[A-Za-z0-9_-]+`,
 *   each flag is `[A-Za-z0-9=./_-]+`, and one space is between two parts. A mark that does not agree with this
 *   grammar becomes the text `<!-- patchix: the mark ... is not valid ... -->`.
 * - `{{template}}`: the task list of the pull request template of nixpkgs.
 * - `{pr}`: the pull request number, or `<this PR>` until the pull request is made.
 */
import type { Campaign } from "@patchix/common";

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

/** The text of a check mark. `mark` is the full mark, and `inside` is the text after `check:`. */
function checkBlock(input: RenderInput, mark: string, inside: string): string {
  const [name = "", ...flags] = inside.split(" ");
  // Without `>`, the text of the mark cannot contain `-->`.
  if (!/^[A-Za-z0-9_-]+$/.test(name) || !flags.every((f) => /^[A-Za-z0-9=./_-]+$/.test(f)))
    return `<!-- patchix: the mark ${mark.replace(/>/g, "&gt;")} is not valid: see the Marks line of the page -->`;
  const check = input.campaign.checks.find((c) => c.name === name);
  if (!check) return `<!-- patchix: the campaign has no check ${name} -->`;
  const output = input.checks.get(name) ?? "<no output>";
  const values = { attr: input.attr, pr: input.pr === null ? "<this PR>" : String(input.pr) };
  const lines: string[] = [];
  if (check.reviewer) lines.push("```sh", [fill(check.reviewer, values), ...flags].join(" "), "```", "");
  const f = fence(output);
  lines.push("<details>", `<summary>Output of ${name}: ${input.attr}</summary>`, "", `${f}console`, output.trimEnd(), f, "", "</details>");
  return lines.join("\n");
}

export function render(input: RenderInput): string {
  const pr = input.pr === null ? "<this PR>" : String(input.pr);
  return input.body
    .replace(/\{\{disclosure\}\}/g, () => disclosure(input.models))
    .replace(/\{\{check:([^}]*)\}\}/g, (mark: string, inside: string) => checkBlock(input, mark, inside))
    .replace(/\{\{template\}\}/g, () => TEMPLATE)
    .replace(/\{pr\}/g, pr)
    .trimEnd()
    .concat("\n");
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
