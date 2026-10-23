import type { Meta, StoryObj } from "@storybook/react-vite";
import { CampaignsPage } from "./CampaignsPage.tsx";
import { withMock } from "../mock/client.tsx";
import { CAMPAIGN, at, job, mixedTasks, okRun, task } from "../mock/fixtures.ts";

const meta = {
  title: "Storylines/Campaigns index",
  component: CampaignsPage,
} satisfies Meta<typeof CampaignsPage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const MixedCounts: Story = {
  decorators: [
    withMock(() => ({
      campaigns: [
        { campaign: CAMPAIGN, synced: at(42), tasks: mixedTasks(), jobs: [job("arduino-core", "run", 6), job("gajim", "run", 2)] },
        {
          campaign: { ...CAMPAIGN, name: "openssl-1-1", title: "Packages that still use OpenSSL 1.1", issue: { repo: "NixOS/nixpkgs", number: 269713 } },
          synced: null,
          tasks: ["nodejs_18", "mongodb-4_4", "python27"].map((a) => task(a)),
        },
        {
          campaign: { ...CAMPAIGN, name: "python-eol", title: "Python 3.9 removal", issue: { repo: "NixOS/nixpkgs", number: 551200 } },
          synced: at(60 * 24 * 3),
          tasks: [
            task("python39Packages.six", { state: "external", checked: true, pr: 552001 }),
            task("python39Packages.attrs", { state: "external", checked: true, pr: 552002 }),
            task("python39Packages.idna", { state: "ready", runs: [okRun("python39Packages.idna", 300)] }),
          ],
        },
      ],
    })),
  ],
};

export const Empty: Story = { decorators: [withMock(() => ({ campaigns: [] }))] };
export const Loading: Story = { decorators: [withMock(() => ({ campaigns: [], hang: true }))] };
export const Error: Story = { decorators: [withMock(() => ({ campaigns: [], fail: { campaigns: [500, "the state directory state/ is not readable: EACCES"] } }))] };
