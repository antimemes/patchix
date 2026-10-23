import assert from "node:assert/strict";
import { test } from "node:test";
import { parseIssueTasks } from "../src/issue.ts";

const BODY = `Part of #576475.
- [x] **akkoma** — \`/lib/castore-1.0.17/priv/cacerts.pem\` (+1 more) — #576652 (beamPackages)
- [ ] **ansible-language-server** — \`/lib/a/vsce-sign\` (+3 more) · trusts AAA
- [ ] **arduino-core** — \`/share/x.bin\` (+32 more) · stale bundle, no ECC G3 · trusts AAA
- [x] **grpc** — \`/share/grpc/roots.pem\` · trusts AAA — no change needed: the C core never reads this file
- [X] **pleroma** — \`/lib/castore-1.0.15/priv/cacerts.pem\` (+1 more) · trusts AAA — https://github.com/NixOS/nixpkgs/pull/576652 (beamPackages)
- [ ] **python3Packages.wassima** — \`/lib/python3.13/site-packages/wassima/_os/_embed.py\` (+5 more)
- [ ] not an entry
`;

test("parseIssueTasks reads each entry", () => {
  const tasks = parseIssueTasks(BODY);
  assert.equal(tasks.length, 6);
  assert.deepEqual(tasks[0], { attr: "akkoma", paths: ["/lib/castore-1.0.17/priv/cacerts.pem"], notes: "", checked: true, pr: 576652, remark: "(beamPackages)", in_issue: true, in_source: false, branch: null });
  assert.deepEqual(tasks[1], { attr: "ansible-language-server", paths: ["/lib/a/vsce-sign"], notes: "trusts AAA", checked: false, pr: null, remark: null, in_issue: true, in_source: false, branch: null });
  assert.equal(tasks[2]?.notes, "stale bundle, no ECC G3 · trusts AAA");
  assert.deepEqual(tasks[3], { attr: "grpc", paths: ["/share/grpc/roots.pem"], notes: "trusts AAA", checked: true, pr: null, remark: "no change needed: the C core never reads this file", in_issue: true, in_source: false, branch: null });
  assert.equal(tasks[4]?.pr, 576652);
  assert.equal(tasks[4]?.checked, true);
  assert.equal(tasks[5]?.attr, "python3Packages.wassima");
});
