import type { Run, CheckResult, TaskState } from "@patchix/common";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import "./Badge.css";

export type Tone = "grey" | "blue" | "red" | "green" | "purple" | "amber" | "muted" | "muted-green" | "muted-red" | "muted-orange";

export interface BadgeProps extends useRender.ComponentProps<"span"> {
  tone?: Tone | undefined;
  dim?: boolean | undefined;
}

export function Badge({ tone = "grey", dim = false, render, ...props }: BadgeProps) {
  const own = { className: `ui-badge ui-badge--${tone}${dim ? " is-dim" : ""}` };
  return useRender({ defaultTagName: "span", render, props: mergeProps<"span">(own, props) });
}

export const STATE_TONE: Record<TaskState, Tone> = {
  todo: "grey",
  running: "blue",
  failed: "red",
  wontfix: "muted-orange",
  unverified: "amber",
  ready: "green",
  pr: "purple",
  merged: "muted-green",
  closed: "muted-red",
  external: "muted",
};

export function StateChip({ state, count, ...props }: BadgeProps & { state: TaskState; count?: number | undefined }) {
  return (
    <Badge tone={STATE_TONE[state]} dim={count === 0} {...props}>
      {state}
      {count !== undefined && <span className="ui-badge-count">{count}</span>}
    </Badge>
  );
}

/** A check that is `fail` makes the run `unverified`, and a check that is `error` makes it `failed`: the colors agree. */
const STATUS_TONE: Record<Run["status"] | CheckResult["status"], Tone> = {
  running: "blue",
  ok: "green",
  unverified: "amber",
  wontfix: "muted-orange",
  failed: "red",
  stopped: "grey",
  pass: "green",
  fail: "amber",
  error: "red",
};

export function StatusBadge({ status, children, ...props }: BadgeProps & { status: Run["status"] | CheckResult["status"] }) {
  return (
    <Badge tone={STATUS_TONE[status]} {...props}>
      {children ?? status}
    </Badge>
  );
}
