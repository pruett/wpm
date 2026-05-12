type LiveOddsProps = {
  priceYes: number;
};

export function LiveOdds({ priceYes }: LiveOddsProps) {
  const priceNo = 1 - priceYes;
  return (
    <div className="grid grid-cols-2 gap-2">
      <OddsBar label="YES" price={priceYes} />
      <OddsBar label="NO" price={priceNo} />
    </div>
  );
}

function OddsBar({ label, price }: { label: string; price: number }) {
  const pct = (price * 100).toFixed(0);

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs text-muted-foreground">{label}</span>
        <span className="font-mono text-sm font-bold tabular-nums">{pct}%</span>
      </div>
      <div className="h-1 w-full rounded-full bg-muted">
        <div
          className="h-1 rounded-full bg-foreground transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
