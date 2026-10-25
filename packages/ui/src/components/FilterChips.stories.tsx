import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { TaskState } from "@patchix/common";
import { FilterChips } from "./FilterChips.tsx";
import { STATE_TONE } from "./Badge.tsx";
import { STATES } from "../format.ts";

const COUNTS: Record<TaskState, number> = { todo: 41, running: 2, failed: 5, wontfix: 2, unverified: 4, ready: 3, pr: 7, merged: 6, closed: 1, external: 12 };
const options = STATES.map((s) => ({ value: s, label: s, count: COUNTS[s], tone: STATE_TONE[s] }));

function Example({ initial }: { initial: TaskState[] }) {
  const [value, setValue] = useState<TaskState[]>(initial);
  return (
    <div className="stack">
      <FilterChips<TaskState> label="Filter by state" options={options} value={value} onValueChange={setValue} />
      <p className="small muted">On: {value.length === 0 ? "none (all tasks show)" : value.join(", ")}</p>
    </div>
  );
}

const meta = {
  title: "Components/FilterChips",
  component: Example,
  args: { initial: [] },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NoneOn: Story = {};
export const SomeOn: Story = { args: { initial: ["failed", "unverified", "ready"] } };
export const WithoutCounts: Story = {
  render: () => <FilterChips label="Tag" options={[{ value: "agent", label: "agent" }, { value: "imported", label: "imported", tone: "purple" }]} value={["imported"]} onValueChange={() => undefined} />,
};
