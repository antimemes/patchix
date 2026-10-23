import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { Checkbox, CheckboxGroup } from "./Checkbox.tsx";

const meta = {
  title: "Components/Checkbox",
  component: Checkbox,
  args: { label: "Select python3Packages.wassima", onCheckedChange: fn() },
} satisfies Meta<typeof Checkbox>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Unchecked: Story = {};
export const Checked: Story = { args: { defaultChecked: true } };
export const Indeterminate: Story = { args: { checked: false, indeterminate: true, label: "Select the 12 shown tasks" } };
export const Disabled: Story = { args: { disabled: true, label: "Select the 0 shown tasks" } };
export const WithoutLabel: Story = { args: { label: undefined, "aria-label": "Select akkoma" } };

type Examined = "diff" | "checks" | "description" | "build";
function GroupExample() {
  const [value, setValue] = useState<Examined[]>(["diff", "checks"]);
  return (
    <CheckboxGroup<Examined>
      label="Examined"
      options={[
        { value: "diff", label: "Diff" },
        { value: "checks", label: "Checks" },
        { value: "description", label: "Description" },
        { value: "build", label: "Build" },
      ]}
      value={value}
      onValueChange={setValue}
    />
  );
}
export const Group: Story = { render: () => <GroupExample /> };
