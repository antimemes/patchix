import type { Meta, StoryObj } from "@storybook/react-vite";
import { Popover } from "./Popover.tsx";
import { Button } from "./Button.tsx";

const PATHS = ["/lib/calibre/calibre/ebooks/cacert.pem", "/lib/calibre/mozilla-ca.pem", "/share/calibre/certs/ca-bundle.crt"];

const meta = {
  title: "Components/Popover",
  component: Popover,
  parameters: { layout: "centered" },
  args: {
    title: "Paths of calibre",
    trigger: (
      <Button size="sm" variant="ghost">
        {PATHS.length}
      </Button>
    ),
    children: (
      <ul className="paths">
        {PATHS.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    ),
  },
} satisfies Meta<typeof Popover>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};
export const Open: Story = { args: { defaultOpen: true } };
