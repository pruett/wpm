/** Format a cent amount as dollars: `$1,000`, `$99,988.65` (whole amounts drop the cents). */
export function formatDollars(cents: number): string {
  const figure = (cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `$${figure}`;
}
