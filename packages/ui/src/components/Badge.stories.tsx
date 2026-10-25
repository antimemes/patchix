import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge, StateChip, StatusBadge, type Tone } from "./Badge.tsx";
import { STATES } from "../format.ts";

const TONES: Tone[] = ["grey", "blue", "red", "green", "purple", "amber", "muted", "muted-green", "muted-red", "muted-orange"];

const meta = {
  title: "Components/Badge",
  component: Badge,
  args: { children: "worktree", tone: "grey" },
  argTypes: { tone: { control: "select", options: TONES } },
} satisfies Meta<typeof Badge>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Tones: Story = {
  render: () => (
    <div className="row">
      {TONES.map((t) => (
        <Badge key={t} tone={t}>
          {t}
        </Badge>
      ))}
      <Badge tone="blue" dim>
        dim
      </Badge>
    </div>
  ),
};
export const StateChips: Story = {
  name: "State chips",
  render: () => (
    <div className="stack">
      <div className="row">
        {STATES.map((s) => (
          <StateChip key={s} state={s} />
        ))}
      </div>
      <div className="row">
        {STATES.map((s, i) => (
          <StateChip key={s} state={s} count={i % 3 === 0 ? 0 : i * 7} />
        ))}
      </div>
    </div>
  ),
};
export const StatusBadges: Story = {
  name: "Run and check status",
  render: () => (
    <div className="row">
      <StatusBadge status="queued" />
      <StatusBadge status="running" />
      <StatusBadge status="ok" />
      <StatusBadge status="unverified" />
      <StatusBadge status="wontfix" />
      <StatusBadge status="failed" />
      <StatusBadge status="stopped" />
      <StatusBadge status="pass">harness</StatusBadge>
      <StatusBadge status="fail">harness</StatusBadge>
      <StatusBadge status="error">build</StatusBadge>
    </div>
  ),
};
