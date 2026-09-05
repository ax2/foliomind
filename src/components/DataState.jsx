import { CheckCircle, CloudSlash, Info, Key, SpinnerGap, WarningCircle } from "@phosphor-icons/react";

const iconByState = {
  loading: SpinnerGap,
  "no-credential": Key,
  empty: CloudSlash,
  error: WarningCircle,
  partial: Info,
  stale: WarningCircle,
  success: CheckCircle,
};

export function DataState({ state = "empty", title, description, actionLabel = "", onAction, actionDisabled = false, compact = false, className = "" }) {
  const Icon = iconByState[state] || Info;
  const classes = ["data-state", `data-state-${state}`, compact ? "data-state-compact" : "", className].filter(Boolean).join(" ");
  return <section className={classes} role={state === "error" ? "alert" : "status"} aria-live={state === "error" ? "assertive" : "polite"} aria-busy={state === "loading"}>
    <span className="data-state-icon" aria-hidden="true"><Icon size={compact ? 18 : 28} weight={state === "success" ? "fill" : "regular"} /></span>
    <div className="data-state-copy"><strong>{title}</strong>{description ? <p>{description}</p> : null}</div>
    {actionLabel && onAction ? <button type="button" className="secondary-button data-state-action" disabled={actionDisabled} onClick={onAction}>{actionLabel}</button> : null}
  </section>;
}
