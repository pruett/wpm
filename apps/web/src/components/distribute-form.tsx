"use client";

import { useState, useTransition } from "react";

import { distributeTokens } from "@/actions/admin/distributeTokens";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function DistributeForm({ userId }: { userId: string }) {
  const [amount, setAmount] = useState("");
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit() {
    setMessage(null);
    startTransition(async () => {
      const result = await distributeTokens({
        userId,
        amount: Number(amount),
      });
      if (result.error) {
        setMessage({ type: "error", text: result.error });
      } else {
        setMessage({ type: "success", text: `Sent ${amount} WPM to ${userId.slice(0, 8)}…` });
        setAmount("");
      }
    });
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        min="1"
        step="100"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="Amount"
        className="w-24 font-mono text-xs tabular-nums"
        disabled={isPending}
      />
      <Button
        size="sm"
        variant="outline"
        className="font-mono text-xs"
        disabled={!amount || Number(amount) <= 0 || isPending}
        onClick={handleSubmit}
      >
        {isPending ? "Sending…" : "Send"}
      </Button>
      {message && (
        <span
          className={`font-mono text-xs ${
            message.type === "success" ? "text-green-500" : "text-destructive"
          }`}
        >
          {message.text}
        </span>
      )}
    </div>
  );
}
