import type { SVGProps } from "react";

import type { Sport } from "@/lib/types";

import { cn } from "@/lib/utils";

type SportLogoProps = SVGProps<SVGSVGElement> & {
  sport: Sport;
  size?: number;
};

export function SportLogo({ sport, size = 18, className, ...props }: SportLogoProps) {
  const Icon = ICONS[sport];
  return (
    <Icon
      width={size}
      height={size}
      className={cn("shrink-0", className)}
      role="img"
      aria-label={LABELS[sport]}
      {...props}
    />
  );
}

const LABELS: Record<Sport, string> = {
  mlb: "Baseball",
  nfl: "Football",
  nba: "Basketball",
  nhl: "Hockey",
};

type IconComponent = (props: SVGProps<SVGSVGElement>) => React.JSX.Element;

const Baseball: IconComponent = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M5.5 6.5c2 1.5 3 3.5 3 5.5s-1 4-3 5.5" strokeLinecap="round" />
    <path d="M18.5 6.5c-2 1.5-3 3.5-3 5.5s1 4 3 5.5" strokeLinecap="round" />
  </svg>
);

const Football: IconComponent = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" {...props}>
    <path d="M4 12c0-4.5 3.5-8 8-8s8 3.5 8 8-3.5 8-8 8-8-3.5-8-8z" transform="rotate(-45 12 12)" />
    <path d="M9.5 12h5M11 10.5v3M12.5 10.5v3" strokeLinecap="round" />
  </svg>
);

const Basketball: IconComponent = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3v18" strokeLinecap="round" />
    <path d="M5.5 5.5c2.5 2 4 4 4 6.5s-1.5 4.5-4 6.5" strokeLinecap="round" />
    <path d="M18.5 5.5c-2.5 2-4 4-4 6.5s1.5 4.5 4 6.5" strokeLinecap="round" />
  </svg>
);

const Hockey: IconComponent = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" {...props}>
    <ellipse cx="12" cy="16" rx="8" ry="2.5" />
    <path d="M4 16v2c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-2" />
    <path d="M7 14l8-9 3 1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ICONS: Record<Sport, IconComponent> = {
  mlb: Baseball,
  nfl: Football,
  nba: Basketball,
  nhl: Hockey,
};
