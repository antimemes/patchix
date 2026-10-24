// This script records the tour of the patchix web page for the top of the README: `tour.mp4`.
//
// Use: `node docs/tour.mjs <base URL> [output directory] [--light]`. Without an output directory, the script writes the
// file into the directory of the script. The page shows its `dark` colors; `--light` gives the `light` colors.
// For example:
//   `nix-shell -p nodejs chromium ffmpeg dejavu_fonts --run 'node docs/tour.mjs http://127.0.0.1:8788/'`
// The variables `CHROMIUM` and `FFMPEG` give different commands.
//
// RULE: the server shows live data. The tour must not change the data.
// Do not click a button that starts an operation: `Queue`, `Queue selected`, `Queue again`, `Clear queue`,
// `Remove from queue`, `Stop`, `Sync`, `Refresh`, `Fetch base`, `Ask`, `Save draft`, `Make draft`, `Make worktree`,
// `Remove worktree`, `Create pull request`.
// Do not type in the draft. Do not change the labels.
// Only open pages, select tabs, open disclosures, type in `Filter attributes`, move the pointer and move up and down.
// The script also stops each request that is not GET.
// It stops the tour when a click is not on the correct part of the page.
//
// The data is live. When no task has the state `ready`, the tour shows only step 1. The script writes the cause to
// `stderr`.

