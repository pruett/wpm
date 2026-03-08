type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

type LogEntry = {
  level: LogLevel;
  msg: string;
  ts: string;
  [key: string]: unknown;
};

type Metrics = {
  blockHeight: number;
  mempoolSize: number;
  txValidated: number;
  txRejected: number;
  blocksProduced: number;
  ammTrades: number;
};

class Logger {
  private level: LogLevel;
  readonly metrics: Metrics = {
    blockHeight: 0,
    mempoolSize: 0,
    txValidated: 0,
    txRejected: 0,
    blocksProduced: 0,
    ammTrades: 0,
  };

  constructor(level?: LogLevel) {
    const envLevel = process.env.LOG_LEVEL as LogLevel | undefined;
    this.level = level ?? envLevel ?? "info";
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.level];
  }

  private write(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;
    const entry: LogEntry = {
      level,
      msg,
      ts: new Date().toISOString(),
      ...data,
    };
    const line = JSON.stringify(entry);
    if (level === "error") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.write("debug", msg, data);
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.write("info", msg, data);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.write("warn", msg, data);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.write("error", msg, data);
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }
}

export const logger = new Logger();
export type { LogLevel, Metrics };
