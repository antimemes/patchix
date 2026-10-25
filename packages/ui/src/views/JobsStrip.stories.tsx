import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { JobsStrip } from "./JobsStrip.tsx";
import { withMock } from "../mock/client.tsx";
import { CAMPAIGN, at, job, task } from "../mock/fixtures.ts";

const ATTRS = ["anki", "calibre", "electrum", "gajim", "zotero"];

const meta = {
  title: "Views/Jobs strip",
  component: JobsStrip,
  args: { campaign: "cacert", concurrency: 2, onJobs: fn(), view: { jobs: [], queue: [], fleet: false } },
  decorators: [withMock(() => ({ campaigns: [{ campaign: CAMPAIGN, synced: at(5), tasks: ATTRS.map((a) => task(a)), queue: ["electrum", "gajim", "zotero"] }] }))],
} satisfies Meta<typeof JobsStrip>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

/** Two runs operate, and three tasks wait. The fleet starts their runs in this sequence. */
export const RunsAndQueue: Story = {
  args: { view: { jobs: [job("anki", 4), job("calibre", 1)], queue: ["electrum", "gajim", "zotero"], fleet: true } },
};

export const QueueWithoutFleet: Story = {
  args: { view: { jobs: [], queue: ["electrum", "gajim"], fleet: false } },
};
