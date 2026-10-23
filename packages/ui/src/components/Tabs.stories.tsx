import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Tabs } from "./Tabs.tsx";
import { CodeBlock } from "./CodeBlock.tsx";
import { diff, description } from "../mock/fixtures.ts";

type Tab = "diff" | "checks" | "log" | "description";
function Example({ initial, disableLog }: { initial: Tab; disableLog: boolean }) {
  const [tab, setTab] = useState<Tab>(initial);
  return (
    <Tabs<Tab>
      label="Files of the run"
      value={tab}
      onValueChange={setTab}
      items={[
        { value: "diff", label: "Diff", content: <CodeBlock label="Diff" diff text={diff("python3Packages.wassima")} /> },
        { value: "checks", label: "Checks 2/2", content: <p>The checks.</p> },
        { value: "log", label: "Log", content: <p>The log.</p>, disabled: disableLog },
        { value: "description", label: "Description", content: <CodeBlock label="Description" wrap text={description("python3Packages.wassima")} /> },
      ]}
    />
  );
}

const meta = {
  title: "Components/Tabs",
  component: Example,
  args: { initial: "diff", disableLog: false },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const SecondTab: Story = { args: { initial: "description" } };
export const DisabledTab: Story = { args: { disableLog: true } };
