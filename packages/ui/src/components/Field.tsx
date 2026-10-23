import type { ReactNode } from "react";
import { Field } from "@base-ui/react/field";
import { Input } from "@base-ui/react/input";
import { cx } from "../format.ts";
import "./Field.css";

interface FieldParts {
  label: ReactNode;
  hideLabel?: boolean | undefined;
  description?: ReactNode;
  error?: string | null | undefined;
  className?: string | undefined;
}

export interface TextFieldProps extends FieldParts, Omit<Input.Props, "className" | "value" | "onValueChange" | "defaultValue"> {
  value: string;
  onValueChange: (value: string) => void;
}

export function TextField({ label, hideLabel, description, error, className, ...props }: TextFieldProps) {
  return (
    <Field.Root invalid={Boolean(error)} className={cx("ui-field", className)}>
      <Field.Label className={hideLabel ? "sr-only" : "ui-field-label"}>{label}</Field.Label>
      <Input {...props} className="ui-input" />
      {description !== undefined && <Field.Description className="ui-field-description">{description}</Field.Description>}
      {error && (
        <Field.Error match className="ui-field-error">
          {error}
        </Field.Error>
      )}
    </Field.Root>
  );
}

export interface TextAreaProps extends FieldParts {
  value: string;
  onValueChange: (value: string) => void;
  rows?: number | undefined;
  maxLength?: number | undefined;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  mono?: boolean | undefined;
}

export function TextArea({ label, hideLabel, description, error, className, value, onValueChange, rows = 4, maxLength, placeholder, disabled, mono }: TextAreaProps) {
  const over = maxLength !== undefined && value.length > maxLength;
  return (
    <Field.Root invalid={Boolean(error) || over} disabled={disabled} className={cx("ui-field", className)}>
      <div className="ui-field-head">
        <Field.Label className={hideLabel ? "sr-only" : "ui-field-label"}>{label}</Field.Label>
        {maxLength !== undefined && (
          <span className={cx("ui-field-counter", over && "is-over")} aria-live="polite">
            {value.length}/{maxLength}
          </span>
        )}
      </div>
      <Field.Control
        render={<textarea rows={rows} />}
        value={value}
        onValueChange={onValueChange}
        placeholder={placeholder}
        className={cx("ui-input", "ui-textarea", mono && "is-mono")}
      />
      {description !== undefined && <Field.Description className="ui-field-description">{description}</Field.Description>}
      {error && (
        <Field.Error match className="ui-field-error">
          {error}
        </Field.Error>
      )}
    </Field.Root>
  );
}
