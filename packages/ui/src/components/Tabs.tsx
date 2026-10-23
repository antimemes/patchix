import type { ReactNode } from "react";
import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import "./Tabs.css";

export interface TabItem<V extends string> {
  value: V;
  label: ReactNode;
  content: ReactNode;
  disabled?: boolean | undefined;
}

export interface TabsProps<V extends string> {
  label: string;
  items: readonly TabItem<V>[];
  value: V;
  onValueChange: (value: V) => void;
  /** Keep each panel in the page when its tab is not selected. Thus its state stays, for example a change that is not on the server. */
  keepMounted?: boolean | undefined;
}

export function Tabs<V extends string>({ label, items, value, onValueChange, keepMounted }: TabsProps<V>) {
  return (
    <BaseTabs.Root value={value} onValueChange={(v) => onValueChange(v as V)} className="ui-tabs">
      <BaseTabs.List aria-label={label} className="ui-tabs-list">
        {items.map((item) => (
          <BaseTabs.Tab key={item.value} value={item.value} disabled={item.disabled} className="ui-tab">
            {item.label}
          </BaseTabs.Tab>
        ))}
        <BaseTabs.Indicator className="ui-tabs-indicator" />
      </BaseTabs.List>
      {items.map((item) => (
        <BaseTabs.Panel key={item.value} value={item.value} keepMounted={keepMounted} className="ui-tabs-panel">
          {item.content}
        </BaseTabs.Panel>
      ))}
    </BaseTabs.Root>
  );
}
