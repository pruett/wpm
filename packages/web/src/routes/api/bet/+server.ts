import { proxyToApi } from "$lib/server/proxy.js";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = (event) => proxyToApi(event, "/api/bet", "POST");
