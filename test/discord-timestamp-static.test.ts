import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('Discord timestamp parsing guardrails', () => {
  it('routes DB-backed Discord date displays through the UTC DB timestamp parser', () => {
    const files = [
      'src/commands/panel.ts',
      'src/modules/player-embed.ts',
      'src/modules/player-stats-embeds.ts',
      'src/modules/server-status-embeds.ts',
    ];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      assert.match(source, /parseDbTimestampUtc/, `${file} should parse DB-backed timestamps as UTC`);
      assert.doesNotMatch(
        source,
        /new Date\((?:b\.completed_at|schedule\.(?:last_run_at|next_run_at)|stats\.lastEvent|f\.timestamp|resolved\.(?:firstSeen|lastActive)|peaks\.allTimePeakDate|playtimeTracker\.getTrackingSince\(\))/,
        `${file} should not parse DB-backed timestamp strings directly with Date`,
      );
    }
  });
});
