export type CreateMarketRequest = {
  id: string;
  sport: string;
  name: string;
  teamA: string;
  teamB: string;
  tickerA?: string;
  tickerB?: string;
  logoA?: string;
  logoB?: string;
  leagueLogo?: string;
  closesAt: string;
  seedAmount: number;
  initialProbabilityA?: number;
  reserveA: number;
  reserveB: number;
  wpmReserve: number;
};

export type ResolveMarketRequest = {
  outcome: "A" | "B";
};

export type CancelMarketRequest = {
  reason?: string;
};

export const ORACLE_JOBS = ["liveness", "ingest", "resolve"] as const;
export type OracleJob = (typeof ORACLE_JOBS)[number];
export type OracleHeartbeatStatus = "ok" | "error";

export type HeartbeatRequest = {
  job: OracleJob;
  status: OracleHeartbeatStatus;
  message?: string;
};

export type OracleMarket = {
  id: string;
  sport: string;
  name: string;
  teamA: string;
  teamB: string;
  tickerA?: string;
  tickerB?: string;
  closesAt: number;
  status: "open" | "closed" | "resolved" | "cancelled";
  resolvedOutcome?: "A" | "B";
};
