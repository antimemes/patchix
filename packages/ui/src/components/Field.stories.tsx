import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { TextArea, TextField } from "./Field.tsx";

function FieldExample(props: { label: string; initial: string; description?: string; error?: string; hideLabel?: boolean; placeholder?: string }) {
  const [value, setValue] = useState(props.initial);
  return (
    <div style={{ maxWidth: 420 }}>
      <TextField
        label={props.label}
        value={value}
        onValueChange={setValue}
        description={props.description}
        error={props.error}
        hideLabel={props.hideLabel}
        placeholder={props.placeholder}
      />
    </div>
  );
}

const meta = {
  title: "Components/Field",
  component: FieldExample,
  args: { label: "Title", initial: "python3Packages.wassima: use the CA bundle of cacert" },
} satisfies Meta<typeof FieldExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Text: Story = {};
export const WithDescription: Story = { args: { label: "Title", initial: "python3Packages.wassima: use the CA bundle of cacert", description: "The first line of the commit message of the run." } };
export const WithError: Story = { args: { label: "Title", initial: "", error: "body.title: the title is empty" } };
export const HiddenLabel: Story = { args: { label: "Filter by attribute", initial: "", hideLabel: true, placeholder: "Filter attributes" } };

function AreaExample({ initial, maxLength, mono, rows }: { initial: string; maxLength?: number; mono?: boolean; rows?: number }) {
  const [value, setValue] = useState(initial);
  return (
    <div style={{ maxWidth: 520 }}>
      <TextArea label="Question" value={value} onValueChange={setValue} maxLength={maxLength} mono={mono} rows={rows} description="A question for the agent. The agent answers in the worktree of the task." />
    </div>
  );
}
export const TextAreaWithCounter: Story = { render: () => <AreaExample initial="Does the package also read the bundle at run time?" maxLength={500} /> };
export const TextAreaOverLimit: Story = { render: () => <AreaExample initial={"The question is long. ".repeat(30)} maxLength={500} /> };
export const TextAreaMono: Story = { render: () => <AreaExample initial={"## Check\n\n{{check:harness}}\n\n{{disclosure}}"} mono rows={6} /> };
