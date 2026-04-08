import type Database from 'better-sqlite3';
import { BaseRepository } from './base-repository.js';
import { type DbRow } from './db-utils.js';

export class ClanRepository extends BaseRepository {
  declare private _stmts: {
    upsertClan: Database.Statement;
    deleteClanMembers: Database.Statement;
    insertClanMember: Database.Statement;
    getAllClans: Database.Statement;
    getClanMembers: Database.Statement;
    getClanForSteamId: Database.Statement;
    areClanmates: Database.Statement;
  };

  protected _prepareStatements(): void {
    this._stmts = {
      upsertClan: this._handle.prepare("INSERT OR REPLACE INTO clans (name, updated_at) VALUES (?, datetime('now'))"),
      deleteClanMembers: this._handle.prepare('DELETE FROM clan_members WHERE clan_name = ?'),
      insertClanMember: this._handle.prepare(
        'INSERT OR REPLACE INTO clan_members (clan_name, steam_id, name, rank, can_invite, can_kick) VALUES (?, ?, ?, ?, ?, ?)',
      ),
      getAllClans: this._handle.prepare('SELECT * FROM clans ORDER BY name'),
      getClanMembers: this._handle.prepare('SELECT * FROM clan_members WHERE clan_name = ? ORDER BY rank DESC, name'),
      getClanForSteamId: this._handle.prepare('SELECT clan_name FROM clan_members WHERE steam_id = ? LIMIT 1'),
      areClanmates: this._handle.prepare(
        `SELECT 1 FROM clan_members a JOIN clan_members b ON a.clan_name = b.clan_name WHERE a.steam_id = ? AND b.steam_id = ? LIMIT 1`,
      ),
    };
  }

  upsertClan(name: string, members: Array<Record<string, unknown>>) {
    const tx = this._handle.transaction(() => {
      this._stmts.upsertClan.run(name);
      this._stmts.deleteClanMembers.run(name);
      for (const m of members) {
        this._stmts.insertClanMember.run(name, m.steamId, m.name, m.rank, m.canInvite ? 1 : 0, m.canKick ? 1 : 0);
      }
    });
    tx();
  }

  getAllClans() {
    const rows = this._handle
      .prepare(
        `SELECT c.name as clan_name, c.updated_at, cm.steam_id, cm.name as member_name, cm.rank, cm.can_invite, cm.can_kick
         FROM clans c
         LEFT JOIN clan_members cm ON c.name = cm.clan_name
         ORDER BY c.name, cm.rank DESC, cm.name`,
      )
      .all() as DbRow[];

    const clansMap = new Map<string, DbRow & { members: DbRow[] }>();
    for (const row of rows) {
      const clanName = row.clan_name as string;
      if (!clansMap.has(clanName)) {
        clansMap.set(clanName, { name: clanName, updated_at: row.updated_at, members: [] });
      }
      const clan = clansMap.get(clanName);
      if (row.steam_id && clan) {
        clan.members.push({
          steamId: row.steam_id,
          name: row.member_name,
          rank: row.rank,
          canInvite: row.can_invite,
          canKick: row.can_kick,
          steam_id: row.steam_id,
          can_invite: row.can_invite,
          can_kick: row.can_kick,
        });
      }
    }
    return [...clansMap.values()];
  }

  /**
   * Check if two steam IDs are in the same clan.
   * @param {string} steamId1
   * @param {string} steamId2
   * @returns {boolean}
   */
  areClanmates(steamId1: string, steamId2: string) {
    if (!steamId1 || !steamId2 || steamId1 === steamId2) return false;
    return !!this._stmts.areClanmates.get(steamId1, steamId2);
  }

  /**
   * Get the clan name for a steam ID, or null.
   * @param {string} steamId
   * @returns {string|null}
   */
  getClanForSteamId(steamId: string) {
    if (!steamId) return null;
    const row = this._stmts.getClanForSteamId.get(steamId) as DbRow | undefined;
    return row ? row.clan_name : null;
  }
}
