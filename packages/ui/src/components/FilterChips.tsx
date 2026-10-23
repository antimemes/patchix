import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type { Tone } from "./Badge.tsx";
import "./FilterChips.css";

export interface ChipOption<V extends string> {
  value: V;
  label: string;
  count?: number | undefined;
  tone?: Tone | undefined;
}

export interface FilterChipsProps<V extends string> {
  label: string;
  options: readonly ChipOption<V>[];
  value: readonly V[];
  onValueChange: (value: V[]) => void;
}

export function FilterChips<V extends string>({ label, options, value, onValueChange }: FilterChipsProps<V>) {
  return (
    <ToggleGroup<V> multiple aria-label={label} value={value} onValueChange={(v) => onValueChange(v)} className="ui-filter-chips">
      {options.map((o) => (
        <Toggle<V> key={o.value} value={o.value} className={`ui-filter-chip ui-filter-chip--${o.tone ?? "grey"}`}>
          {o.label}
          {o.count !== undefined && <span className="ui-filter-chip-count">{o.count}</span>}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
