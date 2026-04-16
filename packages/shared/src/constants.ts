/** Total WPM minted at genesis — the fixed monetary supply. */
export const INITIAL_SUPPLY = 10_000_000;

/** WPM airdropped to each new user on signup. */
export const SIGNUP_AIRDROP = 100_000;

/** Base URL for the web app's internal API. Override with WEB_INTERNAL_URL env var. */
export const WEB_INTERNAL_URL =
  globalThis.process?.env?.WEB_INTERNAL_URL || "http://localhost:4102";
