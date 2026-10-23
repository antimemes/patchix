import type { Meta, StoryObj } from "@storybook/react-vite";
import { NotFound } from "./NotFound.tsx";

const meta = {
  title: "Storylines/Not found",
  component: NotFound,
  args: { path: "/c/cacert/runs" },
} satisfies Meta<typeof NotFound>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
