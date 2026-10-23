/** Makes `dist/app.js` and `dist/app.css` from `src/main.tsx` with esbuild, and copies `src/index.html`. With `--watch`, it makes them again after each change. */
import { build, context, type BuildOptions, type Plugin } from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = import.meta.dirname;
const dist = join(root, "dist");
const watch = process.argv.includes("--watch");

const html: Plugin = {
  name: "index.html",
  setup(b) {
    b.onEnd(async (result) => {
      if (result.errors.length > 0) return;
      await mkdir(dist, { recursive: true });
      await copyFile(join(root, "src", "index.html"), join(dist, "index.html"));
    });
  },
};

const options: BuildOptions = {
  absWorkingDir: root,
  entryPoints: { app: "src/main.tsx" },
  outdir: "dist",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  minify: !watch,
  sourcemap: true,
  legalComments: "none",
  logLevel: "info",
  define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
  plugins: [html],
};

await rm(dist, { recursive: true, force: true });
if (watch) {
  await (await context(options)).watch();
} else {
  await build(options);
}
