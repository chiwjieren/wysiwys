import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { figmaAssets } from "@/lib/figma-assets";
import type { ReactNode } from "react";

export type Tone = "neutral" | "success" | "warning" | "danger" | "info";
export const toneClasses: Record<Tone, string> = {
  neutral: "bg-secondary text-muted-foreground",
  success: "bg-success-bg text-success",
  warning: "bg-warning-bg text-warning",
  danger: "bg-danger-bg text-destructive",
  info: "bg-info-bg text-info",
};
export function StatusBadge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <Badge
      className={cn(
        "h-7 min-w-[124px] justify-center rounded-lg border-0 px-3 text-xs font-normal leading-[18px]",
        toneClasses[tone],
        className,
      )}
    >
      {children}
    </Badge>
  );
}
export function Panel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card
      className={cn(
        "gap-0 rounded-xl border bg-card p-6 shadow-none",
        className,
      )}
    >
      {children}
    </Card>
  );
}
export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="min-w-0 basis-full flex-1 space-y-1.5 sm:basis-auto">
        <h1>{title}</h1>
        <p className="text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}
export function Avatar({
  initials,
  size = 36,
}: {
  initials: string;
  size?: number;
}) {
  return (
    <span
      style={{ width: size, height: size }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full text-xs",
        initials === "ZJ" || initials === "S"
          ? "bg-success-bg text-success"
          : "bg-info-bg text-info",
      )}
    >
      {initials}
    </span>
  );
}
// Use the original local Figma SVG exports, preserving their paths and colors.
export function AssetIcon({
  src,
  size = 20,
  className,
}: {
  src: string;
  size?: number;
  className?: string;
}) {
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className={cn("shrink-0", className)}
    />
  );
}
export function SectionTitle({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <h2>{children}</h2>
      {action}
    </div>
  );
}
export const commonIcons = {
  clock: figmaAssets.dashboard.imgIconClock,
  check: figmaAssets.review.imgIconCheck,
  close: figmaAssets.initiate.imgIconClose,
};
