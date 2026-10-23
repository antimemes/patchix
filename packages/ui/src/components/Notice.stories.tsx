import type { Meta, StoryObj } from "@storybook/react-vite";
import { Notice } from "./Notice.tsx";

const meta = {
  title: "Components/Notice",
  component: Notice,
  args: { tone: "error", children: "the campaign cacert has 2 jobs and its concurrency is 2: 3 more do not fit" },
  argTypes: { tone: { control: "inline-radio", options: ["error", "warning", "info", "success"] } },
} satisfies Meta<typeof Notice>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Error: Story = {};
export const Warning: Story = { args: { tone: "warning", children: "The draft is from run 20261023-190000. The newest ok run is 20261023-210000." } };
export const Info: Story = { args: { tone: "info", children: "No tasks. Sync reads the task list of the issue." } };
export const Success: Story = { args: { tone: "success", children: "No findings." } };
