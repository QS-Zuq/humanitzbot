import type Database from 'better-sqlite3';
import { BaseRepository } from './base-repository.js';
import { type DbRow } from './db-utils.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function _parseAcFlagRow(row: unknown): DbRow | null {
  if (!row) return null;
  const parsed: DbRow = { ...(row as DbRow) };
  for (const col of ['details', 'evidence']) {
    if (parsed[col] && typeof parsed[col] === 'string') {
      try {
        parsed[col] = JSON.parse(parsed[col]) as unknown;
      } catch {
        /* leave as string */
      }
    }
  }
  parsed.auto_escalated = !!parsed.auto_escalated;
  return parsed;
}

function _parseRiskRow(row: unknown): DbRow | null {
  if (!row) return null;
  const parsed: DbRow = { ...(row as DbRow) };
  if (parsed.baseline_data && typeof parsed.baseline_data === 'string') {
    try {
      parsed.baseline_data = JSON.parse(parsed.baseline_data) as unknown;
    } catch {
      /* leave as string */
    }
  }
  return parsed;
}

function _parseFingerprintRow(row: unknown): DbRow | null {
  if (!row) return null;
  const parsed: DbRow = { ...(row as DbRow) };
  if (parsed.metadata && typeof parsed.metadata === 'string') {
    try {
      parsed.metadata = JSON.parse(parsed.metadata) as unknown;
    } catch {
      /* leave as string */
    }
  }
  return parsed;
}

function _parseFingerprintEventRow(row: unknown): DbRow | null {
  if (!row) return null;
  const parsed: DbRow = { ...(row as DbRow) };
  for (const col of ['old_state', 'new_state']) {
    if (parsed[col] && typeof parsed[col] === 'string') {
      try {
        parsed[col] = JSON.parse(parsed[col]) as unknown;
      } catch {
        /* leave as string */
      }
    }
  }
  return parsed;
}

// ─── Repository ──────────────────────────────────────────────────────────────

export class AntiCheatRepository extends BaseRepository {
  declare private _stmts: {
    // Flags
    insertAcFlag: Database.Statement;
    getAcFlags: Database.Statement;
    getAcFlagsBySteam: Database.Statement;
    getAcFlagsByDetector: Database.Statement;
    getAcFlagsSince: Database.Statement;
    getAcFlagCount: Database.Statement;
    updateAcFlagStatus: Database.Statement;
    escalateAcFlag: Database.Statement;
    // Risk scores
    upsertRiskScore: Database.Statement;
    getRiskScore: Database.Statement;
    getAllRiskScores: Database.Statement;
    // Fingerprints
    upsertFingerprint: Database.Statement;
    getFingerprint: Database.Statement;
    getFingerprintsByType: Database.Statement;
    insertFingerprintEvent: Database.Statement;
    getFingerprintEvents: Database.Statement;
  };

