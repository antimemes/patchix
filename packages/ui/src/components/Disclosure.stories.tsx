import type { Meta, StoryObj } from "@storybook/react-vite";
import { Disclosure } from "./Disclosure.tsx";
import { CodeBlock } from "./CodeBlock.tsx";
import { ASK_DIFF } from "../mock/fixtures.ts";

const meta = {
  title: "Components/Disclosure",
  component: Disclosure,
  args: { label: "Diff", children: <CodeBlock label="Diff of the ask" diff text={ASK_DIFF} /> },
} satisfies Meta<typeof Disclosure>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};
export const Open: Story = { args: { defaultOpen: true } };
