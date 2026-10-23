import type { Meta, StoryObj } from "@storybook/react-vite";
import { Markdown } from "./Markdown.tsx";
import { description, fakeRender } from "../mock/fixtures.ts";

const ALERTS = ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"].map((k) => `> [!${k}]\n> The text of the ${k.toLowerCase()} alert.`).join("\n\n");

const TABLE = `| Path | Before | After |
|---|---|---|
| \`lib/cacert.pem\` | 146 roots | symlink to \`cacert\` |
| \`share/ca.crt\` | 140 roots | removed |`;

const UNSAFE = `<img src="data:," onerror="alert(1)" alt="an image without its file">

<script>alert(2)</script>

<a href="javascript:alert(3)">A link without its URL</a>`;

const meta = {
  title: "Components/Markdown",
  component: Markdown,
  args: { "aria-label": "Preview", text: fakeRender(description("python3Packages.wassima"), "python3Packages.wassima", 580114) },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 820 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Markdown>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Description: Story = {
  parameters: { docs: { description: { story: "A rendered description: the AI disclosure alert, the check in a details block and the template list." } } },
};
export const Alerts: Story = { args: { text: ALERTS } };
export const TableAndCode: Story = { args: { text: `${TABLE}\n\n\`\`\`nix\npostInstall = ''\n  ln -sf \${cacert}/etc/ssl/certs/ca-bundle.crt $out/cacert.pem\n'';\n\`\`\`\n\nInline \`code\` and a [link](https://github.com/NixOS/nixpkgs).` } };
export const UnsafeHtml: Story = {
  parameters: { docs: { description: { story: "The preview removes scripts, event attributes and javascript: links." } } },
  args: { text: UNSAFE },
};
