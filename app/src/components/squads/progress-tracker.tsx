"use client";
import { Check, X } from "lucide-react";
import { Panel } from "@/components/design";
import { cn } from "@/lib/utils";
import type { ProgressStep, StepState } from "@/lib/squads/progress";

function Dot({ state }: { state: StepState }) {
  return (
    <span
      className={cn(
        "relative z-10 grid size-6 shrink-0 place-items-center rounded-full border-2",
        state === "done" && "border-success bg-success text-background",
        state === "failed" &&
          "border-destructive bg-destructive text-background",
        state === "active" && "border-warning bg-card",
        state === "waiting" && "border-border bg-card",
      )}
    >
      {state === "done" && <Check className="size-3.5" strokeWidth={3} />}
      {state === "failed" && <X className="size-3.5" strokeWidth={3} />}
      {state === "active" && (
        <>
          <span className="absolute inset-0 motion-safe:animate-ping rounded-full bg-warning/40" />
          <span className="size-2 rounded-full bg-warning" />
        </>
      )}
    </span>
  );
}

const TEXT: Record<StepState, string> = {
  done: "text-success",
  failed: "text-destructive",
  active: "text-warning",
  waiting: "text-muted-foreground",
};

/** Dot-line progress of one proposal. Refreshed in place by the page; never blanks while reloading. */
export function ProgressTracker({
  steps,
  updatedAt,
}: {
  steps: ProgressStep[];
  updatedAt: number | null;
}) {
  const completed = steps.every((s) => s.state === "done");
  const blocked = steps.some((s) => s.state === "failed");
  const finished = completed || blocked;
  return (
    <Panel className="gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2>Progress</h2>
        <span className="caption flex items-center gap-2" aria-live="off">
          {!finished && (
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full motion-safe:animate-ping rounded-full bg-success opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-success" />
            </span>
          )}
          {completed ? "Completed" : blocked ? "Execution blocked" : "Live"}
          {updatedAt
            ? ` · updated ${new Date(updatedAt).toLocaleTimeString()}`
            : ""}
        </span>
      </div>
      <ol className="flex flex-col md:flex-row" aria-label="Proposal progress">
        {steps.map((step, i) => {
          const last = i === steps.length - 1;
          return (
            <li
              key={step.key}
              className={cn(
                "relative flex flex-1 gap-3 md:flex-col md:items-center md:gap-2 md:text-center",
                !last && "pb-6 md:pb-0",
              )}
              aria-current={step.state === "active" ? "step" : undefined}
            >
              {!last && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute left-[11px] top-6 h-[calc(100%-1.5rem)] w-0.5 md:left-[calc(50%+12px)] md:top-[11px] md:h-0.5 md:w-[calc(100%-24px)]",
                    step.state === "done" ? "bg-success" : "bg-border",
                  )}
                />
              )}
              <Dot state={step.state} />
              <div className="min-w-0 md:px-2">
                <p className="text-sm font-medium">{step.label}</p>
                <p className={cn("text-xs", TEXT[step.state])}>
                  <span className="sr-only">{step.state}: </span>
                  {step.detail}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
