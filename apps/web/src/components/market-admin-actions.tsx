"use client";

import { useState, useTransition } from "react";

import { cancelMarket } from "@/actions/admin/cancelMarket";
import { overrideSeed } from "@/actions/admin/overrideSeed";
import { resolveMarket } from "@/actions/admin/resolveMarket";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type StatusMessageProps = {
  message: { type: "success" | "error"; text: string } | null;
};

function StatusMessage({ message }: StatusMessageProps) {
  if (!message) return null;
  return (
    <span
      className={`font-mono text-xs ${
        message.type === "success" ? "text-green-500" : "text-destructive"
      }`}
    >
      {message.text}
    </span>
  );
}

export function ResolveForm({
  marketId,
  outcomes,
}: {
  marketId: string;
  outcomes: [string, string];
}) {
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleResolve(result: "A" | "B") {
    setMessage(null);
    startTransition(async () => {
      const res = await resolveMarket({ marketId, result });
      if (res.error) {
        setMessage({ type: "error", text: res.error });
      } else {
        setMessage({
          type: "success",
          text: `Resolved: ${result === "A" ? outcomes[0] : outcomes[1]}`,
        });
      }
    });
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        className="font-mono text-xs"
        disabled={isPending}
        onClick={() => handleResolve("A")}
      >
        {outcomes[0]}
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="font-mono text-xs"
        disabled={isPending}
        onClick={() => handleResolve("B")}
      >
        {outcomes[1]}
      </Button>
      <StatusMessage message={message} />
    </div>
  );
}

export function CancelForm({ marketId }: { marketId: string }) {
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);

  function handleCancel() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setMessage(null);
    setConfirming(false);
    startTransition(async () => {
      const res = await cancelMarket({ marketId });
      if (res.error) {
        setMessage({ type: "error", text: res.error });
      } else {
        setMessage({ type: "success", text: "Market cancelled" });
      }
    });
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant={confirming ? "destructive" : "outline"}
        className="font-mono text-xs"
        disabled={isPending}
        onClick={handleCancel}
      >
        {isPending ? "Cancelling..." : confirming ? "Confirm cancel" : "Cancel"}
      </Button>
      {confirming && !isPending && (
        <Button
          size="sm"
          variant="ghost"
          className="font-mono text-xs"
          onClick={() => setConfirming(false)}
        >
          Nevermind
        </Button>
      )}
      <StatusMessage message={message} />
    </div>
  );
}

export function OverrideSeedForm({ marketId }: { marketId: string }) {
  const [seedA, setSeedA] = useState("");
  const [seedB, setSeedB] = useState("");
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit() {
    setMessage(null);
    startTransition(async () => {
      const res = await overrideSeed({
        marketId,
        seedA: Number(seedA),
        seedB: Number(seedB),
      });
      if (res.error) {
        setMessage({ type: "error", text: res.error });
      } else {
        setMessage({ type: "success", text: "Seeds updated" });
        setSeedA("");
        setSeedB("");
      }
    });
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        min="1"
        value={seedA}
        onChange={(e) => setSeedA(e.target.value)}
        placeholder="Seed A"
        className="w-20 font-mono text-xs tabular-nums"
        disabled={isPending}
      />
      <Input
        type="number"
        min="1"
        value={seedB}
        onChange={(e) => setSeedB(e.target.value)}
        placeholder="Seed B"
        className="w-20 font-mono text-xs tabular-nums"
        disabled={isPending}
      />
      <Button
        size="sm"
        variant="outline"
        className="font-mono text-xs"
        disabled={!seedA || !seedB || Number(seedA) <= 0 || Number(seedB) <= 0 || isPending}
        onClick={handleSubmit}
      >
        {isPending ? "Updating..." : "Set"}
      </Button>
      <StatusMessage message={message} />
    </div>
  );
}
