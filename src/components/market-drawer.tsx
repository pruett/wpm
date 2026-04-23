"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, type ReactNode } from "react";

import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";

const InMarketDrawerContext = createContext(false);

export function useIsInMarketDrawer() {
  return useContext(InMarketDrawerContext);
}

export function MarketDrawer({ children }: { children: ReactNode }) {
  const router = useRouter();

  const handleOpenChange = (open: boolean) => {
    if (!open) router.back();
  };

  return (
    <InMarketDrawerContext.Provider value={true}>
      <Drawer open onOpenChange={handleOpenChange}>
        <DrawerContent className="max-h-[90vh]">
          <DrawerHeader className="sr-only">
            <DrawerTitle>Market Detail</DrawerTitle>
            <DrawerDescription>Market odds, pool state, and trading controls</DrawerDescription>
          </DrawerHeader>
          <div className="overflow-y-auto p-4">{children}</div>
        </DrawerContent>
      </Drawer>
    </InMarketDrawerContext.Provider>
  );
}
