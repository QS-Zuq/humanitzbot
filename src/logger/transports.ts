import fs from 'node:fs';
import path from 'node:path';
import type { LogEntry, Transport } from './types.js';

/** Console transport — writes structured JSON to stdout/stderr. */
export class ConsoleTransport implements Transport {
  write(entry: LogEntry): void {
    const line = JSON.stringify(entry);
    if (entry.level === 'error' || entry.level === 'warn') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }
}

/** File transport — writes JSON lines to daily-rotated log files. */
export class FileTransport implements Transport {
  private readonly dir: string;
  private currentDate = '';
  private stream: fs.WriteStream | null = null;

  constructor(logDir: string) {
    this.dir = logDir;
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  write(entry: LogEntry): void {
    const date = entry.timestamp.slice(0, 10); // YYYY-MM-DD
    if (date !== this.currentDate) {
      this.rotateStream(date);
    }
    this.stream?.write(JSON.stringify(entry) + '\n');
  }

  close(): void {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }

  private rotateStream(date: string): void {
    this.close();
    this.currentDate = date;
    const filePath = path.join(this.dir, `${date}.jsonl`);
    this.stream = fs.createWriteStream(filePath, { flags: 'a' });
    this.stream.on('error', (err) => {
      process.stderr.write(`[LOGGER] File transport error: ${err.message}\n`);
    });
  }
}
