"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type BetConfirmation = {
  amount: number;
  outcomeName: string;
  shares: number;
  payout: number;
};

const BetConfirmContext = createContext<{
  confirmBet: (info: BetConfirmation) => void;
} | null>(null);

export function useBetConfirm() {
  return useContext(BetConfirmContext);
}

export function BetConfirmProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [confirmation, setConfirmation] = useState<BetConfirmation | null>(null);

  const confirmBet = (info: BetConfirmation) => {
    setConfirmation(info);
    router.back();
  };

  const closeDialog = () => {
    setConfirmation(null);
    router.push("/");
  };

  return (
    <BetConfirmContext.Provider value={{ confirmBet }}>
      {children}
      <Dialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Bet placed</DialogTitle>
            <DialogDescription>
              {confirmation
                ? `You bet ${confirmation.amount} WPM on ${confirmation.outcomeName} for ${confirmation.shares.toFixed(2)} shares. Potential payout ${confirmation.payout.toFixed(0)} WPM.`
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={closeDialog}>OK</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </BetConfirmContext.Provider>
  );
}
