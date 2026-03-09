import { Hono } from "hono";
import { trading } from "./routes/trading";
import { events } from "./routes/events";
import { auth } from "./routes/auth";
import { wallet } from "./routes/wallet";
import { markets } from "./routes/markets";
import { user } from "./routes/user";
import { leaderboard } from "./routes/leaderboard";
import { admin } from "./routes/admin";
import { oracle } from "./routes/oracle";

const app = new Hono();

app.route("/", trading);
app.route("/", events);
app.route("/", auth);
app.route("/", wallet);
app.route("/", markets);
app.route("/", user);
app.route("/", leaderboard);
app.route("/", admin);
app.route("/", oracle);
const startTime = Date.now();

const NODE_URL = process.env.NODE_URL ?? "http://localhost:3001";
const API_PORT = Number(process.env.API_PORT) || 3000;

type NodeHealth = {
  status: string;
  blockHeight: number;
  mempoolSize: number;
  uptimeMs: number;
};

app.get("/health", async (c) => {
  let nodeHealth: NodeHealth | null = null;
  let nodeReachable = false;

  try {
    const res = await fetch(`${NODE_URL}/internal/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      nodeHealth = (await res.json()) as NodeHealth;
      nodeReachable = true;
    }
  } catch {
    // node unreachable
  }

  return c.json({
    status: nodeReachable ? "ok" : "degraded",
    uptimeMs: Date.now() - startTime,
    nodeReachable,
    ...(nodeHealth && {
      node: {
        blockHeight: nodeHealth.blockHeight,
        mempoolSize: nodeHealth.mempoolSize,
      },
    }),
  });
});

const server = Bun.serve({
  fetch: app.fetch,
  port: API_PORT,
});

console.log(`API server listening on port ${server.port}`);

export { app, server };
