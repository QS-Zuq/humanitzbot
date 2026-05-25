import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('panel timestamp parsing guardrails', () => {
  it('keeps DB timestamp display paths on the shared parser instead of direct Date parsing', () => {
    const files = [
      'src/web-map/public/js/panel-tab-chat.js',
      'src/web-map/public/js/panel-tab-timeline.js',
      'src/web-map/public/js/panel-shared-activity-feed.js',
      'src/web-map/public/js/panel-tab-database.js',
    ];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      assert.match(source, /parseDbTimestamp|fmtDateTime/, `${file} should use a shared DB timestamp parser/formatter`);
      assert.doesNotMatch(
        source,
        /new Date\([^)]*created_at/,
        `${file} should not directly parse created_at with Date`,
      );
    }
  });
});
