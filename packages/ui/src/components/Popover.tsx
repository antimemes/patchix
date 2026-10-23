import type { ReactElement, ReactNode } from "react";
import { Popover as BasePopover } from "@base-ui/react/popover";
import "./Popup.css";

export interface PopoverProps {
  trigger: ReactElement;
  title?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean | undefined;
}

export function Popover({ trigger, title, children, defaultOpen }: PopoverProps) {
  return (
    <BasePopover.Root defaultOpen={defaultOpen}>
      <BasePopover.Trigger openOnHover delay={200} render={trigger} />
      <BasePopover.Portal>
        <BasePopover.Positioner sideOffset={6} collisionPadding={8} className="ui-positioner">
          <BasePopover.Popup className="ui-popover">
            {title !== undefined && <BasePopover.Title className="ui-popover-title">{title}</BasePopover.Title>}
            {children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}
