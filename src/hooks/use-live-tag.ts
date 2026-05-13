"use client";

import { useEffect } from "react";

import { subscribedTags } from "@/providers/realtime";

const tagRefCounts = new Map<string, number>();

export function useLiveTag(tag: string) {
  useEffect(() => {
    const next = (tagRefCounts.get(tag) ?? 0) + 1;
    tagRefCounts.set(tag, next);
    if (next === 1) subscribedTags.add(tag);

    return () => {
      const current = tagRefCounts.get(tag) ?? 0;
      if (current <= 1) {
        tagRefCounts.delete(tag);
        subscribedTags.delete(tag);
      } else {
        tagRefCounts.set(tag, current - 1);
      }
    };
  }, [tag]);
}
