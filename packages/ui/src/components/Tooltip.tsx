import type { ReactElement, ReactNode } from "react";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import "./Popup.css";

export interface TooltipProps {
  content: ReactNode;
  children: ReactElement;
  defaultOpen?: boolean | undefined;
}

export function Tooltip({ content, children, defaultOpen }: TooltipProps) {
  return (
    <BaseTooltip.Root defaultOpen={defaultOpen}>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner sideOffset={6} className="ui-positioner">
          <BaseTooltip.Popup className="ui-tooltip">{content}</BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <BaseTooltip.Provider delay={300}>{children}</BaseTooltip.Provider>;
}
