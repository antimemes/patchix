import assert from "node:assert/strict";
import { test } from "node:test";
import { CampaignSchema } from "@patchix/common";
import { disclosure, modelName, render } from "../src/render.ts";

const campaign = CampaignSchema.parse({
  name: "cacert",
  title: "t",
  issue: { repo: "NixOS/nixpkgs", number: 576541 },
  branch_prefix: "cacert/",
  checks: [{ name: "harness", command: "true", pass: "FIXED", reviewer: "nix run harness -- {attr} --pr {pr}" }],
});

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
    attr: "foo",
    pr: null,
    checks: new Map([["harness", "VERDICT foo: FIXED\n"]]),
    models: ["claude-opus-5-5"],
  });
  assert.match(out, /I established confidence in this output: by manual review of the code change and of this description/);
  assert.match(out, /nix run harness -- foo --pr <this PR>/);
  assert.match(out, /```console\nVERDICT foo: FIXED\n```/);
  assert.match(out, /## Things done/);
  assert.doesNotMatch(out, /\{\{/);
  const numbered = render({ body: "see {pr}", campaign, attr: "foo", pr: 42, checks: new Map(), models: [] });
  assert.equal(numbered, "see 42\n");
});
