import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.tsx"],
  framework: { name: "@storybook/react-vite", options: {} },
  core: { disableTelemetry: true },
  /** Base UI puts "use client" in each module. Do not show a warning for each module. */
  viteFinal(vite) {
    const options = vite.build?.rolldownOptions;
    return {
      ...vite,
      build: {
        ...vite.build,
        chunkSizeWarningLimit: 4000,
        rolldownOptions: {
          ...options,
          onwarn(warning, warn) {
            if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
            if (options?.onwarn) options.onwarn(warning, warn);
            else warn(warning);
          },
        },
      },
    };
  },
};

export default config;
