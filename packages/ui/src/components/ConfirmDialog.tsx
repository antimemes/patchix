import type { ReactElement, ReactNode } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Button, type ButtonVariant } from "./Button.tsx";
import "./ConfirmDialog.css";

export interface ConfirmDialogProps {
  trigger: ReactElement;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  variant?: ButtonVariant | undefined;
  onConfirm: () => void;
  defaultOpen?: boolean | undefined;
}

export function ConfirmDialog({ trigger, title, description, confirmLabel, variant = "danger", onConfirm, defaultOpen }: ConfirmDialogProps) {
  return (
    <AlertDialog.Root defaultOpen={defaultOpen}>
      <AlertDialog.Trigger render={trigger} />
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="ui-dialog-backdrop" />
        <AlertDialog.Popup className="ui-dialog">
          <AlertDialog.Title className="ui-dialog-title">{title}</AlertDialog.Title>
          <AlertDialog.Description className="ui-dialog-description">{description}</AlertDialog.Description>
          <div className="ui-dialog-actions">
            <AlertDialog.Close render={<Button variant="ghost" />}>Cancel</AlertDialog.Close>
            <AlertDialog.Close render={<Button variant={variant} />} onClick={onConfirm}>
              {confirmLabel}
            </AlertDialog.Close>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
