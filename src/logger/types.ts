export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  category: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface LoggerOptions {
  category: string;
  level?: LogLevel;
}

export interface Transport {
  write(entry: LogEntry): void;
  close?(): void;
}
