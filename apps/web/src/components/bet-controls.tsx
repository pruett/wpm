"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SharePosition } from "@wpm/shared";

type BetControlsProps = {
  marketId: string;
  outcomes: [string, string];
  priceA: number;
  priceB: number;
  multiplierA: number;
  multiplierB: number;
  positions: SharePosition[];
};

export function BetControls({
  outcomes,
  priceA,
  priceB,
  multiplierA,
  multiplierB,
  positions,
}: BetControlsProps) {
  const [tab, setTab] = useState<"buy" | "sell">("buy");
  const [selectedOutcome, setSelectedOutcome] = useState<"A" | "B">("A");
  const [amount, setAmount] = useState("");
  const [shares, setShares] = useState("");

  const price = selectedOutcome === "A" ? priceA : priceB;
  const multiplier = selectedOutcome === "A" ? multiplierA : multiplierB;
  const outcomeName = selectedOutcome === "A" ? outcomes[0] : outcomes[1];

  const numAmount = Number(amount) || 0;
  const estimatedShares = numAmount > 0 ? numAmount / price : 0;
  const estimatedPayout = numAmount > 0 ? numAmount * multiplier : 0;

  const positionForOutcome = positions.find((p) => p.outcome === selectedOutcome);
  const maxShares = positionForOutcome?.shares ?? 0;

  const numShares = Number(shares) || 0;
  const estimatedReturn = numShares > 0 ? numShares * price : 0;

  function resetInputs() {
    setAmount("");
    setShares("");
  }

  return (
    <div>
      <h3 className="mb-2 font-mono text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Trade
      </h3>

      <div className="mb-3 flex gap-1">
        <button
          onClick={() => {
            setTab("buy");
            resetInputs();
          }}
          className={`flex-1 rounded-md px-3 py-1.5 font-mono text-xs font-medium uppercase tracking-wider transition-colors ${
            tab === "buy"
              ? "bg-foreground text-background"
              : "bg-muted text-muted-foreground hover:text-foreground"
          }`}
        >
          Buy
        </button>
        <button
          onClick={() => {
            setTab("sell");
            resetInputs();
          }}
          className={`flex-1 rounded-md px-3 py-1.5 font-mono text-xs font-medium uppercase tracking-wider transition-colors ${
            tab === "sell"
              ? "bg-foreground text-background"
              : "bg-muted text-muted-foreground hover:text-foreground"
          }`}
        >
          Sell
        </button>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2">
        {(["A", "B"] as const).map((o) => (
          <button
            key={o}
            onClick={() => {
              setSelectedOutcome(o);
              resetInputs();
            }}
            className={`rounded-md border px-3 py-2 font-mono text-sm transition-colors ${
              selectedOutcome === o
                ? "border-foreground bg-foreground/10 text-foreground"
                : "border-border text-muted-foreground hover:border-foreground/50"
            }`}
          >
            {o === "A" ? outcomes[0] : outcomes[1]}
          </button>
        ))}
      </div>

      {tab === "buy" ? (
        <div className="space-y-3">
          <div>
            <label className="mb-1 block font-mono text-xs text-muted-foreground">
              Amount (WPM)
            </label>
            <Input
              type="number"
              min="0"
              step="100"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              className="font-mono tabular-nums"
            />
          </div>

          {numAmount > 0 && (
            <div className="space-y-1 rounded-md bg-muted/50 px-3 py-2 font-mono text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Est. shares</span>
                <span className="tabular-nums">{estimatedShares.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Payout if {outcomeName} wins</span>
                <span className="tabular-nums">{estimatedPayout.toFixed(2)}</span>
              </div>
            </div>
          )}

          <Button className="w-full font-mono uppercase tracking-wider" disabled={numAmount <= 0}>
            Buy {outcomeName}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {maxShares <= 0 ? (
            <p className="py-2 font-mono text-xs text-muted-foreground">
              No {outcomeName} shares to sell.
            </p>
          ) : (
            <>
              <div>
                <div className="mb-1 flex items-baseline justify-between">
                  <label className="font-mono text-xs text-muted-foreground">Shares to sell</label>
                  <button
                    type="button"
                    onClick={() => setShares(maxShares.toString())}
                    className="font-mono text-xs text-muted-foreground hover:text-foreground"
                  >
                    Max: {maxShares.toFixed(2)}
                  </button>
                </div>
                <Input
                  type="number"
                  min="0"
                  max={maxShares}
                  step="1"
                  value={shares}
                  onChange={(e) => setShares(e.target.value)}
                  placeholder="0"
                  className="font-mono tabular-nums"
                />
              </div>

              {numShares > 0 && (
                <div className="rounded-md bg-muted/50 px-3 py-2 font-mono text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Est. return</span>
                    <span className="tabular-nums">{estimatedReturn.toFixed(2)} WPM</span>
                  </div>
                </div>
              )}

              <Button
                className="w-full font-mono uppercase tracking-wider"
                variant="outline"
                disabled={numShares <= 0 || numShares > maxShares}
              >
                Sell {outcomeName}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
