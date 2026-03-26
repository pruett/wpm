/** Total WPM minted at genesis — the fixed monetary supply. */
export const INITIAL_SUPPLY = 10_000_000;

/** WPM airdropped to each new user on signup. */
export const SIGNUP_AIRDROP = 100_000;

/** Port the blockchain node listens on. */
export const NODE_PORT = 4100;

/** Port the API server listens on. */
export const API_PORT = 4101;

/** Base URL for the blockchain node's internal API. */
export const NODE_INTERNAL_URL = `http://localhost:${NODE_PORT}`;
