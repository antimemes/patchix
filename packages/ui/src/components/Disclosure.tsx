import type { ReactNode } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import "./Disclosure.css";

export interface DisclosureProps {
  label: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean | undefined;
}

export function Disclosure({ label, children, defaultOpen }: DisclosureProps) {
  return (
    <Collapsible.Root defaultOpen={defaultOpen} className="ui-disclosure">
      <Collapsible.Trigger className="ui-disclosure-trigger">
        <svg viewBox="0 0 10 10" width="8" height="8" aria-hidden="true" className="ui-disclosure-icon">
          <path d="M3 1.5 7 5l-4 3.5z" />
        </svg>
        {label}
      </Collapsible.Trigger>
      <Collapsible.Panel className="ui-disclosure-panel">{children}</Collapsible.Panel>
    </Collapsible.Root>
  );
}
