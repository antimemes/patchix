import type { Meta, StoryObj } from "@storybook/react-vite";
import { Progress } from "./Progress.tsx";

const meta = {
  title: "Components/Progress",
  component: Progress,
  args: { value: null, label: "The agent or the checks operate" },
  decorators: [(Story) => <div style={{ maxWidth: 360 }}>{Story()}</div>],
} satisfies Meta<typeof Progress>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Indeterminate: Story = {};
export const WithValue: Story = { args: { value: 3, max: 8, label: "3 of 8 checks" } };
export const NoLabel: Story = { args: { label: undefined } };
