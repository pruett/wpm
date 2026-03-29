import { proxyToApi } from "$lib/server/proxy.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = (event) => proxyToApi(event, "/api/positions");
