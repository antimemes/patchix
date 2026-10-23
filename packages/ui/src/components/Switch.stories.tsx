import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { Switch } from "./Switch.tsx";

const meta = {
  title: "Components/Switch",
  component: Switch,
  args: { label: "Preview", onCheckedChange: fn() },
} satisfies Meta<typeof Switch>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Off: Story = {};
export const On: Story = { args: { defaultChecked: true } };
export const Disabled: Story = { args: { disabled: true } };
