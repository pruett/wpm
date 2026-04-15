import { Suspense } from "react";
import { connection } from "next/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getHealth } from "@/lib/data/health";
import { getBlocks } from "@/lib/data/blocks";
import { SystemEventFeed } from "@/components/system-event-feed";
import type { Block, Transaction } from "@wpm/shared";

function truncate(s: string, len = 12) {
  return s.length > len ? s.slice(0, len) + "…" : s;
}

function txLabel(tx: Transaction): string {
  switch (tx.type) {
    case "Distribute":
      return `Distribute ${tx.amount} → ${truncate(tx.to)}`;
    case "CreateMarket":
      return `Create "${tx.name}"`;
    case "PlaceBet":
      return `Bet ${tx.amount} on ${tx.outcome} — ${truncate(tx.marketId, 8)}`;
    case "ResolveMarket":
      return `Resolve ${tx.result} — ${truncate(tx.marketId, 8)}`;
    case "SettlePayout":
      return `Payout ${tx.amount} → ${truncate(tx.to)}`;
    case "SellShares":
      return `Sell ${tx.shares} ${tx.outcome} — ${truncate(tx.marketId, 8)}`;
  }
}

async function HealthPanel() {
  await connection();
  const health = await getHealth();

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
          Node Health
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-3">
          <div
            className={`h-4 w-4 rounded-full ${health.node ? "bg-green-500" : "bg-destructive"}`}
          />
          <div>
            <p className="font-mono text-2xl font-black">
              {health.status === "ok" ? "Healthy" : "Degraded"}
            </p>
            <p className="font-mono text-xs text-muted-foreground">
              Node: {health.node ? "Connected" : "Disconnected"}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

async function ChainStats() {
  await connection();
  const blocks = await getBlocks();

  const chainHeight = blocks.length > 0 ? blocks[blocks.length - 1].index : 0;
  const totalTx = blocks.reduce((sum, b) => sum + b.transactions.length, 0);
  const nonEmptyBlocks = blocks.filter((b) => b.transactions.length > 0).length;

  const txByType: Record<string, number> = {};
  for (const block of blocks) {
    for (const tx of block.transactions) {
      txByType[tx.type] = (txByType[tx.type] ?? 0) + 1;
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
          Chain Stats
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="font-mono text-2xl font-black tabular-nums">{chainHeight}</p>
            <p className="font-mono text-xs text-muted-foreground">Chain height</p>
          </div>
          <div>
            <p className="font-mono text-2xl font-black tabular-nums">{totalTx}</p>
            <p className="font-mono text-xs text-muted-foreground">Total transactions</p>
          </div>
          <div>
            <p className="font-mono text-2xl font-black tabular-nums">{blocks.length}</p>
            <p className="font-mono text-xs text-muted-foreground">Blocks</p>
          </div>
          <div>
            <p className="font-mono text-2xl font-black tabular-nums">{nonEmptyBlocks}</p>
            <p className="font-mono text-xs text-muted-foreground">Non-empty blocks</p>
          </div>
        </div>
        {Object.keys(txByType).length > 0 && (
          <div className="mt-4 border-t border-border pt-4">
            <p className="mb-2 font-mono text-xs uppercase tracking-wider text-muted-foreground">
              Transactions by type
            </p>
            <div className="space-y-1">
              {Object.entries(txByType)
                .sort(([, a], [, b]) => b - a)
                .map(([type, count]) => (
                  <div key={type} className="flex items-center justify-between font-mono text-xs">
                    <span className="text-muted-foreground">{type}</span>
                    <span className="tabular-nums">{count}</span>
                  </div>
                ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

async function RecentBlocks() {
  await connection();
  const blocks = await getBlocks();

  const recent = blocks.slice(-10).reverse();

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
          Recent Blocks
        </CardTitle>
      </CardHeader>
      <CardContent>
        {recent.length === 0 ? (
          <p className="py-4 text-center font-mono text-sm text-muted-foreground">No blocks yet</p>
        ) : (
          <div className="space-y-3">
            {recent.map((block: Block) => (
              <div
                key={block.index}
                className="border-b border-border pb-3 last:border-b-0 last:pb-0"
              >
                <div className="flex items-baseline justify-between">
                  <span className="font-mono text-sm font-bold tabular-nums">#{block.index}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {new Date(block.timestamp).toLocaleString()}
                  </span>
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="font-mono text-xs text-muted-foreground">
                    Hash: {truncate(block.hash, 16)}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    Signer: {truncate(block.signer)}
                  </span>
                </div>
                {block.transactions.length > 0 ? (
                  <div className="mt-2 space-y-0.5">
                    {block.transactions.map((tx, i) => (
                      <p key={i} className="font-mono text-xs text-muted-foreground">
                        → {txLabel(tx)}
                      </p>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 font-mono text-xs text-muted-foreground/50">Empty block</p>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CardSkeleton() {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="h-3 w-24 animate-pulse rounded bg-muted" />
      </CardHeader>
      <CardContent>
        <div className="h-12 w-full animate-pulse rounded bg-muted" />
      </CardContent>
    </Card>
  );
}

export default function AdminSystemPage() {
  return (
    <div>
      <h1 className="mb-6 font-mono text-2xl font-black uppercase tracking-wider">System</h1>

      <div className="grid gap-6 lg:grid-cols-2">
        <Suspense fallback={<CardSkeleton />}>
          <HealthPanel />
        </Suspense>
        <Suspense fallback={<CardSkeleton />}>
          <ChainStats />
        </Suspense>
      </div>

      <div className="mt-6">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
              Live Event Feed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <SystemEventFeed />
          </CardContent>
        </Card>
      </div>

      <div className="mt-6">
        <Suspense fallback={<CardSkeleton />}>
          <RecentBlocks />
        </Suspense>
      </div>
    </div>
  );
}
