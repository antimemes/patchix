/**
 * memelint on a pull request description. The configuration is `campaigns/<name>/memelint.toml`
 * with the extra words of the draft added to its `words` list. memelint gives exit code 1 when it has findings.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LintResult } from "@patchix/common";
import { capture } from "./proc.ts";
import { campaignDir, fail, readText, tomlWords, type Ctx } from "./store.ts";

export type LintFinding = LintResult["findings"][number];

const FINDING = /^(.+?):(\d+):(\d+): error: (.*)$/;

/** The findings of `file` in the output of `memelint check`. Each finding gets the name `label`. */
export function parseLint(output: string, file: string, label: string): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const line of output.split("\n")) {
    const m = FINDING.exec(line.trimEnd());
    if (m !== null && m[1] === file) findings.push({ file: label, line: Number(m[2]), message: m[4] ?? "" });
  }
  return findings;
}

/** The TOML text with the extra words at the end of its `words` list, or in a new list when it has none. */
export function withWords(toml: string, extra: readonly string[]): string {
  const list = extra.map((w) => JSON.stringify(w)).join(", ");
  if (extra.length === 0) return toml;
  const words = tomlWords(toml);
  if (words === null) return `words = [${list}]\n${toml}`;
  return `${toml.slice(0, words.end)}${words.comma ? "" : ","}\n  ${list},\n${toml.slice(words.end)}`;
}

/** memelint on the text with the configuration of the campaign and the extra words. */
export async function lintText(ctx: Ctx, campaign: string, text: string, label: string, extra: readonly string[]): Promise<LintFinding[]> {
  const toml = (await readText(join(campaignDir(ctx, campaign), "memelint.toml"))) ?? 'check = true\nprofile = "strict"\n';
  const dir = await mkdtemp(join(tmpdir(), "patchix-lint-"));
  try {
    const config = join(dir, "memelint.toml");
    const file = join(dir, "text.md");
    await writeFile(config, withWords(toml, extra));
    await writeFile(file, text);
    const bin = process.env["PATCHIX_MEMELINT_BIN"] || "memelint";
    let out: string;
    try {
      out = await capture(bin, ["check", "--config", config, file], { cwd: dir, codes: [0, 1], timeoutMs: 60_000 });
    } catch (e) {
      fail(500, `memelint: ${e instanceof Error ? e.message : String(e)}`);
    }
    return parseLint(out, file, label);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
