import { useMemo } from "react";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { Marked } from "marked";
import "./Markdown.css";

/** GitHub-flavored Markdown. In a pull request description, GitHub also makes a line break of each new line. */
const markdown = new Marked({ gfm: true, breaks: true, async: false });

const ALERTS: Readonly<Record<string, string>> = { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" };

/** `clean` removes the HTML parts of `DROP` and the text in them. It replaces each other part that is not in `KEEP` with the text in it. */
const DROP = new Set(["script", "style", "iframe", "frame", "object", "embed", "form", "button", "select", "textarea", "link", "meta", "base", "svg", "math", "template", "noscript"]);
const KEEP = new Set(
  "a b blockquote br code dd del details div dl dt em h1 h2 h3 h4 h5 h6 hr i img input ins kbd li ol p pre s span strong sub summary sup table tbody td tfoot th thead tr ul".split(" "),
);
const ATTRIBUTES = new Set(["href", "src", "alt", "title", "align", "type", "checked", "disabled", "open", "start", "colspan", "rowspan", "class"]);

/** A URL is permitted when it starts with `http:`, `https:` or `mailto:`, or when it has no `<name>:` part at its start. */
function safeUrl(url: string): boolean {
  const scheme = /^\s*([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  return scheme === undefined || scheme === "http" || scheme === "https" || scheme === "mailto";
}

/**
 * Removes the elements and the attributes that a pull request description does not need. The descriptions come
 * from the server, but the agent wrote them after it read the package sources: do not execute their HTML.
 */
function clean(root: ParentNode): void {
  for (const el of [...root.querySelectorAll("*")]) {
    const tag = el.tagName.toLowerCase();
    if (DROP.has(tag)) {
      el.remove();
      continue;
    }
    if (!KEEP.has(tag) || (tag === "input" && el.getAttribute("type") !== "checkbox")) {
      el.replaceWith(...el.childNodes);
      continue;
    }
    for (const { name, value } of [...el.attributes]) {
      const keep = ATTRIBUTES.has(name) && ((name !== "href" && name !== "src") || safeUrl(value)) && (name !== "class" || /^language-[\w-]+$/.test(value));
      if (!keep) el.removeAttribute(name);
    }
    if (tag === "input") el.setAttribute("disabled", "");
    if (tag === "a") {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
  }
}

/**
 * The GitHub `[!NOTE]` blocks: a `blockquote` with `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]` on
 * its first line becomes `<div class="md-alert md-alert--warning">` with a title. marked does not know this syntax.
 */
function alerts(root: ParentNode): void {
  for (const quote of [...root.querySelectorAll("blockquote")]) {
    const p = quote.firstElementChild;
    const first = p?.firstChild;
    if (p?.tagName !== "P" || first?.nodeType !== Node.TEXT_NODE) continue;
    const m = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i.exec(first.textContent ?? "");
    const kind = m?.[1]?.toLowerCase();
    if (m === null || kind === undefined) continue;
    first.textContent = (first.textContent ?? "").slice(m[0].length);
    if (first.textContent === "" && first.nextSibling?.nodeName === "BR") first.nextSibling.remove();
    if ((p.textContent ?? "").trim() === "" && p.children.length === 0) p.remove();
    const box = document.createElement("div");
    box.className = `md-alert md-alert--${kind}`;
    const title = document.createElement("p");
    title.className = "md-alert-title";
    title.textContent = ALERTS[kind] ?? kind;
    box.append(title, ...quote.childNodes);
    quote.replaceWith(box);
  }
}

/** The HTML of the Markdown text, as GitHub shows it. The `[!NOTE]` blocks get their colors, and the dangerous HTML is removed. */
export function renderMarkdown(text: string): string {
  const template = document.createElement("template");
  template.innerHTML = markdown.parse(text, { async: false });
  clean(template.content);
  alerts(template.content);
  return template.innerHTML;
}

export interface MarkdownProps extends Omit<useRender.ComponentProps<"div">, "children" | "dangerouslySetInnerHTML"> {
  text: string;
}

/** The Markdown text as HTML in a `div`. With `aria-label`, the `div` is a `region`. */
export function Markdown({ text, render, ...props }: MarkdownProps) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const own = { className: "ui-markdown", role: props["aria-label"] === undefined ? undefined : "region", dangerouslySetInnerHTML: { __html: html } };
  return useRender({ defaultTagName: "div", render, props: mergeProps<"div">(own, props) });
}
