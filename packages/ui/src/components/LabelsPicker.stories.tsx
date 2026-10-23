import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Label } from "@patchix/common";
import { LabelsPicker } from "./LabelsPicker.tsx";
import { LABELS } from "../mock/fixtures.ts";

function Example({ initial, options, disabled }: { initial: string[]; options: Label[]; disabled?: boolean }) {
  const [value, setValue] = useState(initial);
  return (
    <div style={{ maxWidth: 460 }}>
      <LabelsPicker
        label="Labels"
        options={options}
        value={value}
        onValueChange={setValue}
        disabled={disabled}
        description="Type to search the labels of the repository. Backspace removes the last label."
      />
    </div>
  );
}

const meta = {
  title: "Components/LabelsPicker",
  component: Example,
  args: { initial: ["1.severity: security"], options: LABELS },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WithValue: Story = {};
export const Empty: Story = { args: { initial: [] } };
export const Searching: Story = {
  parameters: { docs: { description: { story: "The text 'topic' shows only the topic labels. The chosen labels have a tick." } } },
  args: { initial: ["1.severity: security", "6.topic: python"] },
  play: async ({ canvas, userEvent }) => {
    await userEvent.type(await canvas.findByRole("combobox"), "topic");
  },
};
export const NotInTheList: Story = {
  parameters: { docs: { description: { story: "gh did not give the labels: the chosen labels of the campaign stay, without a color." } } },
  args: { initial: ["1.severity: security"], options: [] },
};
export const Disabled: Story = { args: { disabled: true } };
