import type { ReactNode } from "react";
import { cn } from "@/app/_lib/utils";

/**
 * One reading on the board: a small label, a big tabular figure, and an
 * optional sub-line. `accent` tints the value (win/loss/gold), `size` bumps it
 * up for hero use.
 */
export function StatTile({
  label,
  value,
  sub,
  accent = "default",
  size = "md",
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  accent?: "default" | "gold" | "win" | "loss" | "ice" | "muted";
  size?: "md" | "lg";
  className?: string;
}) {
  const accentClass = {
    default: "text-foreground",
    gold: "text-gold",
    win: "text-win",
    loss: "text-loss",
    ice: "text-ice",
    muted: "text-muted",
  }[accent];

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <span className="eyebrow">{label}</span>
      <span
        className={cn(
          "nums font-semibold leading-none",
          size === "lg" ? "text-3xl sm:text-4xl" : "text-2xl",
          accentClass,
        )}
      >
        {value}
      </span>
      {sub != null && <span className="text-xs text-muted">{sub}</span>}
    </div>
  );
}
