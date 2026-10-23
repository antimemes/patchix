import { useMemo, type ReactNode } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { Field } from "@base-ui/react/field";
import type { Label } from "@patchix/common";
import "./Popup.css";
import "./LabelsPicker.css";

export interface LabelsPickerProps {
  label: ReactNode;
  /** The labels of the repository. */
  options: readonly Label[];
  value: readonly string[];
  onValueChange: (value: string[]) => void;
  description?: ReactNode;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
}

/** The color of a label. */
function Swatch({ color }: { color: string | undefined }) {
  const valid = color !== undefined && /^[0-9a-f]{6}$/i.test(color);
  return <span className="ui-labels-swatch" style={valid ? { background: `#${color}` } : undefined} aria-hidden />;
}

/**
 * A list of the labels of a repository. A person types a part of a name to find a label. The selected labels show as
 * chips.
 * A selected label that is not in `options` stays in the list: for example a label of the campaign when `gh` did not
 * give the list.
 */
export function LabelsPicker({ label, options, value, onValueChange, description, placeholder = "Search the labels", disabled }: LabelsPickerProps) {
  const byName = useMemo(() => new Map(options.map((o) => [o.name, o])), [options]);
  const items = useMemo(() => [...new Set([...value, ...options.map((o) => o.name)])], [options, value]);
  return (
    <Field.Root disabled={disabled} className="ui-field">
      <Field.Label className="ui-field-label">{label}</Field.Label>
      <Combobox.Root items={items} multiple value={[...value]} onValueChange={(next: string[]) => onValueChange(next)} disabled={disabled}>
        <Combobox.InputGroup className="ui-labels">
          <Combobox.Chips className="ui-labels-chips" aria-label={value.length > 0 ? "Chosen labels" : undefined}>
            {value.map((name) => (
              <Combobox.Chip key={name} className="ui-labels-chip" aria-label={name}>
                <Swatch color={byName.get(name)?.color} />
                {name}
                <Combobox.ChipRemove className="ui-labels-remove" aria-label={`Remove ${name}`}>
                  ×
                </Combobox.ChipRemove>
              </Combobox.Chip>
            ))}
            <Combobox.Input placeholder={value.length === 0 ? placeholder : undefined} className="ui-labels-input" />
          </Combobox.Chips>
        </Combobox.InputGroup>
        <Combobox.Portal>
          <Combobox.Positioner sideOffset={4} collisionPadding={8} className="ui-positioner">
            <Combobox.Popup className="ui-labels-popup">
              <Combobox.Empty className="ui-labels-empty">No label agrees with the text.</Combobox.Empty>
              <Combobox.List className="ui-labels-list">
                {(name: string) => {
                  const info = byName.get(name);
                  return (
                    <Combobox.Item key={name} value={name} className="ui-labels-item">
                      <Combobox.ItemIndicator className="ui-labels-indicator">✓</Combobox.ItemIndicator>
                      <Swatch color={info?.color} />
                      <span className="ui-labels-name">{name}</span>
                      {info !== undefined && info.description !== "" && <span className="ui-labels-description">{info.description}</span>}
                    </Combobox.Item>
                  );
                }}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
      {description !== undefined && <Field.Description className="ui-field-description">{description}</Field.Description>}
    </Field.Root>
  );
}
