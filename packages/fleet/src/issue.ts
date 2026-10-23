/**
 * The parser of the task list of a tracking issue. One entry is one line. The test file has examples.
 *
 * The line starts with a tick box and the attribute between `**` marks. An em dash with spaces divides the parts after it.
 * The first part has the files in backticks and the `notes` after ` · `. The second part, when there is one, starts
 * with the pull request (`#N` or a GitHub URL). The text after it is the `remark`.
 *
 * A tracking issue can also point to sub-tracking issues. This parser does not go to them: it reads one issue.
 */
import { ATTR, type Task } from "@patchix/common";

const ENTRY = /^\s*[-*]\s+\[([ xX])\]\s+\*\*([^*]+)\*\*\s*(?:—\s*(.*))?$/;
const PR = /^(?:#(\d+)|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+))\s*(.*)$/;

export function parseIssueTasks(body: string): Task[] {
  const tasks: Task[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = ENTRY.exec(line);
    if (!m) continue;
    const attr = (m[2] ?? "").trim();
    if (!ATTR.test(attr)) continue;
    const parts = (m[3] ?? "").split(/\s+—\s+/);
    const first = parts[0] ?? "";
    const paths = [...first.matchAll(/`([^`]+)`/g)].map((x) => x[1] ?? "");
    const notes = first
      .replace(/`[^`]*`/g, "")
      .replace(/\(\+\d+ more\)/g, "")
      .split("·")
      .map((s) => s.trim())
      .filter((s) => s !== "")
      .join(" · ");
    let pr: number | null = null;
    let remark: string | null = null;
    const rest = parts.slice(1).join(" — ").trim();
    if (rest !== "") {
      const p = PR.exec(rest);
      if (p) {
        pr = Number(p[1] ?? p[2]);
        remark = (p[3] ?? "").trim() || null;
      } else {
        remark = rest;
      }
    }
    tasks.push({ attr, paths, notes, checked: m[1] !== " ", pr, remark, in_issue: true, in_source: false, branch: null });
  }
  return tasks;
}
