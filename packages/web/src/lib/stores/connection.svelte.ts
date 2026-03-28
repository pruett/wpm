export type ConnectionStatus = "connected" | "degraded" | "disconnected" | "checking";

let _status = $state<ConnectionStatus>("checking");
let _detail = $state("");
let interval: ReturnType<typeof setInterval> | null = null;

async function check() {
  try {
    const res = await fetch("/api/health");
    const body = await res.json();
    if (res.ok && body.node) {
      _status = "connected";
      _detail = "API and node are reachable";
    } else if (res.status === 503 || !body.node) {
      _status = "degraded";
      _detail = "API is up but blockchain node is down";
    } else {
      _status = "disconnected";
      _detail = "Unable to reach backend services";
    }
  } catch {
    _status = "disconnected";
    _detail = "Unable to reach backend services";
  }
}

export const connection = {
  get status() {
    return _status;
  },

  get detail() {
    return _detail;
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