import { spawn, spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const light = args.includes("--light");
const [baseArg, outArg] = args.filter((a) => a !== "--light");
if (baseArg === undefined) {
  console.error("Usage: node docs/tour.mjs <base URL> [output directory] [--light]");
  process.exit(2);
}
const base = baseArg.replace(/\/+$/, "");
const outDir = resolve(outArg ?? dirname(fileURLToPath(import.meta.url)));
const WIDTH = 1280;
const HEIGHT = 800;
const FPS = 30;
// The task of step 2, when its state is `ready`. If not, step 2 shows the first task with the state `ready`.
const PREFERRED_TASK = "pgsql-tools";

// The text of each control that the tour must not click.
const FORBIDDEN = /^(Queue|Queue selected.*|Queue again|Clear queue|Remove from queue|Stop|Sync|Refresh|Fetch base|Ask.*|Save draft|Discard changes|Make draft.*|Make worktree|Remove worktree|Create pull request|Update pull request|Replace|×)$/;

const work = mkdtempSync(join(tmpdir(), "patchix-tour-"));
const frames = join(work, "frames");
mkdirSync(frames);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `chromium --headless` writes the port of the protocol to `stderr`.
const chromium = spawn(process.env.CHROMIUM ?? "chromium", [
  "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${join(work, "profile")}`, "--hide-scrollbars",
  "--no-first-run", "--no-default-browser-check", `--window-size=${WIDTH},${HEIGHT}`, "--force-color-profile=srgb", "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
const port = await new Promise((res, rej) => {
  let err = "";
  chromium.stderr.on("data", (d) => {
    err += d;
    const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(err);
    if (m) res(m[1]);
  });
  chromium.on("exit", (code) => rej(new Error(`chromium stopped with exit code ${code}: ${err}`)));
});

const blocked = [];
let ws;
try {
  const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (d) => (d.error ? rej(new Error(`${method}: ${d.error.message}`)) : res(d.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    });

  // `latest` is the newest `frame` of `Page.startScreencast`. The interval writes it `FPS` times each second.
  let latest = null;
  let latestSeq = 0;
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id !== undefined && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    } else if (d.method === "Page.screencastFrame") {
      latest = Buffer.from(d.params.data, "base64");
      latestSeq++;
      void send("Page.screencastFrameAck", { sessionId: d.params.sessionId });
    } else if (d.method === "Fetch.requestPaused") {
      const { requestId, request } = d.params;
      if (request.method === "GET" || request.method === "HEAD") {
        void send("Fetch.continueRequest", { requestId });
      } else {
        blocked.push(`${request.method} ${request.url}`);
        console.error(`blocked: ${request.method} ${request.url}`);
        void send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
      }
    }
  };

  await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: light ? "light" : "dark" }, { name: "prefers-reduced-motion", value: "no-preference" }] });
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `(${pageHelpers.toString()})()` });

  const js = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${expression}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const waitFor = async (expression, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await js(`!!(${expression})`)) return;
      await sleep(100);
    }
    throw new Error(`not found in ${ms} ms: ${expression}`);
  };
  const q = (s) => JSON.stringify(s);

  // `moveTo` moves the pointer on a curve to a point. The page does not show the pointer.
  let mouse = { x: WIDTH / 2, y: HEIGHT / 2 };
  const moveTo = async (x, y, ms = 450) => {
    const steps = Math.max(4, Math.round(ms / 30));
    const from = mouse;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      mouse = { x: from.x + (x - from.x) * e, y: from.y + (y - from.y) * e };
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: mouse.x, y: mouse.y });
      await sleep(ms / steps);
    }
  };
  // `target` is an expression of the page that gives one node.
  // The click occurs only when the point is on that node, and when the text of the control is not in `FORBIDDEN`.
  const point = async (target) => {
    const p = await js(`__tour.point(${target})`);
    if (p === null) throw new Error(`no element: ${target}`);
    return p;
  };
  const hover = async (target, ms) => {
    const p = await point(target);
    await moveTo(p.x, p.y, ms);
  };
  const click = async (target, ms) => {
    await hover(target, ms);
    const check = await js(`__tour.check(${target}, ${mouse.x}, ${mouse.y})`);
    if (check !== "ok") throw new Error(`no click on ${target}: ${check}`);
    const labels = await js(`[__tour.label(${target}), __tour.label(document.elementFromPoint(${mouse.x}, ${mouse.y}))]`);
    if (labels.some((l) => FORBIDDEN.test(l))) throw new Error(`forbidden click: ${labels.join(" / ")}`);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: mouse.x, y: mouse.y, button: "left", clickCount: 1 });
    await sleep(70);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: mouse.x, y: mouse.y, button: "left", clickCount: 1 });
  };
  const key = async (name, code, times = 1, ms = 110) => {
    for (let i = 0; i < times; i++) {
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
      await sleep(ms);
    }
  };
  // `to` has numbers or page expressions for `top` and `left`, and a text for `text`.
  const scroll = (scroller, to, ms) => {
    const fields = Object.entries(to).map(([k, v]) => `${k}: ${k === "text" ? q(v) : v}`);
    return js(`__tour.scroll(${scroller}, { ${fields.join(", ")} }, ${ms})`);
  };
  const tabEl = (label, prefix = false) => `__tour.find('[role="tab"]', ${q(label)}, ${prefix})`;

  const CAMPAIGN = "cacert";
  const api = async (path) => {
    const r = await fetch(`${base}/api/campaigns/${CAMPAIGN}${path}`);
    if (!r.ok) throw new Error(`GET ${path}: HTTP ${r.status}`);
    return r.json();
  };
  const found = async (expression, ms) => {
    try {
      await waitFor(expression, ms);
      return true;
    } catch {
      return false;
    }
  };
  const { tasks } = await api("");
  const ready = tasks.find((t) => t.state === "ready" && t.attr === PREFERRED_TASK) ?? tasks.find((t) => t.state === "ready");
  if (ready === undefined) console.error("No task is ready. The tour does not show step 2.");

  // The script opens the task list of `cacert` before it starts to record: the jobs show at the start of the
  // video.
  await send("Page.navigate", { url: `${base}/c/${CAMPAIGN}` });
  await waitFor(`__tour.find(".ui-filter-chip", "ready", true) && document.querySelectorAll("tbody tr").length > 20`);
  await found(`document.querySelector(".jobs-strip .job")`, 3000);
  await sleep(800);

  await send("Page.startScreencast", { format: "png", maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 });
  while (latest === null) await sleep(20);
  const start = Date.now();
  let written = 0;
  let lastSeq = -1;
  const clock = setInterval(() => {
    const due = Math.floor(((Date.now() - start) * FPS) / 1000);
    while (written <= due) {
      const file = join(frames, `f${String(written).padStart(5, "0")}.png`);
      if (latestSeq === lastSeq && written > 0) linkSync(join(frames, `f${String(written - 1).padStart(5, "0")}.png`), file);
      else writeFileSync(file, latest);
      lastSeq = latestSeq;
      written++;
    }
  }, 10);

  // 1. The task list of `cacert` (3 s): the jobs, the queue and the fleet. Then move down the table to the task of
  // step 2 and open that task.
  await sleep(1300);
  await moveTo(WIDTH / 2, 640, 300);
  if (ready !== undefined) {
    const row = `__tour.find("tbody a", ${q(ready.attr)})`;
    await scroll("null", { top: `__tour.top(${row}) - 420` }, 900);
    await click(row, 400);
  } else {
    await scroll("null", { top: 520 }, 900);
    await sleep(1500);
  }

  if (ready !== undefined) {
    // 2. The `Work` tab of the task with the state `ready` (17 s): the issue entry, the full diff, the commits and the
    // output of the check. The tabs of the run stay below the header of the page.
    const files = `document.querySelector('[role="tablist"][aria-label^="Files of run"]')`;
    await waitFor(`${tabEl("Full diff")} && __tour.textNode("diff --git")`);
    await hover(`document.querySelector('[aria-label="Issue entry"]')`, 600);
    await sleep(1400);
    // The full diff (5 s). When the page cannot show all of the diff, the diff moves down to the `postInstall`
    // lines of `pgsql-tools`, or to its end.
    await scroll("null", { top: `__tour.top(${files}) - 64` }, 1000);
    const diffBox = `__tour.scroller(__tour.textNode("diff --git"))`;
    if (await js(`!!${diffBox}`)) {
      const to = (await js(`!!__tour.textNode("postInstall", ${diffBox})`)) ? { text: "postInstall", offset: 260 } : { top: `${diffBox}.scrollHeight` };
      await scroll(diffBox, to, 1300);
    }
    await sleep(4000);

    // `Commits` (3 s): the message of each commit, with its last line, for example `Assisted-by:`.
    await click(tabEl("Commits"), 450);
    const message = `document.querySelector(".commit-message")`;
    if (await found(message, 4000)) {
      const below = `__tour.top(${message}) + ${message}.offsetHeight - scrollY - ${HEIGHT - 60}`;
      if ((await js(below)) > 0) await scroll("null", { top: `scrollY + ${below}` }, 600);
    }
    await sleep(3000);

    // `Checks` (4 s): the output of the check moves down to the `VERDICT` lines.
    await click(tabEl("Checks", true), 450);
    await scroll("null", { top: `__tour.top(${files}) - 64` }, 400);
    if (await found(`__tour.textNode("VERDICT")`, 6000)) {
      const out = `__tour.scroller(__tour.textNode("VERDICT"))`;
      if (await js(`!!${out}`)) await scroll(out, { text: "VERDICT", offset: 90 }, 1300);
    } else {
      console.error("The output of the check has no `VERDICT` line.");
    }
    await sleep(3000);

    // 3. The `Publish` tab (16 s): the draft and the `Preview` with the AI disclosure and the output of the check.
    // Then the labels and the button that makes the pull request. The tour stops on that button.
    await scroll("null", { top: 0 }, 700);
    await click(tabEl("Publish"), 400);
    await waitFor(`document.querySelector(".publish-preview details")`);
    await sleep(1800);
    const preview = `document.querySelector(".publish-preview")`;
    const alert = `document.querySelector(".publish-preview .md-alert")`;
    const summary = `document.querySelector(".publish-preview details > summary")`;
    if (await js(`!!${alert}`)) {
      await scroll(preview, { top: `__tour.within(${preview}, ${alert}) - 70` }, 900);
      await sleep(2000);
    }
    await scroll(preview, { top: `__tour.within(${preview}, ${summary}) - 160` }, 700);
    await click(summary, 400);
    await sleep(500);
    await scroll(preview, { top: `__tour.within(${preview}, ${summary}) - 20` }, 900);
    await sleep(2200);
    await click(`document.querySelector(".ui-labels-input")`, 500);
    await waitFor(`document.querySelector(".ui-labels-popup")`, 4000);
    await sleep(1600);
    await key("Escape", 27);
    await sleep(200);
    // The pointer stops on `Create pull request`. The tour does not click it.
    const create = `__tour.find("button", "Create pull request")`;
    await scroll("null", { top: `__tour.top(${create}) - 600` }, 700);
    if (await js(`${create}.disabled`)) console.error("The button `Create pull request` is disabled.");
    await hover(create, 500);
    await sleep(2500);
  }

  clearInterval(clock);
  await send("Page.stopScreencast");
  console.log(`${written} frames, ${(written / FPS).toFixed(1)} s`);
  if (blocked.length > 0) throw new Error(`the page sent ${blocked.length} requests that are not GET`);

  const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
  const run = (args) => {
    const r = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`ffmpeg stopped with exit code ${r.status}`);
  };
  run(["-framerate", String(FPS), "-i", join(frames, "f%05d.png"), "-c:v", "libx264", "-preset", "slow", "-crf", "24", "-tune", "animation", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(outDir, "tour.mp4")]);
  console.log(`wrote ${join(outDir, "tour.mp4")}`);
} finally {
  ws?.close();
  if (chromium.exitCode === null) {
    const exited = new Promise((r) => chromium.once("exit", r));
    chromium.kill();
    await exited;
  }
  if (process.env.KEEP_FRAMES === undefined) rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  else console.log(`frames: ${frames}`);
}

