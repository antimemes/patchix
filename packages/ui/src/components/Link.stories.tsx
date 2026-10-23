import type { Meta, StoryObj } from "@storybook/react-vite";
import { Link } from "./Link.tsx";

const meta = {
  title: "Components/Link",
  component: Link,
  args: { href: "/c/cacert", children: "Vendored CA PEM bundles" },
} satisfies Meta<typeof Link>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Internal: Story = {};
export const External: Story = { args: { href: "https://github.com/NixOS/nixpkgs/issues/576541", children: "NixOS/nixpkgs#576541" } };
export const Monospace: Story = { args: { href: "/c/cacert/t/python3Packages.wassima", className: "mono", children: "python3Packages.wassima" } };
