import { cn } from "@/app/_lib/utils";

const RING_TONES = [
  "from-gold/30 to-gold/5 text-gold-soft",
  "from-win/30 to-win/5 text-win",
  "from-ice/30 to-ice/5 text-ice",
  "from-violet/30 to-violet/5 text-violet",
  "from-loss/30 to-loss/5 text-loss",
] as const;

/**
 * A monogram chip. Color is derived deterministically from a seed (the user id
 * or name) so a given player always wears the same hue across the dashboard.
 */
export function Avatar({
  initials,
  seed,
  className,
}: {
  initials: string;
  seed: number | string;
  className?: string;
}) {
  const n = typeof seed === "number" ? seed : seed.length;
  const tone = RING_TONES[Math.abs(n) % RING_TONES.length];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-b",
        "border border-white/5 font-mono text-xs font-bold tabular-nums",
        "size-9",
        tone,
        className,
      )}
      aria-hidden
    >
      {initials}
    </span>
  );
}
