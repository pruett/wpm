"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";

export function MarketSheet({ children }: { children: ReactNode }) {
  const router = useRouter();
  const isMobile = useIsMobile();

  const handleOpenChange = (open: boolean) => {
    if (!open) router.back();
  };

  if (isMobile) {
    return (
      <Drawer open onOpenChange={handleOpenChange}>
        <DrawerContent className="max-h-[90vh]">
          <DrawerHeader className="sr-only">
            <DrawerTitle>Market Detail</DrawerTitle>
            <DrawerDescription>Market odds, pool state, and trading controls</DrawerDescription>
          </DrawerHeader>
          <div className="overflow-y-auto p-4">{children}</div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="sr-only">
          <DialogTitle>Market Detail</DialogTitle>
          <DialogDescription>Market odds, pool state, and trading controls</DialogDescription>
        </DialogHeader>
        <div className="overflow-y-auto">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
