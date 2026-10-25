import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, waitFor } from "storybook/test";
import { RunControl } from "./RunControl.tsx";
import { withMock } from "../mock/client.tsx";
import { CAMPAIGN, at, job, task } from "../mock/fixtures.ts";

const A = "python3Packages.wassima";

const meta = {
  title: "Views/Run control",
  component: RunControl,
  args: { campaign: "cacert", branch: A, jobs: { jobs: [], queue: [], fleet: false }, onJobs: fn() },
  decorators: [withMock(() => ({ campaigns: [{ campaign: CAMPAIGN, synced: at(5), tasks: [task(A), task("anki")] }], fleetDelay: 60_000 }))],
} satisfies Meta<typeof RunControl>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The control of a branch: an optional question and the Run button. */
export const Branch: Story = {};

export const InTheQueue: Story = {
  args: { jobs: { jobs: [], queue: ["calibre", A], fleet: true } },
  play: async ({ canvas }) => {
    await canvas.findByText("The branch is in the queue.");
    await canvas.findByText("The queue has 1 entry before this branch.");
  },
};

export const WithAJob: Story = {
  args: { jobs: { jobs: [job(A, 3)], queue: [], fleet: true } },
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("button", { name: "Stop" })).toBeEnabled();
    await expect(canvas.getByRole("button", { name: "Run" })).toBeDisabled();
  },
};

/** The control of the campaign page: a key field. A new key must have a text, and a key with incorrect signs stops the button. */
export const KeyField: Story = {
  args: { branch: null, known: new Set([A, "anki"]) },
  play: async ({ canvas, userEvent, args }) => {
    const key = await canvas.findByRole("textbox", { name: "Key" });
    await canvas.findByText("Write the key of the branch.");
    await userEvent.type(key, "a b");
    await canvas.findByText(/^A key has only the signs/);
    await userEvent.clear(key);
    await userEvent.type(key, "anki");
    await canvas.findByText("A run of the branch anki. The text is a question.");
    await userEvent.click(canvas.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(args.onJobs).toHaveBeenCalled());
  },
};
