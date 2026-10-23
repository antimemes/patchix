import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { Button } from "./Button.tsx";

const meta = {
  title: "Components/Button",
  component: Button,
  args: { children: "Save draft", onClick: fn() },
  argTypes: {
    variant: { control: "inline-radio", options: ["default", "primary", "danger", "ghost"] },
    size: { control: "inline-radio", options: ["md", "sm"] },
  },
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Primary: Story = { args: { variant: "primary", children: "Create pull request" } };
export const Danger: Story = { args: { variant: "danger", children: "Stop" } };
export const Ghost: Story = { args: { variant: "ghost", children: "Discard changes" } };
export const Small: Story = { args: { size: "sm", children: "Run" } };
export const Disabled: Story = { args: { variant: "primary", disabled: true, children: "Create pull request" } };
export const Pending: Story = { args: { variant: "primary", pending: true, children: "Sync" } };
export const AllVariants: Story = {
  render: (args) => (
    <div className="row">
      <Button {...args} variant="default">Default</Button>
      <Button {...args} variant="primary">Primary</Button>
      <Button {...args} variant="danger">Danger</Button>
      <Button {...args} variant="ghost">Ghost</Button>
      <Button {...args} size="sm">Small</Button>
      <Button {...args} disabled>Disabled</Button>
      <Button {...args} pending>Pending</Button>
    </div>
  ),
};
