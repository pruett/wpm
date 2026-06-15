import type { ComponentProps } from "react";
import { cn } from "@/app/_lib/utils";

/** Shimmering placeholder block (animation lives in globals.css `.skeleton`). */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("skeleton", className)} {...props} />;
}
