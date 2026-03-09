import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { authRateLimit, adminRateLimit, userRateLimit } from "./middleware/rate-limit";
import { trading } from "./routes/trading";
import { events } from "./routes/events";
import { auth } from "./routes/auth";
import { wallet } from "./routes/wallet";
import { markets } from "./routes/markets";
import { user } from "./routes/user";
import { leaderboard } from "./routes/leaderboard";
import { admin } from "./routes/admin";
import { oracle } from "./routes/oracle";

type AppEnv = {
  Variables: {
    requestId: string;
  };
};

const app = new Hono<AppEnv>();

// CORS — allow configured origin (default: https://wpm.example.com)
app.use(
  "*",
  cors({
    origin: process.env.CORS_ORIGIN ?? "https://wpm.example.com",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

// Request body size limit — 64 KB
app.use(
  "*",
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Request body too large (max 64 KB)" } },
        413,
      );
    },
  }),
);

// X-Request-Id — unique ID per request
app.use("*", async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  c.header("X-Request-Id", requestId);
  await next();
});

// Rate limiting — 10/min auth (IP), 120/min admin (IP), 60/min user (userId)
app.use("/auth/*", authRateLimit);
app.use("/admin/*", adminRateLimit);
app.use("/wallet/*", userRateLimit);
app.use("/markets/*", userRateLimit);
app.use("/user/*", userRateLimit);
app.use("/leaderboard/*", userRateLimit);

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
