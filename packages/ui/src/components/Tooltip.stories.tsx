import type { Meta, StoryObj } from "@storybook/react-vite";
import { Tooltip } from "./Tooltip.tsx";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";

const meta = {
  title: "Components/Tooltip",
  component: Tooltip,
  parameters: { layout: "centered" },
  args: {
    content: "/srv/patchix/.cache/worktrees/cacert/python3Packages.wassima",
    children: (
      <Badge tone="grey" render={<button type="button" />}>
        worktree
      </Badge>
    ),
  },
} satisfies Meta<typeof Tooltip>;
export default meta;
type Story = StoryObj<typeof meta>;

export const OnHover: Story = {};
export const Open: Story = { args: { defaultOpen: true } };
export const OnButton: Story = {
  args: { content: "The issue has an entry for this attribute, but the source command does not give it.", defaultOpen: true, children: <Button size="sm">not in source</Button> },
};
