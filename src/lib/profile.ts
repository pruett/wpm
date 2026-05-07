export const PROFILE_COLORS = [
  "red",
  "orange",
  "amber",
  "lime",
  "emerald",
  "teal",
  "sky",
  "blue",
  "violet",
  "pink",
] as const;

export type ProfileColor = (typeof PROFILE_COLORS)[number];

export const PROFILE_COLOR_HEX: Record<ProfileColor, string> = {
  red: "#ef4444",
  orange: "#f97316",
  amber: "#f59e0b",
  lime: "#84cc16",
  emerald: "#10b981",
  teal: "#14b8a6",
  sky: "#0ea5e9",
  blue: "#3b82f6",
  violet: "#8b5cf6",
  pink: "#ec4899",
};

const DEFAULT_PROFILE_COLOR: ProfileColor = "blue";

export function isProfileColor(color: unknown): color is ProfileColor {
  return typeof color === "string" && color in PROFILE_COLOR_HEX;
}

export function profileColorToHex(color: string | null | undefined): string {
  if (isProfileColor(color)) return PROFILE_COLOR_HEX[color];
  return PROFILE_COLOR_HEX[DEFAULT_PROFILE_COLOR];
}

export function profileColorForeground(color: string | null | undefined): string {
  return color === "amber" || color === "lime" ? "#111827" : "#ffffff";
}

export function initialsForName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const initials = parts.length === 1 ? parts[0].slice(0, 2) : `${parts[0][0]}${parts.at(-1)?.[0]}`;
  return initials.toUpperCase();
}