// The functions in the page. Each one gives a value that the protocol can send back.
function pageHelpers() {
  // The files of a run contain full paths, for example the worktree in the output of a check. The page shows `~`
  // for `/home/<user>`. The data does not change.
  const home = /\/home\/[^/\s"'<>`]+/g;
  const text = Response.prototype.text;
  Response.prototype.text = async function () {
    return (await text.call(this)).replace(home, "~");
  };
  Response.prototype.json = async function () {
    return JSON.parse(await this.text());
  };
  const visible = (el) => el instanceof Element && el.getClientRects().length > 0;
  window.__tour = {
    // `find` gives the first node of `selector` that shows on the page and has the text `text`.
    // `prefix`: the text starts with `text`. `inside`: the text contains `text`.
    find(selector, text, prefix = false, inside = false) {
      for (const el of document.querySelectorAll(selector)) {
        const t = el.textContent.trim();
        if (visible(el) && (inside ? t.includes(text) : prefix ? t.startsWith(text) : t === text)) return el;
      }
      return null;
    },
    // `textNode` gives the first text node in `root` that shows on the page and contains `text`.
    textNode(text, root = document.body) {
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n !== null; n = walk.nextNode()) {
        if (n.data.includes(text) && visible(n.parentElement)) return n;
      }
      return null;
    },
    scroller(node) {
      for (let el = node?.parentElement ?? null; el !== null; el = el.parentElement) {
        const s = getComputedStyle(el).overflowY;
        if ((s === "auto" || s === "scroll") && el.scrollHeight > el.clientHeight) return el;
      }
      return null;
    },
    top(el) {
      return el.getBoundingClientRect().top + scrollY;
    },
    within(scroller, el) {
      return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    },
    point(el) {
      if (!visible(el)) return null;
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > innerHeight) el.scrollIntoView({ block: "center" });
      const s = el.getBoundingClientRect();
      const x = el instanceof HTMLInputElement ? s.left + Math.min(40, s.width / 2) : s.left + s.width / 2;
      return { x, y: s.top + s.height / 2 };
    },
    check(el, x, y) {
      const hit = document.elementFromPoint(x, y);
      if (hit === null || !(el === hit || el.contains(hit) || hit.contains(el))) return `the point is on ${hit?.outerHTML.slice(0, 80)}`;
      return "ok";
    },
    label(el) {
      const control = el.closest("button, a, [role='tab'], summary, input, textarea") ?? el;
      return control instanceof HTMLInputElement ? "" : control.textContent.trim();
    },
    // Scroll `scroller` (the page when it is null) with an easing curve. `to.top` and `to.left` are numbers; `to.text`
    // scrolls to the first line in `scroller` with that text, `to.offset` pixels below the top.
    scroll(scroller, to, ms) {
      const el = scroller ?? document.scrollingElement;
      let top = to.top ?? el.scrollTop;
      if (to.text !== undefined) {
        const node = window.__tour.textNode(to.text, scroller ?? document.body);
        const range = document.createRange();
        const at = node.data.indexOf(to.text);
        range.setStart(node, at);
        range.setEnd(node, at + to.text.length);
        const base = scroller === null ? 0 : el.getBoundingClientRect().top;
        top = el.scrollTop + range.getBoundingClientRect().top - base - (to.offset ?? 0);
      }
      const left = to.left ?? el.scrollLeft;
      const fromTop = el.scrollTop;
      const fromLeft = el.scrollLeft;
      const t0 = performance.now();
      return new Promise((res) => {
        const step = (now) => {
          const t = Math.min(1, (now - t0) / ms);
          const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
          el.scrollTop = fromTop + (top - fromTop) * e;
          el.scrollLeft = fromLeft + (left - fromLeft) * e;
          if (t < 1) requestAnimationFrame(step);
          else res(true);
        };
        requestAnimationFrame(step);
      });
    },
  };
}
