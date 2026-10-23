import { useCallback, type ReactNode } from "react";
import { Toast as BaseToast } from "@base-ui/react/toast";
import "./Toast.css";

export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <BaseToast.Provider timeout={4000} limit={4}>
      {children}
      <BaseToast.Portal>
        <BaseToast.Viewport className="ui-toasts">
          <ToastList />
        </BaseToast.Viewport>
      </BaseToast.Portal>
    </BaseToast.Provider>
  );
}

function ToastList() {
  const { toasts } = BaseToast.useToastManager();
  return toasts.map((toast) => (
    <BaseToast.Root key={toast.id} toast={toast} className="ui-toast">
      <BaseToast.Content className="ui-toast-content">
        <div className="ui-toast-text">
          <BaseToast.Title className="ui-toast-title" />
          <BaseToast.Description className="ui-toast-description" />
        </div>
        <BaseToast.Close className="ui-toast-close" aria-label="Close">
          ×
        </BaseToast.Close>
      </BaseToast.Content>
    </BaseToast.Root>
  ));
}

/** Shows a short message. Use it after a correct write. Show the errors in the page. */
export function useToast(): (title: string, description?: string) => void {
  const manager = BaseToast.useToastManager();
  return useCallback((title: string, description?: string) => void manager.add(description === undefined ? { title } : { title, description }), [manager]);
}
