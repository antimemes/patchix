import type { Meta, StoryObj } from "@storybook/react-vite";
import { CodeBlock } from "./CodeBlock.tsx";
import { description, diff, harnessOutput, logLines } from "../mock/fixtures.ts";

const meta = {
  title: "Components/CodeBlock",
  component: CodeBlock,
  args: { label: "Output of harness", text: harnessOutput("python3Packages.wassima", true) },
} satisfies Meta<typeof CodeBlock>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Text: Story = {};
export const Diff: Story = { args: { label: "Diff", diff: true, text: diff("python3Packages.wassima") } };
export const Prose: Story = { args: { label: "Description", wrap: true, text: description("python3Packages.wassima") } };
export const Long: Story = { args: { label: "Log", follow: true, maxHeight: "12rem", text: Array.from({ length: 12 }, () => logLines("anki")).flat().join("\n") } };
export const Loading: Story = { args: { text: null, loading: true } };
export const Empty: Story = { args: { text: "", empty: "No diff." } };
export const Error: Story = { args: { text: null, error: "the run has no such file" } };
