import type { MiddlewareHandler } from "hono";
import type { JwtUserPayload } from "./auth";
import { sendError } from "../errors";

type AdminEnv = {
  Variables: {
    user: JwtUserPayload;
  };
};

const adminMiddleware: MiddlewareHandler<AdminEnv> = async (c, next) => {
  const user = c.get("user");
  if (!user || user.role !== "admin") {
    return sendError(c, "FORBIDDEN");
  }
  await next();
};

export { adminMiddleware };
export type { AdminEnv };
