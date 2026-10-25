import assert from "node:assert/strict";
import { test } from "node:test";
import { CampaignSchema } from "@patchix/common";
import { disclosure, modelName, render } from "../src/render.ts";

const campaign = CampaignSchema.parse({
  name: "cacert",
  title: "t",
  issue: { repo: "NixOS/nixpkgs", number: 576541 },
  branch_prefix: "cacert/",
  checks: [
    {
      name: "harness",
      command: "true",
      pass: "FIXED",
      reviewer: "nix run harness -- {attr} --pr {pr}",
      flags: [{ name: "--force-build" }, { name: "--shim", value: true }, { name: "--no-system-store" }],
    },
    { name: "build", command: "true", pass: "." },
  ],
});

/** The output of the check `harness` for each attribute. */
const outputs = (by: Record<string, string>) => new Map(Object.entries(by).map(([attr, text]) => [attr, new Map([["harness", text]])]));

test("modelName", () => {
  assert.equal(modelName("claude-opus-5-5"), "Claude Opus 5.5");
  assert.equal(modelName("claude-fable-5-1"), "Claude Fable 5.1");
  assert.equal(modelName("gpt"), "gpt");
});

test("disclosure is a fixed text with the models and patchix", () => {
  assert.equal(
    disclosure(["claude-opus-5-5", "claude-opus-5-5"]),
    [
      "> [!NOTE]",
      "> **AI Disclosure**: Claude Code made the code change, the commit message and the first version of this pull request description, with [patchix](https://github.com/antimemes/patchix). " +
        "Claude Code used Claude Opus 5.5. " +
        "This pull request description is written in ASD-STE100 (Simplified Technical English), examined with [memelint](https://github.com/antimemes/memelint) in `strict` mode. " +
        "As the [automation/AI policy](https://github.com/NixOS/nixpkgs/blob/master/CONTRIBUTING.md#automationai-policy) requires, I established confidence in this output: " +
        "by manual review of the code change and of this description, and with the verification tooling that this description discloses.",
    ].join("\n"),
  );
  assert.doesNotMatch(disclosure([]), /Claude Code used/);
  assert.match(disclosure([]), /with \[patchix\]\([^)]+\)\. This pull request description/);
});

