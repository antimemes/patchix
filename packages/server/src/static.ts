/** The files of the web client in `packages/ui/dist`. A path without a file gives `index.html`. */
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { Context } from "hono";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const PLACEHOLDER = "The web client is not built. Start `pnpm --filter @patchix/ui build`, then load this page again.\n";

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile(),
    () => false,
  );
}

async function send(path: string): Promise<Response> {
  const type = TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
  return new Response(await readFile(path), { headers: { "Content-Type": type, "Cache-Control": "no-cache" } });
}

export function web(root: string): (c: Context) => Promise<Response> {
  const dist = resolve(root, "packages", "ui", "dist");
  return async (c) => {
    const index = join(dist, "index.html");
    if (!(await isFile(index))) return c.text(PLACEHOLDER);
    let path: string;
    try {
      path = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return send(index);
    }
    const file = resolve(dist, `.${path}`);
    const safe = !path.includes("\0") && !path.split("/").includes("..") && file.startsWith(dist + sep);
    return send(safe && (await isFile(file)) ? file : index);
  };
}
