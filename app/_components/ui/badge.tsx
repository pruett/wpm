import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/app/_lib/utils";

const badge = cva(
  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[0.68rem] font-bold uppercase tracking-wider whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral: "border-border-strong bg-raised text-muted",
        gold: "border-gold/30 bg-gold/10 text-gold",
        win: "border-win/30 bg-win/10 text-win",
        loss: "border-loss/30 bg-loss/10 text-loss",
        ice: "border-ice/30 bg-ice/10 text-ice",
        live: "border-win/40 bg-win/10 text-win",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface BadgeProps
  extends ComponentProps<"span">,
    VariantProps<typeof badge> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badge({ tone }), className)} {...props} />;
}

/** A pulsing dot + label, for the "live" header chip. */
export function LiveBadge({ label = "Live", className }: { label?: string; className?: string }) {
  return (
    <Badge tone="live" className={className}>
      <span className="live-dot inline-block size-1.5 rounded-full bg-win" />
      {label}
    </Badge>
  );
}
