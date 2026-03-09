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
import { info, warn } from "./logger";
import { getRelay } from "./sse/relay";
import { closeDb } from "./db/index";
import { createNodeClient, getNodeUrl } from "./node-client";

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

// Request/response logging — log on completion with duration
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const durationMs = Date.now() - start;
  const statusCode = c.res.status;
  const userId = (c.get("user" as never) as { sub?: string } | undefined)?.sub;
  const fields = {
    requestId: c.get("requestId"),
    method: c.req.method,
    path: c.req.path,
    statusCode,
    durationMs,
    ...(userId && { userId }),
  };
  if (statusCode >= 500) {
    warn("request completed with server error", fields);
  } else {
    info("request completed", fields);
  }
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

const API_PORT = Number(process.env.API_PORT) || 3000;

app.get("/health", async (c) => {
  const node = createNodeClient(getNodeUrl());
  const nodeResult = await node.getHealth();

  return c.json({
    status: nodeResult.ok ? "ok" : "degraded",
    uptimeMs: Date.now() - startTime,
    nodeReachable: nodeResult.ok,
    ...(nodeResult.ok && {
      node: {
        blockHeight: nodeResult.data.blockHeight,
        mempoolSize: nodeResult.data.mempoolSize,
      },
    }),
  });
});

const server = Bun.serve({
  fetch: app.fetch,
  port: API_PORT,
});

info("API server started", { port: server.port });

function shutdown() {
  info("Graceful shutdown initiated");
  server.stop();
  try {
    getRelay().close();
  } catch {
    // SSE relay not initialized — nothing to close
  }
  closeDb();
  info("Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

export { app, server };
