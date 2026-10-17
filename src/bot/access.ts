// Telegram-id allowlists read from comma-separated env vars. Ids, not
// usernames: usernames are mutable and anyone can rename themselves into one.

function idsFromEnv(name: string): Set<string> {
  return new Set(
    (process.env[name] ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

/** Telegram user ids allowed to run admin commands like /gift. */
export function isAdmin(telegramId: string): boolean {
  return idsFromEnv("TELEGRAM_ADMIN_IDS").has(telegramId);
}

/**
 * Telegram user ids allowed to open a new account via /start. The bot is
 * publicly discoverable and Telegram sends /start on first contact, so
 * without this any stranger who opens it gets a seeded bankroll. Admins are
 * always allowed; an unset TELEGRAM_ALLOWED_IDS admits admins only.
 */
export function canRegister(telegramId: string): boolean {
  return isAdmin(telegramId) || idsFromEnv("TELEGRAM_ALLOWED_IDS").has(telegramId);
}