  protected _prepareStatements(): void {
    this._stmts = {
      // ── Anticheat: flags ────────────────────────────────────────────────────
      insertAcFlag: this._handle.prepare(`
        INSERT INTO anticheat_flags (steam_id, player_name, detector, severity, score, details, evidence, auto_escalated)
        VALUES (@steam_id, @player_name, @detector, @severity, @score, @details, @evidence, @auto_escalated)
      `),
      getAcFlags: this._handle.prepare(
        'SELECT * FROM anticheat_flags WHERE status = ? ORDER BY created_at DESC LIMIT ?',
      ),
      getAcFlagsBySteam: this._handle.prepare(
        'SELECT * FROM anticheat_flags WHERE steam_id = ? ORDER BY created_at DESC LIMIT ?',
      ),
      getAcFlagsByDetector: this._handle.prepare(
        'SELECT * FROM anticheat_flags WHERE detector = ? AND status = ? ORDER BY created_at DESC LIMIT ?',
      ),
      getAcFlagsSince: this._handle.prepare(
        'SELECT * FROM anticheat_flags WHERE steam_id = ? AND created_at >= ? ORDER BY created_at ASC',
      ),
      getAcFlagCount: this._handle.prepare(
        'SELECT COUNT(*) as count FROM anticheat_flags WHERE steam_id = ? AND severity IN (?, ?) AND status = ? AND created_at >= ?',
      ),
      updateAcFlagStatus: this._handle.prepare(
        "UPDATE anticheat_flags SET status = ?, reviewed_by = ?, reviewed_at = datetime('now'), review_notes = ? WHERE id = ?",
      ),
      escalateAcFlag: this._handle.prepare('UPDATE anticheat_flags SET severity = ?, auto_escalated = 1 WHERE id = ?'),

      // ── Anticheat: risk scores ───────────────────────────────────────────────
      upsertRiskScore: this._handle.prepare(`
        INSERT INTO player_risk_scores (steam_id, risk_score, open_flags, confirmed_flags, dismissed_flags, last_flag_at, last_scored_at, baseline_data, updated_at)
        VALUES (@steam_id, @risk_score, @open_flags, @confirmed_flags, @dismissed_flags, @last_flag_at, datetime('now'), @baseline_data, datetime('now'))
        ON CONFLICT(steam_id) DO UPDATE SET
          risk_score = excluded.risk_score,
          open_flags = excluded.open_flags,
          confirmed_flags = excluded.confirmed_flags,
          dismissed_flags = excluded.dismissed_flags,
          last_flag_at = excluded.last_flag_at,
          last_scored_at = datetime('now'),
          baseline_data = excluded.baseline_data,
          updated_at = datetime('now')
      `),
      getRiskScore: this._handle.prepare('SELECT * FROM player_risk_scores WHERE steam_id = ?'),
      getAllRiskScores: this._handle.prepare('SELECT * FROM player_risk_scores ORDER BY risk_score DESC'),

      // ── Anticheat: fingerprints ──────────────────────────────────────────────
      upsertFingerprint: this._handle.prepare(`
        INSERT INTO entity_fingerprints (entity_type, entity_id, fingerprint, parent_id, creator_steam_id, last_validated, tamper_score, metadata)
        VALUES (@entity_type, @entity_id, @fingerprint, @parent_id, @creator_steam_id, datetime('now'), @tamper_score, @metadata)
        ON CONFLICT(entity_type, entity_id) DO UPDATE SET
          fingerprint = excluded.fingerprint,
          last_validated = datetime('now'),
          tamper_score = excluded.tamper_score,
          metadata = excluded.metadata
      `),
      getFingerprint: this._handle.prepare('SELECT * FROM entity_fingerprints WHERE entity_type = ? AND entity_id = ?'),
      getFingerprintsByType: this._handle.prepare('SELECT * FROM entity_fingerprints WHERE entity_type = ?'),
      insertFingerprintEvent: this._handle.prepare(`
        INSERT INTO fingerprint_events (fingerprint_id, event_type, old_state, new_state, attributed_to, source, confidence)
        VALUES (@fingerprint_id, @event_type, @old_state, @new_state, @attributed_to, @source, @confidence)
      `),
      getFingerprintEvents: this._handle.prepare(
        'SELECT * FROM fingerprint_events WHERE fingerprint_id = ? ORDER BY created_at DESC LIMIT ?',
      ),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Anticheat — flags, risk scores, entity fingerprints
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Insert an anticheat flag.
   * @param {object} flag - { steam_id, player_name, detector, severity, score, details, evidence, auto_escalated }
   * @returns {number} The inserted flag ID
   */
  insertAcFlag(input: Record<string, unknown>): number | bigint {
    const flag = input as DbRow;
    const info = this._stmts.insertAcFlag.run({
      steam_id: flag.steam_id,
      player_name: flag.player_name || '',
      detector: flag.detector,
      severity: flag.severity || 'low',
      score: flag.score || 0,
      details: typeof flag.details === 'string' ? flag.details : JSON.stringify(flag.details || {}),
      evidence: typeof flag.evidence === 'string' ? flag.evidence : JSON.stringify(flag.evidence || []),
      auto_escalated: flag.auto_escalated ? 1 : 0,
    });
    return info.lastInsertRowid;
  }

  /** Get flags by status ('open', 'confirmed', 'dismissed', 'whitelisted'). */
  getAcFlags(status: string = 'open', limit = 100) {
    return this._stmts.getAcFlags.all(status, limit).map(_parseAcFlagRow);
  }

  /** Get all flags for a specific player. */
  getAcFlagsBySteam(steamId: string, limit = 100) {
    return this._stmts.getAcFlagsBySteam.all(steamId, limit).map(_parseAcFlagRow);
  }

  /** Get flags by detector type and status. */
  getAcFlagsByDetector(detector: string, status: string = 'open', limit = 100) {
    return this._stmts.getAcFlagsByDetector.all(detector, status, limit).map(_parseAcFlagRow);
  }

  /** Get flags for a player since a timestamp. */
  getAcFlagsSince(steamId: string, since: string) {
    return this._stmts.getAcFlagsSince.all(steamId, since).map(_parseAcFlagRow);
  }

  /** Count flags for a player matching severities and status since a timestamp. */
  getAcFlagCount(steamId: string, sev1: string, sev2: string, status: string, since: string) {
    const row = this._stmts.getAcFlagCount.get(steamId, sev1, sev2, status, since) as DbRow | undefined;
    return row?.count ?? 0;
  }

  /** Update a flag's review status. */
  updateAcFlagStatus(flagId: number, status: string, reviewedBy: string | null = null, notes: string | null = null) {
    this._stmts.updateAcFlagStatus.run(status, reviewedBy, notes, flagId);
  }

  /** Auto-escalate a flag's severity. */
  escalateAcFlag(flagId: number, newSeverity: string) {
    this._stmts.escalateAcFlag.run(newSeverity, flagId);
  }

  /**
   * Upsert a player risk score.
   * @param {object} data - { steam_id, risk_score, open_flags, confirmed_flags, dismissed_flags, last_flag_at, baseline_data }
   */
  upsertRiskScore(data: Record<string, unknown>): void {
    this._stmts.upsertRiskScore.run({
      steam_id: data.steam_id,
      risk_score: data.risk_score || 0,
      open_flags: data.open_flags || 0,
      confirmed_flags: data.confirmed_flags || 0,
      dismissed_flags: data.dismissed_flags || 0,
      last_flag_at: data.last_flag_at || null,
      baseline_data:
        typeof data.baseline_data === 'string' ? data.baseline_data : JSON.stringify(data.baseline_data || {}),
    });
  }

  /** Get a player's risk score record. */
  getRiskScore(steamId: string) {
    const row = this._stmts.getRiskScore.get(steamId);
    return row ? _parseRiskRow(row) : null;
  }

  /** Get all player risk scores, highest first. */
  getAllRiskScores() {
    return this._stmts.getAllRiskScores.all().map(_parseRiskRow);
  }

  /**
   * Upsert an entity fingerprint.
   * @param {object} fp - { entity_type, entity_id, fingerprint, parent_id, creator_steam_id, tamper_score, metadata }
   */
  upsertFingerprint(fp: Record<string, unknown>): void {
    this._stmts.upsertFingerprint.run({
      entity_type: fp.entity_type,
      entity_id: fp.entity_id,
      fingerprint: fp.fingerprint,
      parent_id: fp.parent_id || null,
      creator_steam_id: fp.creator_steam_id || null,
      tamper_score: fp.tamper_score || 0,
      metadata: typeof fp.metadata === 'string' ? fp.metadata : JSON.stringify(fp.metadata || {}),
    });
  }

  /** Get a fingerprint by entity type + id. */
  getFingerprint(entityType: string, entityId: string) {
    const row = this._stmts.getFingerprint.get(entityType, entityId);
    return row ? _parseFingerprintRow(row) : null;
  }

  /** Get all fingerprints for an entity type. */
  getFingerprintsByType(entityType: string) {
    return this._stmts.getFingerprintsByType.all(entityType).map(_parseFingerprintRow);
  }

  /**
   * Insert a fingerprint event (state change provenance).
   * @param {object} evt - { fingerprint_id, event_type, old_state, new_state, attributed_to, source, confidence }
   * @returns {number} The inserted event ID
   */
  insertFingerprintEvent(evt: Record<string, unknown>): number | bigint {
    const info = this._stmts.insertFingerprintEvent.run({
      fingerprint_id: evt.fingerprint_id,
      event_type: evt.event_type,
      old_state: typeof evt.old_state === 'string' ? evt.old_state : JSON.stringify(evt.old_state || null),
      new_state: typeof evt.new_state === 'string' ? evt.new_state : JSON.stringify(evt.new_state || null),
      attributed_to: evt.attributed_to || null,
      source: evt.source || 'inferred',
      confidence: evt.confidence ?? 1.0,
    });
    return info.lastInsertRowid;
  }

  /** Get events for a fingerprint. */
  getFingerprintEvents(fingerprintId: number, limit = 50) {
    return this._stmts.getFingerprintEvents.all(fingerprintId, limit).map(_parseFingerprintEventRow);
  }
}
