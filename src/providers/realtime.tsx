"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

export const subscribedTags = new Set<string>();

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const router = useRouter();

  useEffect(() => {
    const source = new EventSource("/api/stream");
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let hasOpened = false;

    function scheduleRefresh() {
      if (refreshTimer !== null) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        router.refresh();
      }, 150);
    }

    function onOpen() {
      if (!hasOpened) {
        hasOpened = true;
        return;
      }
      scheduleRefresh();
    }

    function onInvalidate(event: MessageEvent) {
      let tag: string;
      try {
        const parsed = JSON.parse(event.data) as { tag?: unknown };
        if (typeof parsed.tag !== "string") return;
        tag = parsed.tag;
      } catch {
        return;
      }
      if (subscribedTags.has(tag)) scheduleRefresh();
    }

    source.addEventListener("open", onOpen);
    source.addEventListener("invalidate", onInvalidate as EventListener);

    return () => {
      source.removeEventListener("open", onOpen);
      source.removeEventListener("invalidate", onInvalidate as EventListener);
      source.close();
      if (refreshTimer !== null) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
    };
  }, [router]);

  return <>{children}</>;
}
