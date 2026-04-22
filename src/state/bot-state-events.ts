import { EventEmitter } from 'node:events';

export interface BotStateEventMap {
  'parse-error': [{ key: string; error: string; rawValue: string }];
  'shape-invalid': [{ key: string; issues: string[] }];
  'migration-failed': [{ from: string; to: string; error: string }];
}

export class BotStateEvents extends EventEmitter<BotStateEventMap> {}

/** Singleton consumed by PR2 BotStateRepository. */
export const botStateEvents = new BotStateEvents();
