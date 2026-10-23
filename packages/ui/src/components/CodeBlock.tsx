import { useLayoutEffect, useRef } from "react";
import { ScrollArea } from "@base-ui/react/scroll-area";
import { cx } from "../format.ts";
import { Notice } from "./Notice.tsx";
import "./CodeBlock.css";

export interface CodeBlockProps {
  label: string;
  text: string | null;
  diff?: boolean | undefined;
  wrap?: boolean | undefined;
  loading?: boolean | undefined;
  error?: string | null | undefined;
  empty?: string | undefined;
  follow?: boolean | undefined;
  maxHeight?: string | undefined;
}

function lineClass(line: string): string | undefined {
  if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("+++ ") || line.startsWith("--- ")) return "is-file";
  if (line.startsWith("@@")) return "is-hunk";
  if (line.startsWith("+")) return "is-add";
  if (line.startsWith("-")) return "is-del";
  return undefined;
}

export function CodeBlock({ label, text, diff = false, wrap = false, loading = false, error, empty = "No text.", follow = false, maxHeight = "28rem" }: CodeBlockProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    const el = viewport.current;
    if (follow && el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [follow, text]);
  if (error) return <Notice tone="error">{error}</Notice>;
  if (text === null) return <p className="ui-code-status">{loading ? "Loading…" : empty}</p>;
  if (text === "") return <p className="ui-code-status">{empty}</p>;
  const body = diff
    ? text.split("\n").map((line, i) => (
        <span key={i} className={cx("ui-code-line", lineClass(line))}>
          {line}
          {"\n"}
        </span>
      ))
    : text;
  return (
    <ScrollArea.Root className="ui-code">
      <ScrollArea.Viewport
        ref={viewport}
        tabIndex={0}
        aria-label={label}
        className="ui-code-viewport"
        style={{ maxHeight }}
        onScroll={(event) => {
          const el = event.currentTarget;
          atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        <ScrollArea.Content className="ui-code-content">
          <pre className={cx("ui-pre", diff && "is-diff", wrap && "is-wrap")}>{body}</pre>
        </ScrollArea.Content>
      </ScrollArea.Viewport>
      <ScrollArea.Scrollbar orientation="vertical" className="ui-scrollbar">
        <ScrollArea.Thumb className="ui-scrollbar-thumb" />
      </ScrollArea.Scrollbar>
      <ScrollArea.Scrollbar orientation="horizontal" className="ui-scrollbar">
        <ScrollArea.Thumb className="ui-scrollbar-thumb" />
      </ScrollArea.Scrollbar>
      <ScrollArea.Corner />
    </ScrollArea.Root>
  );
}
