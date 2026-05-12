"use client";

import { useState, useTransition } from "react";

import type { SharePosition, Sport } from "@/lib/types";

import { placeBet } from "@/actions/placeBet";
import { useBetConfirm } from "@/components/bet-confirm-provider";
import { useIsInMarketDrawer } from "@/components/market-drawer";
import { SportLogo } from "@/components/sport-logo";
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
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";

const BUY_PRESETS = [25, 100, 500, 1000];
const BUY_SLIDER_MAX = 1000;

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

type BetControlsMarket = {
  id: string;
  name: string;
  status: "open" | "resolved" | "cancelled";
  priceYes: number;
  multiplierYes: number;
  bettorCount: number;
};

type Props = {
  market: BetControlsMarket;
  sport: Sport;
  closesAt: string;
  userId?: string;
  position?: SharePosition;
};

export function BetControls({ market, sport, closesAt, userId, position }: Props) {
  const { priceYes, multiplierYes } = market;
  const yesName = market.name || "Yes";

  const closesAtDate = new Date(closesAt);
  const diffMs = closesAtDate.getTime() - Date.now();
  const isClosed = diffMs <= 0 || market.status !== "open";
  const isClosingSoon = !isClosed && diffMs < 60 * 60 * 1000;

  const [amount, setAmount] = useState<number>(100);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const betConfirm = useBetConfirm();
  const inDrawer = useIsInMarketDrawer();

  const ownedShares = position?.shares ?? 0;

  const estShares = amount > 0 && priceYes > 0 ? amount / priceYes : 0;
  const estPayout = amount > 0 ? amount * multiplierYes : 0;

  function handleBuy() {
    setMessage(null);
    startTransition(async () => {
      const result = await placeBet({ marketId: market.id, amount });
      if (result.error) {
        setMessage({ kind: "error", text: result.error });
        return;
      }
      if (inDrawer && betConfirm) {
        betConfirm.confirmBet({
          amount,
          outcomeName: yesName,
          shares: estShares,
          payout: estPayout,
        });
        return;
      }
      setMessage({ kind: "success", text: `Placed ${amount} WPM on ${yesName}.` });
    });
  }

  const canBuy = !isClosed && amount > 0 && !isPending;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-start gap-3">
        <SportLogo sport={sport} size={22} className="mt-1 text-muted-foreground" />
        <div className="flex flex-1 flex-col gap-2">
          <ItemTitle>{yesName}</ItemTitle>
          <div className="flex flex-wrap items-center gap-2">
            {isClosed ? (
              <Badge variant="destructive">Closed</Badge>
            ) : isClosingSoon ? (
              <Badge variant="destructive">Closing in {formatRemaining(closesAtDate)}</Badge>
            ) : (
              <Badge variant="outline">Closes in {formatRemaining(closesAtDate)}</Badge>
            )}
            <Badge variant="secondary">
              {(priceYes * 100).toFixed(0)}% · {multiplierYes.toFixed(2)}x
            </Badge>
            <Badge variant="secondary">
              {market.bettorCount} {market.bettorCount === 1 ? "bettor" : "bettors"}
            </Badge>
          </div>
        </div>
      </header>

      {userId ? (
        <div className="flex flex-col gap-4">
          <FieldSet disabled={isPending || isClosed}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`buy-amount-${market.id}`}>Amount</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id={`buy-amount-${market.id}`}
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
                  <FieldDescription>At {(priceYes * 100).toFixed(0)}% price.</FieldDescription>
                </FieldContent>
                <Badge variant="secondary">{estShares.toFixed(2)}</Badge>
              </Field>

              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel>Payout if {yesName} wins</FieldLabel>
                  <FieldDescription>At {multiplierYes.toFixed(2)}x.</FieldDescription>
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
            {isPending ? "Placing…" : isClosed ? "Betting closed" : `Buy YES · ${amount || 0} WPM`}
          </Button>
        </div>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Sign in to bet</EmptyTitle>
            <EmptyDescription>You need an account to place bets on this market.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {userId && position && ownedShares > 0 ? (
        <FieldSet>
          <FieldLegend variant="label">Your position</FieldLegend>
          <Item variant="outline" size="sm">
            <ItemMedia>
              <Avatar size="sm">
                <AvatarFallback>{initials(yesName)}</AvatarFallback>
              </Avatar>
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{yesName}</ItemTitle>
              <ItemDescription>
                {position.shares.toFixed(2)} shares · cost {position.costBasis.toFixed(0)}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {(() => {
                const value = position.shares * priceYes;
                const pnl = value - position.costBasis;
                return (
                  <Badge variant={pnl >= 0 ? "default" : "destructive"}>
                    {pnl >= 0 ? "+" : ""}
                    {pnl.toFixed(0)}
                  </Badge>
                );
              })()}
            </ItemActions>
          </Item>
        </FieldSet>
      ) : null}
    </div>
  );
}
