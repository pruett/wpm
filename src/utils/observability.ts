/**
 * Surface an LLM generation failure in a shape our logs/observability can alert
 * on. Both the settlement roast and the weekly recap call the model behind a
 * try/catch that falls back to deterministic text — so generation NEVER throws to
 * the caller, and this log line is the only signal that an announcement quietly
 * lost its LLM flavor (e.g. a bad/expired ANTHROPIC_API_KEY, a 4xx/5xx from the
 * provider, a rate limit, or an empty completion).
 *
 * The AI SDK throws `AI_APICallError` with the useful bits (HTTP status, the
 * provider's response body) hanging off the error object; a bare
 * `console.error(error)` collapses those on Vercel. We pull them out and prefix
 * the line with a stable marker — LLM_GENERATION_FAILED — so a Vercel log drain
 * or alert can match on it. Keep the marker string stable; alerts key off it.
 */
export function reportLlmFailure(scope: string, model: string, error: unknown): void {
  const e = error as {
    name?: string;
    statusCode?: number;
    responseBody?: string;
    message?: string;
  };
  console.error(
    "LLM_GENERATION_FAILED",
    JSON.stringify({
      scope,
      model,
      name: e?.name ?? null,
      statusCode: e?.statusCode ?? null,
      message: e?.message ?? String(error),
      // The provider response body is the most useful field for diagnosis
      // (auth_error vs rate_limit vs overloaded); cap it so logs stay readable.
      responseBody:
        typeof e?.responseBody === "string" ? e.responseBody.slice(0, 500) : null,
    }),
  );
}
