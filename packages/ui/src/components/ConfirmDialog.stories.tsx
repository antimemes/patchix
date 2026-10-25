import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Button } from "./Button.tsx";

const meta = {
  title: "Components/ConfirmDialog",
  component: ConfirmDialog,
  args: {
    trigger: (
      <Button size="sm" variant="danger">
        Stop
      </Button>
    ),
    title: "Stop the run of arduino-core?",
    description: "The agent stops. The worktree and the files of the job stay.",
    confirmLabel: "Stop",
    onConfirm: fn(),
  },
} satisfies Meta<typeof ConfirmDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};
export const Open: Story = { args: { defaultOpen: true } };
export const Primary: Story = {
  args: {
    defaultOpen: true,
    variant: "primary",
    trigger: <Button size="sm">Make draft again</Button>,
    title: "Replace the draft?",
    description: "The new draft gets the description of the newest run with a description, and the title of the tip of the branch. The labels and the pull request number stay.",
    confirmLabel: "Replace",
  },
};
