import type { TaskState } from "@patchix/common";

export const STATES = ["todo", "running", "failed", "wontfix", "unverified", "ready", "pr", "merged", "closed", "external"] as const satisfies readonly TaskState[];
const allStates: Exclude<TaskState, (typeof STATES)[number]> extends never ? true : false = true;
void allStates;

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function time(iso: string | null): string {
  if (iso === null) return "never";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateTime.format(date);
}

export function ago(iso: string, now: number = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  if (Number.isNaN(ms)) return iso;
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export const issueUrl = (repo: string, n: number) => `https://github.com/${repo}/issues/${n}`;
export const pullUrl = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

export const short = (sha: string) => sha.slice(0, 12);
