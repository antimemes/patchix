import { useState, type KeyboardEvent, type ReactNode } from "react";
import { Button as BaseButton } from "@base-ui/react/button";
import { Field } from "@base-ui/react/field";
import { Input } from "@base-ui/react/input";
import { Badge } from "./Badge.tsx";
import "./ChipsInput.css";

export interface ChipsInputProps {
  label: ReactNode;
  values: readonly string[];
  onValueChange: (values: string[]) => void;
  placeholder?: string | undefined;
  description?: ReactNode;
  disabled?: boolean | undefined;
}

export function ChipsInput({ label, values, onValueChange, placeholder, description, disabled }: ChipsInputProps) {
  const [text, setText] = useState("");
  const add = () => {
    const value = text.trim();
    setText("");
    if (value !== "" && !values.includes(value)) onValueChange([...values, value]);
  };
  const remove = (value: string) => onValueChange(values.filter((v) => v !== value));
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      add();
    } else if (event.key === "Backspace" && text === "" && values.length > 0) {
      remove(values[values.length - 1] ?? "");
    }
  };
  return (
    <Field.Root disabled={disabled} className="ui-field">
      <Field.Label className="ui-field-label">{label}</Field.Label>
      <div className="ui-chips-input">
        {values.map((value) => (
          <Badge key={value} tone="grey" className="ui-chips-input-chip">
            {value}
            {!disabled && (
              <BaseButton className="ui-chips-input-remove" aria-label={`Remove ${value}`} onClick={() => remove(value)}>
                ×
              </BaseButton>
            )}
          </Badge>
        ))}
        <Input
          value={text}
          onValueChange={setText}
          onKeyDown={onKeyDown}
          onBlur={add}
          placeholder={values.length === 0 ? placeholder : undefined}
          className="ui-chips-input-text"
        />
      </div>
      {description !== undefined && <Field.Description className="ui-field-description">{description}</Field.Description>}
    </Field.Root>
  );
}
