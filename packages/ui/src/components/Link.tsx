import type { MouseEvent } from "react";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { navigate } from "../router.ts";
import "./Link.css";

export interface LinkProps extends useRender.ComponentProps<"a"> {
  href: string;
  external?: boolean | undefined;
}

/** A link to a path of this client changes the route without a new page. */
export function Link({ render, href, external, ...props }: LinkProps) {
  const isExternal = external ?? /^https?:/.test(href);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (isExternal || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(href);
  };
  const own: useRender.ElementProps<"a"> = isExternal ? { href, className: "ui-link", target: "_blank", rel: "noreferrer" } : { href, className: "ui-link", onClick };
  return useRender({ defaultTagName: "a", render, props: mergeProps<"a">(own, props) });
}
