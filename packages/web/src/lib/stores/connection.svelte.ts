export type ConnectionStatus = "connected" | "disconnected" | "checking";

let _status = $state<ConnectionStatus>("checking");
let interval: ReturnType<typeof setInterval> | null = null;

async function check() {
  try {
    const res = await fetch("/api/health");
    _status = res.ok ? "connected" : "disconnected";
  } catch {
    _status = "disconnected";
  }
}

export const connection = {
  get status() {
    return _status;
  },

  start(pollMs = 5000) {
    check();
    interval = setInterval(check, pollMs);
  },

  stop() {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
  },
};
