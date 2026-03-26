import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/svelte";
import type { MarketWithOdds } from "@wpm/shared";
import MarketCard from "../src/components/market-card.svelte";

const baseMarket: MarketWithOdds = {
  id: "market-1",
  name: "Eagles vs Chiefs",
  outcomes: ["Eagles", "Chiefs"] as [string, string],
  closesAt: "2026-02-09T23:00:00Z",
  status: "open",
  priceA: 0.55,
  priceB: 0.45,
  multiplierA: 1.82,
  multiplierB: 2.22,
  pool: {
    marketId: "market-1",
    sharesA: 4500,
    sharesB: 5500,
    k: 24750000,
    liquidity: 10000,
  },
};

describe("MarketCard", () => {
  it("renders market name and outcomes", () => {
    render(MarketCard, { props: { market: baseMarket } });

    expect(screen.getByText("Eagles vs Chiefs")).toBeInTheDocument();
    expect(screen.getByText("Eagles")).toBeInTheDocument();
    expect(screen.getByText("Chiefs")).toBeInTheDocument();
  });

  it("shows probability percentages", () => {
    render(MarketCard, { props: { market: baseMarket } });

    expect(screen.getByText("55%")).toBeInTheDocument();
    expect(screen.getByText("45%")).toBeInTheDocument();
  });

  it("shows Live badge for open markets", () => {
    render(MarketCard, { props: { market: baseMarket } });

    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it("shows Resolved badge for resolved markets", () => {
    const resolved: MarketWithOdds = {
      ...baseMarket,
      status: "resolved",
      result: "A",
      priceA: 1,
      priceB: 0,
      multiplierA: 1,
      multiplierB: 0,
    };

    render(MarketCard, { props: { market: resolved } });

    expect(screen.getByText("Resolved")).toBeInTheDocument();
  });

  it("shows Cancelled badge for cancelled markets", () => {
    const cancelled: MarketWithOdds = {
      ...baseMarket,
      status: "cancelled",
    };

    render(MarketCard, { props: { market: cancelled } });

    expect(screen.getByText("Cancelled")).toBeInTheDocument();
  });

  it("shows Closed badge for closed markets", () => {
    const closed: MarketWithOdds = {
      ...baseMarket,
      status: "closed",
    };

    render(MarketCard, { props: { market: closed } });

    expect(screen.getByText("Closed")).toBeInTheDocument();
  });
});
