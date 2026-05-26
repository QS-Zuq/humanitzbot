import type Database from 'better-sqlite3';
import { BaseRepository } from './base-repository.js';

export class QuestRepository extends BaseRepository {
  declare private _stmts: {
    clearQuests: Database.Statement;
    insertQuest: Database.Statement;
  };

  protected _prepareStatements(): void {
    this._stmts = {
      clearQuests: this._handle.prepare('DELETE FROM quests'),
      insertQuest: this._handle.prepare(
        "INSERT INTO quests (id, type, state, data, updated_at) VALUES (?, ?, ?, ?, datetime('now'))",
      ),
    };
  }

  /** Replace all quests in a transaction. For standalone use. */
  replaceQuests(quests: Array<Record<string, unknown>>): void {
    this._handle.transaction(() => {
      this.innerReplaceQuests(quests);
    })();
  }

  /** Inner replace — no transaction wrapper. Safe to call inside an outer transaction. */
  innerReplaceQuests(quests: Array<Record<string, unknown>>): void {
    this._stmts.clearQuests.run();
    for (const q of quests) {
      this._stmts.insertQuest.run(q.id, q.type, q.state, JSON.stringify(q.data));
    }
  }
}
