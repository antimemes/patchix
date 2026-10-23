import { Progress as BaseProgress } from "@base-ui/react/progress";
import "./Progress.css";

export interface ProgressProps {
  value: number | null;
  label?: string | undefined;
  hideLabel?: boolean | undefined;
  max?: number | undefined;
}

export function Progress({ value, label, hideLabel = false, max }: ProgressProps) {
  return (
    <BaseProgress.Root value={value} max={max} aria-label={label === undefined ? "Progress" : undefined} className="ui-progress">
      {label !== undefined && <BaseProgress.Label className={hideLabel ? "sr-only" : "ui-progress-label"}>{label}</BaseProgress.Label>}
      <BaseProgress.Track className="ui-progress-track">
        <BaseProgress.Indicator className="ui-progress-indicator" />
      </BaseProgress.Track>
    </BaseProgress.Root>
  );
}
