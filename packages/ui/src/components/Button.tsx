import { Button as BaseButton } from "@base-ui/react/button";
import { cx } from "../format.ts";
import "./Button.css";

export type ButtonVariant = "default" | "primary" | "danger" | "ghost";

export interface ButtonProps extends Omit<BaseButton.Props, "className"> {
  variant?: ButtonVariant | undefined;
  size?: "sm" | "md" | undefined;
  pending?: boolean | undefined;
  className?: string | undefined;
}

export function Button({ variant = "default", size = "md", pending = false, disabled, className, children, ...props }: ButtonProps) {
  return (
    <BaseButton
      {...props}
      disabled={disabled === true || pending}
      aria-busy={pending || undefined}
      className={cx("ui-button", `ui-button--${variant}`, size === "sm" && "ui-button--sm", pending && "is-pending", className)}
    >
      {children}
    </BaseButton>
  );
}
