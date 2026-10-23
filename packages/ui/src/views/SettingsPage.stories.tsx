import type { Meta, StoryObj } from "@storybook/react-vite";
import { SettingsPage } from "./SettingsPage.tsx";
import { withMock } from "../mock/client.tsx";
import { SETTINGS } from "../mock/fixtures.ts";

const meta = {
  title: "Storylines/Settings",
  component: SettingsPage,
} satisfies Meta<typeof SettingsPage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const GhLogin: Story = {
  parameters: { docs: { description: { story: "No fork in the settings: patchix uses the gh login. Save writes settings.yaml." } } },
  decorators: [withMock(() => ({ campaigns: [] }))],
};

export const Saved: Story = {
  parameters: { docs: { description: { story: "A person sets the fork and the concurrency, then saves." } } },
  decorators: [withMock(() => ({ campaigns: [] }))],
  play: async ({ canvas, userEvent }) => {
    await userEvent.type(await canvas.findByLabelText("nixpkgs fork"), "other");
    const concurrency = canvas.getByLabelText("concurrency");
    await userEvent.clear(concurrency);
    await userEvent.type(concurrency, "3");
    await userEvent.click(canvas.getByRole("button", { name: "Save" }));
    await canvas.findByText(/^The GitHub user of the fork\. Empty: the gh login\.$/);
  },
};

export const FixedForkNoToken: Story = {
  parameters: { docs: { description: { story: "A fork in the settings, and no GH_TOKEN in the environment of the server." } } },
  decorators: [withMock(() => ({ campaigns: [], settings: { ...SETTINGS, fork: "someone", fork_effective: "someone", concurrency: 1, token: false } }))],
};

export const NoLogin: Story = {
  parameters: { docs: { description: { story: "No fork in the settings, and gh api user gave an error." } } },
  decorators: [withMock(() => ({ campaigns: [], settings: { ...SETTINGS, fork_effective: null, token: false } }))],
};

export const Invalid: Story = {
  decorators: [withMock(() => ({ campaigns: [] }))],
  play: async ({ canvas, userEvent }) => {
    await userEvent.type(await canvas.findByLabelText("nixpkgs fork"), "not/a login");
    await canvas.findByText(/^A GitHub login/);
  },
};

export const Error: Story = { decorators: [withMock(() => ({ campaigns: [], fail: { settings: [500, "settings.yaml: concurrency: expected number"] } }))] };
