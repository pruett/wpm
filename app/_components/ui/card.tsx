import type { ComponentProps } from "react";
import { cn } from "@/app/_lib/utils";

/**
 * The dashboard's surface primitive — a felt panel with a hairline border and
 * a faint top-edge highlight so it reads as raised off the background. Composes
 * as Card > CardHeader (CardEyebrow + CardTitle) > CardBody.
 */
export function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[var(--radius)] border border-border bg-panel/80",
        "shadow-[0_1px_0_rgba(255,255,255,0.04)_inset,0_18px_40px_-24px_rgba(0,0,0,0.9)]",
        "backdrop-blur-sm",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-3 border-b border-border/70 px-5 py-4",
        className,
      )}
      {...props}
    />
  );
}

export function CardEyebrow({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("eyebrow", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return (
    <h2
      className={cn("display text-2xl text-foreground sm:text-[1.7rem]", className)}
      {...props}
    />
  );
}

export function CardBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("px-5 py-4", className)} {...props} />;
}
