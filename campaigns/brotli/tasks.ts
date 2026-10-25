/**
 * The task list of NixOS/nixpkgs#578375. One entry is one line:
 *
 *   - [ ] `attr` (`path`, `path`) — #123 remark
 *
 * The first name in backticks is the attribute. The names in backticks between `(` and `)` are the files. The `notes`
 * are the text of the nearest `###` heading, for example `.NET runtime (vendors brotli 1.1.0)`. A `##` heading starts
 * a new part: until the next `###` heading, the `notes` are the text of the `##` heading. The text after the `)` can
 * have a pull request (`#N` or a GitHub URL). The `remark` is that text without the `—` at its start. When the
 * text starts with the pull request, the `remark` does not have the pull request.
 *
 * The `sync` command imports this file with `import()`. Thus the import of `Task` is only a type: Node removes it.
 * The import does not use `@patchix/common`: `tsc` cannot find it from `campaigns/`, because only the packages have
 * it in their `node_modules`. The tests of the fleet package examine the types of this file.
 */
import type { Task } from "../../packages/common/src/model.ts";

const ENTRY = /^\s*[-*]\s+\[([ xX])\]\s+`([^`]+)`\s*(?:\(((?:[^()`]|`[^`]*`)*)\))?(.*)$/;
const HEADING = /^(#{2,6})\s+(.*?)\s*#*\s*$/;
const PR = /(?:#(\d+)|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+))(?![\w/])/;
const SEPARATOR = /^[\s—–:,;-]+/;

export default function brotliTasks(body: string): Task[] {
  const tasks: Task[] = [];
  let part = "";
  let family: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const h = HEADING.exec(line);
    if (h) {
      if ((h[1] ?? "").length === 2) {
        part = h[2] ?? "";
        family = null;
      } else {
        family = h[2] ?? "";
      }
      continue;
    }
    const m = ENTRY.exec(line);
    if (!m) continue;
    const paths = [...(m[3] ?? "").matchAll(/`([^`]+)`/g)].map((x) => x[1] ?? "");
    const rest = (m[4] ?? "").replace(SEPARATOR, "").trim();
    const p = PR.exec(rest);
    const pr = p ? Number(p[1] ?? p[2]) : null;
    const remark = (p?.index === 0 ? rest.slice(p[0].length).replace(SEPARATOR, "") : rest).trim() || null;
    tasks.push({ attr: (m[2] ?? "").trim(), paths, notes: family ?? part, checked: m[1] !== " ", pr, remark, in_issue: true, in_source: false, branch: null });
  }
  return tasks;
}
