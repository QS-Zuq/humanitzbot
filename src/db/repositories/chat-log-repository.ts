import type Database from 'better-sqlite3';
import { BaseRepository } from './base-repository.js';
import { type DbRow } from './db-utils.js';

export class ChatLogRepository extends BaseRepository {
  declare private _stmts: {
    insertChat: Database.Statement;
    insertChatAt: Database.Statement;
    getRecentChat: Database.Statement;
    searchChat: Database.Statement;
    getChatSince: Database.Statement;
    clearChatLog: Database.Statement;
    purgeOldChat: Database.Statement;
    countChat: Database.Statement;
  };

  protected _prepareStatements(): void {
    this._stmts = {
      insertChat: this._handle.prepare(`
      INSERT INTO chat_log (type, player_name, steam_id, message, direction, discord_user, is_admin)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
      insertChatAt: this._handle.prepare(`
      INSERT INTO chat_log (type, player_name, steam_id, message, direction, discord_user, is_admin, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
      getRecentChat: this._handle.prepare('SELECT * FROM chat_log ORDER BY created_at DESC, id DESC LIMIT ?'),
      searchChat: this._handle.prepare(
        'SELECT * FROM chat_log WHERE (message LIKE ? OR player_name LIKE ?) ORDER BY created_at DESC, id DESC LIMIT ?',
      ),
      getChatSince: this._handle.prepare(
        'SELECT * FROM chat_log WHERE created_at >= ? ORDER BY created_at ASC, id ASC',
      ),
      clearChatLog: this._handle.prepare('DELETE FROM chat_log'),
      purgeOldChat: this._handle.prepare("DELETE FROM chat_log WHERE created_at < datetime('now', ?)"),
      countChat: this._handle.prepare('SELECT COUNT(*) as count FROM chat_log'),
    };
  }

  /**
   * Insert a single chat log entry.
   * @param {object} entry - { type, playerName, steamId, message, direction, discordUser, isAdmin }
   */
  insertChat(entry: Record<string, unknown>) {
    this._stmts.insertChat.run(
      entry.type,
      entry.playerName || '',
      entry.steamId || '',
      entry.message || '',
      entry.direction || 'game',
      entry.discordUser || '',
      entry.isAdmin ? 1 : 0,
    );
  }

  /**
   * Insert a chat entry with explicit timestamp (for backfill).
   * @param {object} entry - includes createdAt ISO string
   */
  insertChatAt(entry: Record<string, unknown>) {
    this._stmts.insertChatAt.run(
      entry.type,
      entry.playerName || '',
      entry.steamId || '',
      entry.message || '',
      entry.direction || 'game',
      entry.discordUser || '',
      entry.isAdmin ? 1 : 0,
      entry.createdAt,
    );
  }

  /** Get the most recent N chat entries. */
  getRecentChat(limit = 50) {
    return this._stmts.getRecentChat.all(limit);
  }

  /** Search chat messages by text or player name. */
  searchChat(query: string, limit = 200) {
    const pattern = '%' + query + '%';
    return this._stmts.searchChat.all(pattern, pattern, limit);
  }

  /** Get all chat since a given ISO timestamp. */
  getChatSince(isoTimestamp: string) {
    return this._stmts.getChatSince.all(isoTimestamp);
  }

  /** Delete all chat log entries. */
  clearChatLog() {
    this._stmts.clearChatLog.run();
  }

  /** Purge old chat entries (e.g. '-30 days'). */
  purgeOldChat(olderThan: string) {
    return this._stmts.purgeOldChat.run(olderThan);
  }

  /** Count total chat entries. */
  getChatCount() {
    const row = this._stmts.countChat.get() as DbRow | undefined;
    return row?.count || 0;
  }
}
