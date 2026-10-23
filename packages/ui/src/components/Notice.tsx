import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import "./Notice.css";

export interface NoticeProps extends useRender.ComponentProps<"div"> {
  tone?: "error" | "warning" | "info" | "success" | undefined;
}

export function Notice({ tone = "info", render, ...props }: NoticeProps) {
  const own: useRender.ElementProps<"div"> = { className: `ui-notice ui-notice--${tone}`, role: tone === "error" ? "alert" : "status" };
  return useRender({ defaultTagName: "div", render, props: mergeProps<"div">(own, props) });
}
