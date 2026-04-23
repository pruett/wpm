export function Balance({ balance }: { balance: number }) {
  return (
    <span className="font-mono text-sm tabular-nums">
      {balance.toLocaleString()} <span className="text-muted-foreground">WPM</span>
    </span>
  );
}
