import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen } from "storybook/test";
import { Picker, type PickerOption } from "./Picker.tsx";

const OPTIONS: PickerOption[] = [
  { value: "rubyPackages.algoliasearch", hint: "ready, branch rubyPackages.algoliasearch" },
  { value: "rubyPackages.certified", hint: "todo" },
  { value: "rubyPackages.excon", hint: "ready" },
  { value: "python3Packages.wassima", hint: "ready" },
  { value: "anki" },
];

function Example({ options, disabled }: { options: PickerOption[]; disabled?: boolean }) {
  const [chosen, setChosen] = useState<string[]>([]);
  return (
    <div style={{ maxWidth: 420 }}>
      <Picker label="Add entry" options={options} onPick={(v) => setChosen([...chosen, v])} placeholder="Find an attribute" disabled={disabled} description="Type a part of the attribute, then choose it." />
      <p className="small muted">Chosen: {chosen.join(", ") || "none"}</p>
    </div>
  );
}

const meta = {
  title: "Components/Picker",
  component: Example,
  args: { options: OPTIONS },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Disabled: Story = { args: { disabled: true } };
export const Choose: Story = {
  parameters: { docs: { description: { story: "The text `ruby` shows only the Ruby entries. A choice calls `onPick`, and the input is empty again." } } },
  play: async ({ canvas, userEvent }) => {
    const input = await canvas.findByRole("combobox");
    await userEvent.type(input, "ruby");
    await userEvent.click(await screen.findByRole("option", { name: /^rubyPackages\.certified/ }));
    await canvas.findByText("Chosen: rubyPackages.certified");
    await expect(input).toHaveValue("");
  },
};
