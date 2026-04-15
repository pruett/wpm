"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

export function MarketSheet({ children }: { children: ReactNode }) {
  const router = useRouter();

  return (
    <Sheet open onOpenChange={() => router.back()}>
      <SheetContent side="right" className="overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="font-mono text-sm uppercase tracking-wider">
            Market Detail
          </SheetTitle>
          <SheetDescription className="sr-only">
            Market odds, pool state, and trading controls
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
