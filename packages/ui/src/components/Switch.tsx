import type { ReactNode } from "react";
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import "./Switch.css";

export interface SwitchProps extends Omit<BaseSwitch.Root.Props, "className" | "children"> {
  label: ReactNode;
}

export function Switch({ label, ...props }: SwitchProps) {
  return (
    <label className="ui-switch-label">
      <BaseSwitch.Root {...props} className="ui-switch">
        <BaseSwitch.Thumb className="ui-switch-thumb" />
      </BaseSwitch.Root>
      {label}
    </label>
  );
}
