import type Database from 'better-sqlite3';
import { BaseRepository } from './base-repository.js';

export class DeathCauseRepository extends BaseRepository {
  declare private _stmts: {
    insertDeathCause: Database.Statement;
    getDeathCauses: Database.Statement;
    getDeathCausesByPlayer: Database.Statement;
    getDeathCauseStats: Database.Statement;
    getDeathCausesSince: Database.Statement;
  };

  protected _prepareStatements(): void {
    this._stmts = {
      insertDeathCause: this._handle.prepare(`
      INSERT INTO death_causes (victim_name, victim_steam_id, cause_type, cause_name, cause_raw, damage_total, pos_x, pos_y, pos_z)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
      getDeathCauses: this._handle.prepare('SELECT * FROM death_causes ORDER BY created_at DESC LIMIT ?'),
      getDeathCausesByPlayer: this._handle.prepare(
        'SELECT * FROM death_causes WHERE victim_name = ? OR victim_steam_id = ? ORDER BY created_at DESC LIMIT ?',
      ),
      getDeathCauseStats: this._handle.prepare(
        'SELECT cause_type, cause_name, COUNT(*) as count FROM death_causes GROUP BY cause_type, cause_name ORDER BY count DESC',
      ),
      getDeathCausesSince: this._handle.prepare(
        'SELECT * FROM death_causes WHERE created_at >= ? ORDER BY created_at ASC',
      ),
    };
  }

  /**
   * Record a death cause attribution.
   * @param {object} data
   * @param {string} data.victimName
   * @param {string} [data.victimSteamId]
   * @param {string} data.causeType   - 'zombie', 'animal', 'bandit', 'player', 'environment', 'unknown'
   * @param {string} data.causeName   - classified name ('Runner', 'Wolf', 'PlayerX')
   * @param {string} [data.causeRaw]  - raw BP_ blueprint name
   * @param {number} [data.damageTotal]
   * @param {number} [data.x]
   * @param {number} [data.y]
   * @param {number} [data.z]
   */
  insertDeathCause(data: Record<string, unknown>): void {
    this._stmts.insertDeathCause.run(
      data.victimName,
      data.victimSteamId || '',
      data.causeType,
      data.causeName || '',
      data.causeRaw || '',
      data.damageTotal || 0,
      data.x ?? null,
      data.y ?? null,
      data.z ?? null,
    );
  }

  /** Get recent death causes. */
  getDeathCauses(limit = 50) {
    return this._stmts.getDeathCauses.all(limit);
  }

  /** Get death causes for a specific player. */
  getDeathCausesByPlayer(nameOrSteamId: string, limit = 50) {
    return this._stmts.getDeathCausesByPlayer.all(nameOrSteamId, nameOrSteamId, limit);
  }

  /** Get death cause statistics (grouped by cause_type + cause_name). */
  getDeathCauseStats() {
    return this._stmts.getDeathCauseStats.all();
  }

  /** Get death causes since a timestamp. */
  getDeathCausesSince(since: string) {
    return this._stmts.getDeathCausesSince.all(since);
  }
}
