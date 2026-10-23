import type { Meta, StoryObj } from "@storybook/react-vite";
import { useToast } from "./Toast.tsx";
import { Button } from "./Button.tsx";

function Example({ title, description }: { title: string; description?: string }) {
  const toast = useToast();
  return <Button onClick={() => toast(title, description)}>Show the message</Button>;
}

const meta = {
  title: "Components/Toast",
  component: Example,
  parameters: { docs: { description: { component: "The preview decorator supplies the ToastProvider. Press the button." } } },
  args: { title: "Draft saved" },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TitleOnly: Story = {};
export const WithDescription: Story = { args: { title: "Worktree made", description: "/srv/patchix/.cache/worktrees/cacert/anki" } };
