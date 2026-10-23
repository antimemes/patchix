import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChipsInput } from "./ChipsInput.tsx";

function Example({ initial, disabled }: { initial: string[]; disabled?: boolean }) {
  const [values, setValues] = useState(initial);
  return (
    <div style={{ maxWidth: 420 }}>
      <ChipsInput label="Labels" values={values} onValueChange={setValues} placeholder="Add a label, then Enter" description="Enter or a comma adds the text." disabled={disabled} />
    </div>
  );
}

const meta = {
  title: "Components/ChipsInput",
  component: Example,
  args: { initial: ["1.severity: security", "6.topic: python"] },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WithValues: Story = {};
export const Empty: Story = { args: { initial: [] } };
export const Disabled: Story = { args: { disabled: true } };
