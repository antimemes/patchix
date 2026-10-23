import type { Decorator, Preview } from "@storybook/react-vite";
import "../src/theme.css";
import "./preview.css";
import { ToastProvider } from "../src/components/Toast.tsx";
import { TooltipProvider } from "../src/components/Tooltip.tsx";

const withTheme: Decorator = (Story, context) => {
  const theme: unknown = context.globals["theme"];
  document.documentElement.style.colorScheme = theme === "light" || theme === "dark" ? theme : "light dark";
  const note: unknown = context.parameters["docs"]?.description?.story;
  return (
    <TooltipProvider>
      <ToastProvider>
        {typeof note === "string" && <p className="story-note">{note}</p>}
        <Story />
      </ToastProvider>
    </TooltipProvider>
  );
};

const preview: Preview = {
  decorators: [withTheme],
  globalTypes: {
    theme: {
      description: "Color scheme",
      toolbar: {
        title: "Theme",
        icon: "mirror",
        items: [
          { value: "system", title: "System" },
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: "system" },
  parameters: { layout: "padded" },
};

export default preview;
