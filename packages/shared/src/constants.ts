/** Total WPM minted at genesis — the fixed monetary supply. */
export const INITIAL_SUPPLY = 10_000_000;

/** WPM airdropped to each new user on signup. */
export const SIGNUP_AIRDROP = 100_000;

/** Port the blockchain node listens on. Override with NODE_PORT env var. */
export const NODE_PORT = Number(globalThis.process?.env?.NODE_PORT) || 4100;

/** Port the API server listens on. Override with API_PORT env var. */
export const API_PORT = Number(globalThis.process?.env?.API_PORT) || 4101;

/** Base URL for the blockchain node's internal API. Override with NODE_URL env var. */
export const NODE_INTERNAL_URL =
  globalThis.process?.env?.NODE_URL || `http://localhost:${NODE_PORT}`;

/** Base URL for the Effect API server. Override with API_URL env var. */
export const API_URL = globalThis.process?.env?.API_URL || `http://localhost:${API_PORT}`;

/** Port the web app listens on. Override with WEB_PORT env var. */
export const WEB_PORT = Number(globalThis.process?.env?.WEB_PORT) || 3000;

/** Base URL for the web app's internal API. Override with WEB_INTERNAL_URL env var. */
export const WEB_INTERNAL_URL =
  globalThis.process?.env?.WEB_INTERNAL_URL || `http://localhost:${WEB_PORT}`;
