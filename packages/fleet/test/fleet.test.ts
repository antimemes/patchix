/**
 * The fleet with a test script as `zellij`. The script records its arguments and gives the names of the tabs. For
 * the tab of a run, it starts a process with the words `run t <key>`. Then it moves the question of the branch into
 * the run directory and writes a `running` record with the `pid` of that process, as a runner does. For the keys
 * `none` and `lost`, it writes no record: the run does not start.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseIssueTasks } from "../src/issue.ts";
import { dequeue, enqueue, exists, fleetAlive, fleetTick, jobs, listQueue, listRuns, questionFile, queueRun, readFleet, runDir, runFleet, writeFleet, writeRun, writeSettings, writeTasks, type Ctx } from "../src/index.ts";

let tmp = "";
let calls = "";
let ctx: Ctx;
const lines: string[] = [];
const opts = { startMs: 600, tickMs: 10, log: (line: string) => void lines.push(line) };

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "patchix-fleet-"));
  ctx = { root: join(tmp, "root"), data: join(tmp, "data"), github: "file:///nonexistent" };
  await mkdir(join(ctx.root, "campaigns", "t"), { recursive: true });
  await writeFile(join(ctx.root, "campaigns", "t", "campaign.yaml"), "name: t\ntitle: Test\nissue: { repo: NixOS/nixpkgs, number: 1 }\nbranch_prefix: t/\n");
  // The `concurrency` of the settings: the default of `SettingsSchema` is also 2.
  await writeSettings(ctx, { fork: "someone", model: "claude-opus-5-5", concurrency: 2 });
  await writeTasks(ctx, "t", { synced: "2026-01-01T00:00:00Z", tasks: parseIssueTasks("- [ ] **a** — `/a`\n- [ ] **b** — `/b`\n- [ ] **c** — `/c`\n- [ ] **none** — `/d`\n- [ ] **lost** — `/e`\n") });
  calls = join(tmp, "zellij.txt");
  const zellij = join(tmp, "zellij.sh");
  const record = `id: "%s"\\nkey: %s\\nstarted: "2026-01-01T00:00:00Z"\\nfinished: null\\nstatus: running\\nmodel: m\\npid: %s\\nbase: ""\\nhead: null\\ncommits: 0\\nchecks: []\\nlint: null\\nerror: null\\n`;
  const script = `#!/bin/sh
[ "$4" = query-tab-names ] && exec sed -n 's/^-s patchix action new-tab --name //p' ${calls}
printf '%s\\n' "$1 $2 $3 $4 $5 $6" >> ${calls}
[ "$3" = action ] || exit 0
key=\${6#t/}
case "$key" in none|lost) exit 0;; esac
"${process.execPath}" -e 'setTimeout(() => {}, 60000)' run t "$key" >/dev/null 2>&1 &
id=$(date -u +%Y%m%d-%H%M%S)
branch="${ctx.data}/state/t/branches/$key"
mkdir -p "$branch/runs/$id"
[ -f "$branch/question.md" ] && mv "$branch/question.md" "$branch/runs/$id/question.md"
printf '${record}' "$id" "$key" "$!" > "$branch/runs/$id/run.yaml"
`;
  await writeFile(zellij, script);
  await chmod(zellij, 0o755);
  process.env["PATCHIX_ZELLIJ_BIN"] = zellij;
});

after(async () => {
  for (const attr of ["a", "b", "c"]) for (const r of await listRuns(ctx, "t", attr)) if (r.pid !== null && r.status === "running") process.kill(r.pid);
  delete process.env["PATCHIX_ZELLIJ_BIN"];
  await rm(tmp, { recursive: true, force: true });
});

const tabs = async () => (await readFile(calls, "utf8").catch(() => "")).split("\n").filter((l) => l.startsWith("-s patchix action new-tab"));

/** The runner of the newest run of the branch writes its last record. */
async function finish(attr: string) {
  const [run] = await listRuns(ctx, "t", attr);
  assert.ok(run !== undefined && run.pid !== null);
  await writeRun(ctx, "t", { ...run, status: "ok", finished: "2026-01-01T00:01:00Z", pid: null });
  process.kill(run.pid);
}

test("each tick starts runs in the free places, and a run that does not start gets a failed record", async () => {
  const start = Date.now();
  for (const [i, attr] of ["a", "b", "c", "none"].entries()) await enqueue(ctx, "t", attr, new Date(start + i).toISOString());

  assert.equal(await fleetTick(ctx, "t", opts), true);
  assert.deepEqual(await tabs(), ["-s patchix action new-tab --name t/a", "-s patchix action new-tab --name t/b"], "concurrency 2: two runs");
  assert.deepEqual(await listQueue(ctx, "t"), ["c", "none"]);
  assert.deepEqual((await jobs(ctx, "t")).map((j) => j.key), ["a", "b"]);

  await fleetTick(ctx, "t", opts);
  assert.equal((await tabs()).length, 2, "no free place");

  await finish("a");
  await fleetTick(ctx, "t", opts);
  assert.deepEqual((await tabs()).slice(2), ["-s patchix action new-tab --name t/c"]);
  assert.deepEqual(await listQueue(ctx, "t"), ["none"]);

  await finish("b");
  await fleetTick(ctx, "t", opts);
  assert.deepEqual((await tabs()).slice(3), ["-s patchix action new-tab --name t/none"]);
  assert.deepEqual(await listQueue(ctx, "t"), [], "the entry of a run that did not start is removed");
  const [failed] = await listRuns(ctx, "t", "none");
  assert.deepEqual([failed?.status, failed?.error, failed?.pid], ["failed", "the run did not start", null]);
  assert.ok(lines.some((l) => l.startsWith("none: the run did not start; the fleet wrote the failed run ")), lines.join("\n"));

  assert.equal(await fleetTick(ctx, "t", opts), false, "the queue is empty");
});

