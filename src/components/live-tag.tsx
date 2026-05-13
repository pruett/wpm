"use client";

import { useLiveTag } from "@/hooks/use-live-tag";

export function LiveTag({ tag }: { tag: string }) {
  useLiveTag(tag);
  return null;
}
