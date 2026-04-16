export function extractEspnId(marketId: string): string | undefined {
  const match = marketId.match(/^(?:nfl|mlb)-(\d+)$/);
  return match?.[1];
}

export function extractGolfIds(
  marketId: string,
): { tournamentId: string; competitorId: string } | undefined {
  const match = marketId.match(/^golf-pga-(\d+)-(\d+)$/);
  if (!match) return undefined;
  return { tournamentId: match[1], competitorId: match[2] };
}
