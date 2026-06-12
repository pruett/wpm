import { bot, telegram } from "./index";

// In polling mode initialize() starts the getUpdates loop,
// which keeps the process alive — no HTTP server needed.
await bot.initialize();

console.log(`telegram-bot running (mode: ${telegram.runtimeMode})`);
