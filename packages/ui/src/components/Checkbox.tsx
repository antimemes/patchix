import type { ReactNode } from "react";
import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { CheckboxGroup as BaseCheckboxGroup } from "@base-ui/react/checkbox-group";
import { cx } from "../format.ts";
import "./Checkbox.css";

export interface CheckboxProps extends Omit<BaseCheckbox.Root.Props, "className" | "children"> {
  label?: ReactNode;
  className?: string | undefined;
}

export function Checkbox({ label, className, ...props }: CheckboxProps) {
  const box = (
    <BaseCheckbox.Root {...props} className={cx("ui-checkbox", label === undefined && className)}>
      <BaseCheckbox.Indicator
        className="ui-checkbox-indicator"
        render={(p, state) => (
          <span {...p}>
            <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
              {state.indeterminate ? <path d="M2 6h8" /> : <path d="M2 6.5 4.8 9 10 3" />}
            </svg>
          </span>
        )}
      />
    </BaseCheckbox.Root>
  );
  if (label === undefined) return box;
  return (
    <label className={cx("ui-checkbox-label", className)}>
      {box}
      {label}
    </label>
  );
}

export interface CheckboxGroupProps<V extends string> {
  label: ReactNode;
  options: readonly { value: V; label: ReactNode }[];
  value: readonly V[];
  onValueChange: (value: V[]) => void;
  disabled?: boolean | undefined;
}

export function CheckboxGroup<V extends string>({ label, options, value, onValueChange, disabled }: CheckboxGroupProps<V>) {
  const known = new Set<string>(options.map((o) => o.value));
  return (
    <BaseCheckboxGroup
      value={[...value]}
      onValueChange={(v) => onValueChange(v.filter((x): x is V => known.has(x)))}
      disabled={disabled}
      className="ui-checkbox-group"
      render={<fieldset />}
    >
      <legend className="ui-checkbox-group-legend">{label}</legend>
      <div className="ui-checkbox-group-items">
        {options.map((o) => (
          <Checkbox key={o.value} value={o.value} label={o.label} />
        ))}
      </div>
    </BaseCheckboxGroup>
  );
}
