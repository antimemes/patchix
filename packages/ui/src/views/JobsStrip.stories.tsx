import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn } from "storybook/test";
import { JobsStrip } from "./JobsStrip.tsx";
import { withMock } from "../mock/client.tsx";
import { CAMPAIGN, at, job, task } from "../mock/fixtures.ts";

const ATTRS = ["anki", "calibre", "electrum", "gajim", "zotero"];

const meta = {
  title: "Views/Jobs strip",
  component: JobsStrip,
  args: { campaign: "cacert", concurrency: 2, onJobs: fn(), view: { jobs: [], queue: [], check: [], fleet: false } },
  decorators: [withMock(() => ({ campaigns: [{ campaign: CAMPAIGN, synced: at(5), tasks: ATTRS.map((a) => task(a)), queue: ["electrum", "gajim", "zotero"] }] }))],
} satisfies Meta<typeof JobsStrip>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

/** Two runs operate, and three tasks wait. The fleet starts their runs in this sequence. */
export const RunsAndQueue: Story = {
  args: { view: { jobs: [job("anki", 4), job("calibre", 1)], queue: ["electrum", "gajim", "zotero"], check: [], fleet: true } },
};

export const QueueWithoutFleet: Story = {
  args: { view: { jobs: [], queue: ["electrum", "gajim"], check: [], fleet: false } },
};

/** The sync added a check-only run for `gajim`: its entry shows `check`. The run starts the checks of the tip, without the agent. */
export const QueuedCheck: Story = {
  args: { view: { jobs: [job("anki", 4)], queue: ["electrum", "gajim"], check: ["gajim"], fleet: true } },
  play: async ({ canvas }) => {
    const entries = await canvas.findAllByRole("listitem");
    const gajim = entries.find((e) => e.textContent?.includes("gajim"));
    await expect(gajim?.textContent).toContain("check");
    await expect(entries.find((e) => e.textContent?.includes("electrum"))?.textContent).not.toContain("check");
  },
};
