import type Database from 'better-sqlite3';
import { BaseRepository } from './base-repository.js';

export class LeaderboardRepository extends BaseRepository {
  declare private _stmts: {
    topKillers: Database.Statement;
    topPlaytime: Database.Statement;
    topSurvival: Database.Statement;
    topFish: Database.Statement;
    topBitten: Database.Statement;
    topPvp: Database.Statement;
    topBuilders: Database.Statement;
    topDeaths: Database.Statement;
    topLooters: Database.Statement;
  };

  protected _prepareStatements(): void {
    this._stmts = {
      topKillers: this._handle.prepare(
        'SELECT steam_id, name, lifetime_kills, lifetime_headshots, lifetime_melee_kills, lifetime_gun_kills FROM players ORDER BY lifetime_kills DESC LIMIT ?',
      ),
      topPlaytime: this._handle.prepare(
        'SELECT steam_id, name, playtime_seconds, session_count FROM players ORDER BY playtime_seconds DESC LIMIT ?',
      ),
      topSurvival: this._handle.prepare(
        'SELECT steam_id, name, lifetime_days_survived, days_survived FROM players ORDER BY lifetime_days_survived DESC LIMIT ?',
      ),
      topFish: this._handle.prepare(
        'SELECT steam_id, name, fish_caught, fish_caught_pike FROM players WHERE fish_caught > 0 ORDER BY fish_caught DESC LIMIT ?',
      ),
      topBitten: this._handle.prepare(
        'SELECT steam_id, name, times_bitten FROM players WHERE times_bitten > 0 ORDER BY times_bitten DESC LIMIT ?',
      ),
      topPvp: this._handle.prepare(
        'SELECT steam_id, name, log_pvp_kills, log_pvp_deaths FROM players WHERE log_pvp_kills > 0 ORDER BY log_pvp_kills DESC LIMIT ?',
      ),
      topBuilders: this._handle.prepare(
        'SELECT steam_id, name, log_builds FROM players WHERE log_builds > 0 ORDER BY log_builds DESC LIMIT ?',
      ),
      topDeaths: this._handle.prepare(
        'SELECT steam_id, name, log_deaths, log_killed_by FROM players WHERE log_deaths > 0 ORDER BY log_deaths DESC LIMIT ?',
      ),
      topLooters: this._handle.prepare(
        'SELECT steam_id, name, log_loots FROM players WHERE log_loots > 0 ORDER BY log_loots DESC LIMIT ?',
      ),
    };
  }

  topKillers(limit = 10) {
    return this._stmts.topKillers.all(limit);
  }

  topPlaytime(limit = 10) {
    return this._stmts.topPlaytime.all(limit);
  }

  topSurvival(limit = 10) {
    return this._stmts.topSurvival.all(limit);
  }

  topFish(limit = 10) {
    return this._stmts.topFish.all(limit);
  }

  topBitten(limit = 10) {
    return this._stmts.topBitten.all(limit);
  }

  topPvp(limit = 10) {
    return this._stmts.topPvp.all(limit);
  }

  topBuilders(limit = 10) {
    return this._stmts.topBuilders.all(limit);
  }

  topDeaths(limit = 10) {
    return this._stmts.topDeaths.all(limit);
  }

  topLooters(limit = 10) {
    return this._stmts.topLooters.all(limit);
  }

  /** Aggregate server totals. */
  getServerTotals() {
    return this._handle
      .prepare(
        `
      SELECT
        COUNT(*) as total_players,
        SUM(CASE WHEN online = 1 THEN 1 ELSE 0 END) as online_players,
        SUM(lifetime_kills) as total_kills,
        SUM(lifetime_headshots) as total_headshots,
        SUM(lifetime_days_survived) as total_days,
        SUM(log_deaths) as total_deaths,
        SUM(log_pvp_kills) as total_pvp_kills,
        SUM(log_builds) as total_builds,
        SUM(log_loots) as total_loots,
        SUM(fish_caught) as total_fish,
        SUM(playtime_seconds) as total_playtime
      FROM players
    `,
      )
      .get();
  }
}
