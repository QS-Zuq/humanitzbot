/**
 * BaseRepository — abstract base for all domain repositories.
 *
 * Each repository receives a better-sqlite3 Database handle directly
 * (not the HumanitZDB facade), manages its own prepared statements,
 * and exposes domain-specific public methods.
 */

import type Database from 'better-sqlite3';
import { createLogger, type Logger } from '../../utils/log.js';

export abstract class BaseRepository {
  protected readonly _handle: Database.Database;
  protected readonly _log: Logger;

  constructor(handle: Database.Database, label?: string) {
    this._handle = handle;
    this._log = createLogger(label, this.constructor.name);
    try {
      this._prepareStatements();
    } catch (err) {
      throw new Error(
        `${this.constructor.name} failed to prepare statements: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  /** Prepare all statements needed by this repository. */
  protected abstract _prepareStatements(): void;
}
