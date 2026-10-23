import type { Meta, StoryObj } from "@storybook/react-vite";
import { Breadcrumbs } from "./Breadcrumbs.tsx";

const meta = {
  title: "Components/Breadcrumbs",
  component: Breadcrumbs,
  args: { items: [{ label: "Campaigns", href: "/" }, { label: "cacert" }] },
} satisfies Meta<typeof Breadcrumbs>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Campaign: Story = {};
export const Task: Story = { args: { items: [{ label: "Campaigns", href: "/" }, { label: "cacert", href: "/c/cacert" }, { label: "python3Packages.wassima" }] } };
export const Empty: Story = { args: { items: [] } };
