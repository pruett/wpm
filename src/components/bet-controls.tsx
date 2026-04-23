"use client";

import { useState, useTransition } from "react";

import type { MarketWithOdds, SharePosition } from "@/lib/types";

import { placeBet } from "@/actions/placeBet";
import { sellShares } from "@/actions/sellShares";
import { useBetConfirm } from "@/components/bet-confirm-provider";
import { useIsInMarketDrawer } from "@/components/market-drawer";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const BUY_PRESETS = [25, 100, 500, 1000];
const BUY_SLIDER_MAX = 1000;
const SELL_PCT_PRESETS = [0.25, 0.5, 0.75, 1];

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .map((s) => s[0])
      .filter(Boolean)
      .join("")
      .slice(0, 3)
      .toUpperCase() || "?"
  );
}

function formatRemaining(date: Date): string {
  const diff = date.getTime() - Date.now();
  if (diff <= 0) return "closed";
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const mins = Math.floor((diff % 3_600_000) / 60_000);
  if (days >= 1) return `${days}d ${hours}h`;
  if (hours >= 1) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

type Props = {
  market: MarketWithOdds;
  userId?: string;
  positions: SharePosition[];
};

export function BetControls({ market, userId, positions }: Props) {
  const { priceA, priceB, multiplierA, multiplierB } = market;

  const [teamA, teamB] = market.outcomes;

  const closesAt = new Date(market.closesAt);
  const diffMs = closesAt.getTime() - Date.now();
  const isClosed = diffMs <= 0;
  const isClosingSoon = !isClosed && diffMs < 60 * 60 * 1000;

  const [tab, setTab] = useState<"buy" | "sell">("buy");
  const [outcome, setOutcome] = useState<"A" | "B">("A");
  const [amount, setAmount] = useState<number>(100);
  const [sellShareAmount, setSellShareAmount] = useState<number>(0);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const betConfirm = useBetConfirm();
  const inDrawer = useIsInMarketDrawer();

  const price = outcome === "A" ? priceA : priceB;
  const multiplier = outcome === "A" ? multiplierA : multiplierB;
  const outcomeName = outcome === "A" ? teamA : teamB;

  const positionForOutcome = positions.find((p) => p.outcome === outcome);
  const ownedShares = positionForOutcome?.shares ?? 0;

  const estShares = amount > 0 && price > 0 ? amount / price : 0;
  const estPayout = amount > 0 ? amount * multiplier : 0;
  const estReturn = sellShareAmount > 0 ? sellShareAmount * price : 0;

  function pickOutcome(next: "A" | "B") {
    setOutcome(next);
    setSellShareAmount(0);
    setMessage(null);
  }

  function pickTab(next: "buy" | "sell") {
    setTab(next);
    setSellShareAmount(0);
    setMessage(null);
  }

  function handleBuy() {
    setMessage(null);
    startTransition(async () => {
      const result = await placeBet({ marketId: market.id, outcome, amount });
      if (result.error) {
        setMessage({ kind: "error", text: result.error });
        return;
      }
      if (inDrawer && betConfirm) {
        betConfirm.confirmBet({
          amount,
          outcomeName,
          shares: estShares,
          payout: estPayout,
        });
        return;
      }
      setMessage({ kind: "success", text: `Placed ${amount} WPM on ${outcomeName}.` });
    });
  }

  function handleSell() {
    setMessage(null);
    startTransition(async () => {
      const result = await sellShares({
        marketId: market.id,
        outcome,
        shares: sellShareAmount,
      });
      if (result.error) {
        setMessage({ kind: "error", text: result.error });
        return;
      }
      setMessage({
        kind: "success",
        text: `Sold ${sellShareAmount.toFixed(2)} ${outcomeName} shares.`,
      });
      setSellShareAmount(0);
    });
  }

  const canBuy = !isClosed && amount > 0 && !isPending;
  const canSell = !isClosed && sellShareAmount > 0 && sellShareAmount <= ownedShares && !isPending;

  const outcomes = [
    { key: "A" as const, name: teamA, price: priceA, multiplier: multiplierA },
    { key: "B" as const, name: teamB, price: priceB, multiplier: multiplierB },
  ];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-start gap-3">
        <div className="flex flex-1 flex-col gap-2">
          <ItemTitle>{market.name}</ItemTitle>
          <div className="flex flex-wrap items-center gap-2">
            {isClosed ? (
              <Badge variant="destructive">Closed</Badge>
            ) : isClosingSoon ? (
              <Badge variant="destructive">Closing in {formatRemaining(closesAt)}</Badge>
            ) : (
              <Badge variant="outline">Closes in {formatRemaining(closesAt)}</Badge>
            )}
            <Badge variant="secondary">
              {market.bettorCount} {market.bettorCount === 1 ? "bettor" : "bettors"}
            </Badge>
          </div>
        </div>
      </header>

      <ToggleGroup
        value={[outcome]}
        onValueChange={(vals) => {
          const next = vals[0];
          if (next === "A" || next === "B") pickOutcome(next);
        }}
        spacing={2}
        variant="outline"
        className="w-full"
      >
        {outcomes.map((o) => (
          <ToggleGroupItem
            key={o.key}
            value={o.key}
            variant="outline"
            className="h-auto flex-1 flex-col items-center gap-2 py-4"
          >
            <Avatar size="lg">
              <AvatarFallback>{initials(o.name)}</AvatarFallback>
            </Avatar>
            <ItemTitle>{o.name}</ItemTitle>
            <ItemDescription>
              {(o.price * 100).toFixed(0)}% · {o.multiplier.toFixed(2)}x
            </ItemDescription>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {userId ? (
        <Tabs value={tab} onValueChange={(v) => pickTab(v as "buy" | "sell")}>
          <TabsList className="w-full">
            <TabsTrigger value="buy">Buy</TabsTrigger>
            <TabsTrigger value="sell">Sell</TabsTrigger>
          </TabsList>

          <TabsContent value="buy" className="flex flex-col gap-4">
            <FieldSet disabled={isPending || isClosed}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="buy-amount">Amount</FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      id="buy-amount"
                      type="number"
                      min={0}
                      step={1}
                      inputMode="numeric"
                      value={amount ? amount : ""}
                      onChange={(e) => setAmount(Math.max(0, Number(e.target.value) || 0))}
                    />
                    <InputGroupAddon align="inline-end">WPM</InputGroupAddon>
                  </InputGroup>
                  <FieldDescription>
                    Drag the slider or pick a preset to size your bet.
                  </FieldDescription>
                </Field>

                <Slider
                  value={[Math.min(amount, BUY_SLIDER_MAX)]}
                  min={0}
                  max={BUY_SLIDER_MAX}
                  step={5}
                  onValueChange={(v) => {
                    const next = Array.isArray(v) ? v[0] : v;
                    setAmount(next);
                  }}
                />

                <ButtonGroup className="w-full">
                  {BUY_PRESETS.map((preset) => (
                    <Button
                      key={preset}
                      type="button"
                      variant="outline"
                      className="flex-1"
                      onClick={() => setAmount(preset)}
                    >
                      {preset}
                    </Button>
                  ))}
                </ButtonGroup>

                <Separator />

                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel>Shares you'll get</FieldLabel>
                    <FieldDescription>At {(price * 100).toFixed(0)}% price.</FieldDescription>
                  </FieldContent>
                  <Badge variant="secondary">{estShares.toFixed(2)}</Badge>
                </Field>

                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel>Payout if {outcomeName} wins</FieldLabel>
                    <FieldDescription>At {multiplier.toFixed(2)}x.</FieldDescription>
                  </FieldContent>
                  <Badge>{estPayout.toFixed(0)} WPM</Badge>
                </Field>
              </FieldGroup>
            </FieldSet>

            {message ? (
              <Alert variant={message.kind === "error" ? "destructive" : "default"}>
                <AlertTitle>{message.kind === "error" ? "Bet failed" : "Bet placed"}</AlertTitle>
                <AlertDescription>{message.text}</AlertDescription>
              </Alert>
            ) : null}

            <Button type="button" size="lg" disabled={!canBuy} onClick={handleBuy}>
              {isPending
                ? "Placing…"
                : isClosed
                  ? "Betting closed"
                  : `Bet ${amount || 0} WPM on ${outcomeName}`}
            </Button>
          </TabsContent>

          <TabsContent value="sell" className="flex flex-col gap-4">
            {ownedShares <= 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No {outcomeName} shares</EmptyTitle>
                  <EmptyDescription>
                    Buy some {outcomeName} shares first, then cash them out here.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                <FieldSet disabled={isPending || isClosed}>
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="sell-shares">Shares to sell</FieldLabel>
                      <InputGroup>
                        <InputGroupInput
                          id="sell-shares"
                          type="number"
                          min={0}
                          max={ownedShares}
                          step={1}
                          inputMode="numeric"
                          value={sellShareAmount ? sellShareAmount : ""}
                          onChange={(e) => {
                            const v = Math.max(0, Number(e.target.value) || 0);
                            setSellShareAmount(Math.min(ownedShares, v));
                          }}
                        />
                        <InputGroupAddon align="inline-end">shares</InputGroupAddon>
                      </InputGroup>
                      <FieldDescription>
                        You own {ownedShares.toFixed(2)} {outcomeName} shares.
                      </FieldDescription>
                    </Field>

                    <Slider
                      value={[Math.min(sellShareAmount, ownedShares)]}
                      min={0}
                      max={Math.max(1, Math.ceil(ownedShares))}
                      step={1}
                      onValueChange={(v) => {
                        const next = Array.isArray(v) ? v[0] : v;
                        setSellShareAmount(Math.min(ownedShares, next));
                      }}
                    />

                    <ButtonGroup className="w-full">
                      {SELL_PCT_PRESETS.map((pct) => (
                        <Button
                          key={pct}
                          type="button"
                          variant="outline"
                          className="flex-1"
                          onClick={() =>
                            setSellShareAmount(
                              pct === 1 ? ownedShares : Math.floor(ownedShares * pct * 100) / 100,
                            )
                          }
                        >
                          {pct === 1 ? "Max" : `${pct * 100}%`}
                        </Button>
                      ))}
                    </ButtonGroup>

                    <Separator />

                    <Field orientation="horizontal">
                      <FieldContent>
                        <FieldLabel>Estimated return</FieldLabel>
                        <FieldDescription>At {(price * 100).toFixed(0)}% price.</FieldDescription>
                      </FieldContent>
                      <Badge>{estReturn.toFixed(0)} WPM</Badge>
                    </Field>
                  </FieldGroup>
                </FieldSet>

                {message ? (
                  <Alert variant={message.kind === "error" ? "destructive" : "default"}>
                    <AlertTitle>
                      {message.kind === "error" ? "Sell failed" : "Shares sold"}
                    </AlertTitle>
                    <AlertDescription>{message.text}</AlertDescription>
                  </Alert>
                ) : null}

                <Button
                  type="button"
                  size="lg"
                  variant="outline"
                  disabled={!canSell}
                  onClick={handleSell}
                >
                  {isPending ? "Selling…" : `Sell ${sellShareAmount.toFixed(0)} ${outcomeName}`}
                </Button>
              </>
            )}
          </TabsContent>
        </Tabs>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Sign in to bet</EmptyTitle>
            <EmptyDescription>You need an account to place bets on this market.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {userId && positions.length > 0 ? (
        <FieldSet>
          <FieldLegend variant="label">Your positions</FieldLegend>
          <ItemGroup>
            {positions.map((pos) => {
              const posName = pos.outcome === "A" ? teamA : teamB;
              const posPrice = pos.outcome === "A" ? priceA : priceB;
              const value = pos.shares * posPrice;
              const pnl = value - pos.costBasis;
              return (
                <Item key={pos.outcome} variant="outline" size="sm">
                  <ItemMedia>
                    <Avatar size="sm">
                      <AvatarFallback>{initials(posName)}</AvatarFallback>
                    </Avatar>
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{posName}</ItemTitle>
                    <ItemDescription>
                      {pos.shares.toFixed(2)} shares · cost {pos.costBasis.toFixed(0)}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Badge variant={pnl >= 0 ? "default" : "destructive"}>
                      {pnl >= 0 ? "+" : ""}
                      {pnl.toFixed(0)}
                    </Badge>
                  </ItemActions>
                </Item>
              );
            })}
          </ItemGroup>
        </FieldSet>
      ) : null}
    </div>
  );
}