test("render replaces each mark", () => {
  const out = render({
    body: "Part of #1.\n\n{{disclosure}}\n\n### Test\n\n{{check:harness}}\n\n{{template}}\n",
    campaign,
    attrs: ["foo"],
    pr: null,
    checks: outputs({ foo: "VERDICT foo: FIXED\n" }),
    models: ["claude-opus-5-5"],
  });
  assert.deepEqual(out.problems, []);
  assert.match(out.text, /I established confidence in this output: by manual review of the code change and of this description/);
  assert.match(out.text, /nix run harness -- foo --pr <this PR>/);
  assert.match(out.text, /```console\nVERDICT foo: FIXED\n```/);
  assert.match(out.text, /## Things done/);
  assert.doesNotMatch(out.text, /\{\{/);
  assert.deepEqual(render({ body: "see {pr}", campaign, attrs: ["foo"], pr: 42, checks: new Map(), models: [] }), { text: "see 42\n", problems: [] });
});

test("a check mark of a branch with three entries gives one reviewer command and one output for each entry", () => {
  const out = render({ body: "{{check:harness --force-build}}", campaign, attrs: ["a", "b", "c"], pr: 7, checks: outputs({ a: "VERDICT a: FIXED\n", c: "VERDICT c: FIXED\n" }), models: [] });
  assert.deepEqual(out.problems, []);
  assert.match(out.text, /^```sh\nnix run harness -- a --pr 7 --force-build\nnix run harness -- b --pr 7 --force-build\nnix run harness -- c --pr 7 --force-build\n```\n\n<details>/);
  assert.match(out.text, /<summary>Output of harness: a<\/summary>\n\n```console\nVERDICT a: FIXED\n```\n\n<\/details>\n\n<details>\n<summary>Output of harness: b<\/summary>\n\n```console\n<no output>\n```/);
  assert.match(out.text, /<summary>Output of harness: c<\/summary>\n\n```console\nVERDICT c: FIXED\n```\n\n<\/details>\n$/);
});

/** The description of `body`, with the output of `harness` and the pull request 7. */
const draw = (body: string) => render({ body, campaign, attrs: ["foo"], pr: 7, checks: outputs({ foo: "VERDICT foo: FIXED\n" }), models: [] });

test("a check mark with flags of the check appends them to the reviewer command, in the sequence of the mark", () => {
  const one = draw("{{check:harness --force-build}}");
  assert.deepEqual(one.problems, []);
  assert.match(one.text, /```sh\nnix run harness -- foo --pr 7 --force-build\n```/);
  assert.match(one.text, /<details>\n<summary>Output of harness: foo<\/summary>\n\n```console\nVERDICT foo: FIXED\n```\n\n<\/details>/);
  const value = draw("{{check:harness --shim julia-bin}}");
  assert.deepEqual(value.problems, []);
  assert.match(value.text, /```sh\nnix run harness -- foo --pr 7 --shim julia-bin\n```/);
  const all = draw("{{check:harness --no-system-store --shim python-wheel_2.1 --force-build}}");
  assert.deepEqual(all.problems, []);
  assert.match(all.text, /```sh\nnix run harness -- foo --pr 7 --no-system-store --shim python-wheel_2\.1 --force-build\n```/);
  assert.match(all.text, /```console\nVERDICT foo: FIXED\n```/);
  // A check without a reviewer command has no `sh` block.
  assert.deepEqual(draw("{{check:build}}").problems, []);
  assert.doesNotMatch(draw("{{check:build}}").text, /```sh/);
});

test("a mark that does not agree with the rules gives a problem and stays in the text", () => {
  const cases: [string, string[]][] = [
    ["{{check:harness --whatever}}", ["the check `harness` has no flag `--whatever`"]],
    ["{{check:harness x}}", ["the check `harness` has no flag `x`"]],
    ["{{check:build --force-build}}", ["the check `build` has no flag `--force-build`"]],
    ["{{check:harness --shim}}", ["the flag `--shim` needs a value"]],
    ["{{check:harness --shim --force-build}}", ["the flag `--shim` needs a value"]],
    ["{{check:harness --shim ./x.nix}}", ["the value `./x.nix` of the flag `--shim` must contain only `A-Za-z0-9._-`"]],
    ["{{check:harness --force-build yes}}", ["the flag `--force-build` takes no value"]],
    ["{{check:harness --force-build --force-build}}", ["the flag `--force-build` occurs two times"]],
    ["{{check:harness --shim a --shim b}}", ["the flag `--shim` occurs two times"]],
    ["{{check:harness --whatever --shim}}", ["the check `harness` has no flag `--whatever`", "the flag `--shim` needs a value"]],
    ["{{check:other}}", ["the campaign has no check `other`"]],
    ["{{check:other --force-build}}", ["the campaign has no check `other`"]],
    ["{{check:harness  --force-build}}", ["two spaces"]],
    ["{{check:harness }}", ["a space at the end"]],
    ["{{check: harness}}", ["a space at the start"]],
    ["{{check:harness\t--force-build}}", ["a tab or a line break"]],
    ["{{check:harness\n--force-build}}", ["a tab or a line break"]],
    ["{{check:}}", ["no check name"]],
  ];
  for (const [mark, problems] of cases) {
    const out = draw(`Before.\n\n${mark}\n\nAfter.`);
    assert.deepEqual(out.problems, problems.map((p) => `the mark \`${mark}\`: ${p}`), mark);
    assert.equal(out.text, `Before.\n\n${mark}\n\nAfter.\n`, `the text keeps ${mark}`);
  }
});

test("a different mark is not known", () => {
  for (const mark of ["{{foo}}", "{{Disclosure}}", "{{ template }}", "{{pr}}", "{{}}"]) {
    const out = draw(`see ${mark}`);
    assert.deepEqual(out.problems, [`the mark \`${mark}\` is not known`], mark);
    assert.equal(out.text, `see ${mark}\n`);
  }
  // The mark has `{` and `}` in it: `{pr}` is replaced, but the mark is not.
  const nested = draw("{{check:harness --shim {pr}}} and {{disclosure}}");
  assert.deepEqual(nested.problems, ["the mark `{{check:harness --shim {pr}}}` is not known"]);
  assert.match(nested.text, /^\{\{check:harness --shim 7\}\} and > \[!NOTE\]/);
  // Each problem, in the sequence of the text. A correct mark between them is replaced.
  const two = draw("{{foo}} {{check:harness --force-build}} {{check:harness --bar}}");
  assert.deepEqual(two.problems, ["the mark `{{foo}}` is not known", "the mark `{{check:harness --bar}}`: the check `harness` has no flag `--bar`"]);
  assert.match(two.text, /^\{\{foo\}\} ```sh\nnix run harness -- foo --pr 7 --force-build\n```/);
  assert.match(two.text, /<\/details> \{\{check:harness --bar\}\}\n$/);
});

test("the output of a check is data: its marks give no problem and are not replaced", () => {
  const out = render({ body: "{{check:harness}}", campaign, attrs: ["foo"], pr: 7, checks: outputs({ foo: "{{foo}} {{template}} {pr}\n" }), models: [] });
  assert.deepEqual(out.problems, []);
  assert.match(out.text, /```console\n\{\{foo\}\} \{\{template\}\} \{pr\}\n```/);
});