test("the fleet stops when the queue is empty, and a second fleet stops at its start", async () => {
  assert.equal(await runFleet(ctx, "t", opts), 0);
  assert.equal(await exists(join(ctx.data, "state", "t", "fleet.yaml")), false, "the fleet removes fleet.yaml");

  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)", "fleet", "t"], { stdio: "ignore" });
  await once(other, "spawn");
  try {
    await writeFleet(ctx, "t", { pid: other.pid ?? 0, started: "2026-01-01T00:00:00Z" });
    assert.equal(await fleetAlive(ctx, "t"), true);
    await enqueue(ctx, "t", "c");
    assert.equal(await runFleet(ctx, "t", opts), 0);
    assert.equal((await readFleet(ctx, "t"))?.pid, other.pid, "the second fleet does not write fleet.yaml");
    assert.deepEqual(await listQueue(ctx, "t"), ["c"], "the second fleet starts no run");
  } finally {
    other.kill();
  }
  await once(other, "exit");
  assert.equal(await fleetAlive(ctx, "t"), false, "the pid of fleet.yaml stopped");
});

test("a question is a run entry: the fleet starts the run of the branch, and a run that does not start gets the question", async () => {
  // The run of `c` of the first test operates, and the second test left the entry of `c` in the queue.
  await finish("c");
  await dequeue(ctx, "t", "c");
  const seen = (await tabs()).length;
  const tab = (attr: string) => `-s patchix action new-tab --name t/${attr}`;
  // As the server: a run with a question (`question.md` of the branch directory and the entry of the branch) and a run without a question.
  await queueRun(ctx, "t", "a", "Why?");
  await queueRun(ctx, "t", "b");
  // The first test wrote a `failed` run of `none`, possibly in this second. The branch `lost` has no run.
  await queueRun(ctx, "t", "lost", "Is the symlink enough?");
  assert.deepEqual(await listQueue(ctx, "t"), ["a", "b", "lost"]);

  await fleetTick(ctx, "t", opts);
  assert.deepEqual((await tabs()).slice(seen), [tab("a"), tab("b")], "a run with a question has the tab of a run");
  assert.deepEqual(await listQueue(ctx, "t"), ["lost"]);
  const [asked] = await listRuns(ctx, "t", "a");
  assert.ok(asked !== undefined);
  assert.equal(await readFile(join(runDir(ctx, "t", "a", asked.id), "question.md"), "utf8"), "Why?\n", "the runner took the question");
  const [plain] = await listRuns(ctx, "t", "b");
  assert.equal(await exists(join(runDir(ctx, "t", "b", plain?.id ?? ""), "question.md")), false, "a run without a question gets no question.md");
  await assert.rejects(queueRun(ctx, "t", "a", "Again?"), /the branch a has a job/);
  await assert.rejects(queueRun(ctx, "t", "a"), /the branch a has a job/);

  await finish("a");
  await fleetTick(ctx, "t", opts);
  assert.deepEqual((await tabs()).slice(seen + 2), [tab("lost")]);
  const [failed] = await listRuns(ctx, "t", "lost");
  assert.deepEqual([failed?.status, failed?.error, failed?.question, failed?.pid], ["failed", "the run did not start", "Is the symlink enough?", null]);
  assert.equal(await readFile(join(runDir(ctx, "t", "lost", failed?.id ?? ""), "question.md"), "utf8"), "Is the symlink enough?\n");
  assert.equal(await exists(questionFile(ctx, "t", "lost")), false, "the failed run took the question");
  assert.deepEqual((await jobs(ctx, "t")).map((j) => j.key), ["b"]);
  await finish("b");
  assert.equal(await fleetTick(ctx, "t", opts), false, "the queue is empty");
});

test("the fleet removes an entry without a branch directory that is not an entry of the task list, and starts a free-text run", async () => {
  await enqueue(ctx, "t", "nowhere");
  // As the server: the text of a free-text run goes into `question.md` of the new branch directory.
  await queueRun(ctx, "t", "free-text", "Add one setup hook.");
  const seen = (await tabs()).length;
  await fleetTick(ctx, "t", opts);
  assert.deepEqual((await tabs()).slice(seen), ["-s patchix action new-tab --name t/free-text"]);
  assert.ok(lines.includes("nowhere: no branch nowhere; removed from the queue"), lines.join("\n"));
  assert.deepEqual(await listQueue(ctx, "t"), []);
  const [run] = await listRuns(ctx, "t", "free-text");
  assert.equal(await readFile(join(runDir(ctx, "t", "free-text", run?.id ?? ""), "question.md"), "utf8"), "Add one setup hook.\n");
  await finish("free-text");
});
