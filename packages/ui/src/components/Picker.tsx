import { useMemo, useState, type ReactNode } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { Field } from "@base-ui/react/field";
import "./Field.css";
import "./Popup.css";
import "./Picker.css";

export interface PickerOption {
  value: string;
  /** A text after the value in the list, for example the state of an entry. */
  hint?: string | undefined;
}

export interface PickerProps {
  label: ReactNode;
  hideLabel?: boolean | undefined;
  options: readonly PickerOption[];
  /** The person selected a value. Then the input is empty again. */
  onPick: (value: string) => void;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  description?: ReactNode;
}

/** A text input with a list of values. A person types a part of a value to find it, and selects it. */
export function Picker({ label, hideLabel, options, onPick, placeholder, disabled, description }: PickerProps) {
  const [text, setText] = useState("");
  const hints = useMemo(() => new Map(options.map((o) => [o.value, o.hint])), [options]);
  const items = useMemo(() => options.map((o) => o.value), [options]);
  const pick = (value: string | null) => {
    if (value === null) return;
    setText("");
    onPick(value);
  };
  return (
    <Field.Root disabled={disabled} className="ui-field">
      <Field.Label className={hideLabel ? "sr-only" : "ui-field-label"}>{label}</Field.Label>
      <Combobox.Root items={items} value={null} onValueChange={pick} inputValue={text} onInputValueChange={setText} disabled={disabled}>
        <Combobox.Input placeholder={placeholder} className="ui-input ui-picker-input" />
        <Combobox.Portal>
          <Combobox.Positioner sideOffset={4} collisionPadding={8} className="ui-positioner">
            <Combobox.Popup className="ui-picker-popup">
              <Combobox.Empty className="ui-picker-empty">No value agrees with the text.</Combobox.Empty>
              <Combobox.List className="ui-picker-list">
                {(value: string) => (
                  <Combobox.Item key={value} value={value} className="ui-picker-item">
                    <span className="ui-picker-value">{value}</span>
                    {hints.get(value) !== undefined && <span className="ui-picker-hint">{hints.get(value)}</span>}
                  </Combobox.Item>
                )}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
      {description !== undefined && <Field.Description className="ui-field-description">{description}</Field.Description>}
    </Field.Root>
  );
}
