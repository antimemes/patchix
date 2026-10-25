import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { parseIssueTasks } from "../src/issue.ts";
import { context } from "../src/store.ts";
import { extractTasks } from "../src/sync.ts";
import brotliTasks from "../../../campaigns/brotli/tasks.ts";

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

/** The format of NixOS/nixpkgs#578375. `campaigns/brotli/tasks.ts` reads it. */
const BROTLI = `Evaluated against 1ee4ed5c on Linux x86_64.

## Vendored C decoder

### .NET runtime (vendors brotli 1.1.0)

dotnet/runtime vendors brotli 1.1.0 in \`src/native/external/brotli\`.

- [ ] \`crossmacro\` (\`lib/crossmacro/.CrossMacro.UI-wrapped\`)
- [x] \`dotnetCorePackages.dotnet_10.vmr\` (\`…/native/singlefilehost\`) — #579001 update to 10.0.5
- [ ] \`helion\` (\`lib/helion/Helion\`) https://github.com/NixOS/nixpkgs/pull/579002

### DuckDB (vendors brotli 1.1.0)

- [ ] \`duckdb\` (\`bin/duckdb\`, \`lib/libduckdb.so\`)

## Other

- [X] \`_7zip-zstd\` (\`lib/7zip/7z.so\`) — no change needed: see #579003
- [ ] \`edk2\`
`;

test("the tasks.ts of the brotli campaign reads each entry, and the sync imports it", async () => {
  const entry = { checked: false, pr: null, remark: null, in_issue: true, in_source: false, branch: null };
  const dotnet = ".NET runtime (vendors brotli 1.1.0)";
  const expected = [
    { ...entry, attr: "crossmacro", paths: ["lib/crossmacro/.CrossMacro.UI-wrapped"], notes: dotnet },
    { ...entry, attr: "dotnetCorePackages.dotnet_10.vmr", paths: ["…/native/singlefilehost"], notes: dotnet, checked: true, pr: 579001, remark: "update to 10.0.5" },
    { ...entry, attr: "helion", paths: ["lib/helion/Helion"], notes: dotnet, pr: 579002 },
    { ...entry, attr: "duckdb", paths: ["bin/duckdb", "lib/libduckdb.so"], notes: "DuckDB (vendors brotli 1.1.0)" },
    { ...entry, attr: "_7zip-zstd", paths: ["lib/7zip/7z.so"], notes: "Other", checked: true, pr: 579003, remark: "no change needed: see #579003" },
    { ...entry, attr: "edk2", paths: [], notes: "Other" },
  ];
  assert.deepEqual(brotliTasks(BROTLI), expected);
  const warnings: string[] = [];
  const root = resolve(import.meta.dirname, "..", "..", "..");
  assert.deepEqual(await extractTasks(context({ root }), "brotli", BROTLI, warnings), expected);
  assert.deepEqual(warnings, []);
});
