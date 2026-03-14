'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// config.js side effects need these env vars set first
process.env.DISCORD_TOKEN = 'test';
process.env.DISCORD_CLIENT_ID = '123';
process.env.DISCORD_GUILD_ID = '456';

const {
  _test: {
    _formatBotUptime,
    _modalTitle,
    _countComponents,
    _errorSummary,
    _diagnosticToMarkdown,
    _toComponentJSON,
    _textDisplay,
    _container,
    _componentsKey,
  },
} = require('../src/modules/panel-channel');

// ── _formatBotUptime ─────────────────────────────────────────────────────────

describe('_formatBotUptime', () => {
  it('returns "0m" for 0 ms', () => {
    assert.equal(_formatBotUptime(0), '0m');
  });

  it('returns "0m" for sub-minute durations', () => {
    assert.equal(_formatBotUptime(30_000), '0m');
    assert.equal(_formatBotUptime(59_999), '0m');
  });

  it('formats exact minutes', () => {
    assert.equal(_formatBotUptime(60_000), '1m');
    assert.equal(_formatBotUptime(5 * 60_000), '5m');
  });

  it('includes hours and minutes', () => {
    // 2h 30m
    assert.equal(_formatBotUptime((2 * 3600 + 30 * 60) * 1000), '2h 30m');
  });

  it('shows 0h when days present but hours are 0', () => {
    // 1d exactly → hours=0 but days>0 so "0h" is shown
    assert.equal(_formatBotUptime(86400 * 1000), '1d 0h 0m');
  });

  it('formats days + hours + minutes', () => {
    // 3d 5h 12m
    const ms = (3 * 86400 + 5 * 3600 + 12 * 60) * 1000;
    assert.equal(_formatBotUptime(ms), '3d 5h 12m');
  });

  it('handles large values', () => {
    // 100d 0h 0m
    assert.equal(_formatBotUptime(100 * 86400 * 1000), '100d 0h 0m');
  });
});

// ── _modalTitle ──────────────────────────────────────────────────────────────

describe('_modalTitle', () => {
  it('returns short strings unchanged', () => {
    assert.equal(_modalTitle('Hello'), 'Hello');
  });

  it('returns strings at exactly max length unchanged', () => {
    const s = 'A'.repeat(45);
    assert.equal(_modalTitle(s), s);
  });

  it('truncates strings exceeding default max (45)', () => {
    const s = 'B'.repeat(50);
    const result = _modalTitle(s);
    assert.ok(result.length <= 45);
    assert.ok(result.endsWith('...'));
  });

  it('respects custom max parameter', () => {
    const result = _modalTitle('Hello World', 8);
    assert.ok(result.length <= 8);
    assert.ok(result.endsWith('...'));
    assert.equal(result, 'Hello...');
  });

  it('handles null input by converting to empty string', () => {
    assert.equal(_modalTitle(null), '');
  });

  it('handles undefined input', () => {
    assert.equal(_modalTitle(undefined), '');
  });

  it('converts non-string input via String()', () => {
    assert.equal(_modalTitle(12345), '12345');
  });

  it('avoids splitting surrogate pairs', () => {
    // \uD83D\uDE00 = 😀 (2 code units). Place it so truncation would split it.
    // max=5, suffix='...' (3 chars), keep=2 → slice(0,2) would be the emoji
    const emoji = '\uD83D\uDE00'; // 😀
    const s = emoji + 'ABCDEFGH'; // length 10
    const result = _modalTitle(s, 5);
    // keep = max(1, 5-3) = 2; base = s.slice(0,2) = emoji; last char is low surrogate \uDE00
    // Actually: charCodeAt(1) is 0xDE00 (low surrogate), not high surrogate → no trim
    assert.ok(result.length <= 5);
    assert.ok(result.endsWith('...'));
  });

  it('trims dangling high surrogate at truncation boundary', () => {
    // Build a string where the high surrogate lands exactly at the cut point
    // keep = max(1, 6-3) = 3; if char at index 2 is a high surrogate, it should be dropped
    const s = 'AB\uD83D\uDE00CDEF'; // length=8 (A, B, \uD83D, \uDE00, C, D, E, F)
    const result = _modalTitle(s, 6);
    // base = s.slice(0,3) = 'AB\uD83D'; last char is high surrogate → trimmed to 'AB'
    assert.equal(result, 'AB...');
  });

  it('returns empty string for empty input', () => {
    assert.equal(_modalTitle(''), '');
  });
});

// ── _countComponents ─────────────────────────────────────────────────────────

describe('_countComponents', () => {
  it('returns 0 for empty array', () => {
    assert.equal(_countComponents([]), 0);
  });

  it('returns 0 for undefined (default param)', () => {
    assert.equal(_countComponents(), 0);
  });

  it('counts flat components', () => {
    assert.equal(_countComponents([{ type: 1 }, { type: 2 }, { type: 3 }]), 3);
  });

  it('counts nested components arrays', () => {
    const tree = [
      {
        type: 17,
        components: [{ type: 10 }, { type: 10 }],
      },
    ];
    // 1 container + 2 text displays = 3
    assert.equal(_countComponents(tree), 3);
  });

  it('counts accessory objects', () => {
    const tree = [
      {
        type: 10,
        accessory: { type: 2 },
      },
    ];
    // 1 text + 1 accessory = 2
    assert.equal(_countComponents(tree), 2);
  });

  it('handles deep nesting', () => {
    const tree = [
      {
        type: 17,
        components: [
          {
            type: 17,
            components: [{ type: 10 }],
          },
        ],
      },
    ];
    // outer container(1) + inner container(1) + text(1) = 3
    assert.equal(_countComponents(tree), 3);
  });

  it('skips null/undefined entries', () => {
    assert.equal(_countComponents([null, undefined, { type: 1 }]), 1);
  });

  it('skips non-object entries', () => {
    assert.equal(_countComponents([42, 'string', true, { type: 1 }]), 1);
  });

  it('counts both nested components and accessory', () => {
    const tree = [
      {
        type: 17,
        components: [{ type: 10 }],
        accessory: { type: 2 },
      },
    ];
    // container(1) + text(1) + accessory(1) = 3
    assert.equal(_countComponents(tree), 3);
  });
});

// ── _errorSummary ────────────────────────────────────────────────────────────

describe('_errorSummary', () => {
  it('returns empty string for null/undefined', () => {
    assert.equal(_errorSummary(null), '');
    assert.equal(_errorSummary(undefined), '');
  });

  it('includes error message', () => {
    const result = _errorSummary({ message: 'something broke' });
    assert.ok(result.includes('something broke'));
  });

  it('includes error code', () => {
    const result = _errorSummary({ code: 50001 });
    assert.ok(result.includes('code=50001'));
  });

  it('includes rawError.message as api=', () => {
    const result = _errorSummary({ rawError: { message: 'Missing Access' } });
    assert.ok(result.includes('api=Missing Access'));
  });

  it('joins all parts with pipe separator', () => {
    const result = _errorSummary({
      message: 'fail',
      code: 123,
      rawError: { message: 'denied' },
    });
    assert.equal(result, 'fail | code=123 | api=denied');
  });

  it('includes stringified rawError.errors', () => {
    const result = _errorSummary({
      rawError: { errors: { field: 'invalid' } },
    });
    assert.ok(result.includes('{"field":"invalid"}'));
  });

  it('handles rawError.errors that fail to stringify', () => {
    const circular = {};
    circular.self = circular;
    // Should not throw — the try/catch inside _errorSummary catches it
    const result = _errorSummary({ rawError: { errors: circular } });
    assert.equal(typeof result, 'string');
  });
});

// ── _diagnosticToMarkdown ────────────────────────────────────────────────────

describe('_diagnosticToMarkdown', () => {
  it('converts raw object with title and description', () => {
    const result = _diagnosticToMarkdown({ title: 'Test', description: 'Desc' });
    assert.ok(result.includes('## Test'));
    assert.ok(result.includes('Desc'));
  });

  it('converts object with fields', () => {
    const result = _diagnosticToMarkdown({
      fields: [{ name: 'Section', value: 'Content' }],
    });
    assert.ok(result.includes('### Section'));
    assert.ok(result.includes('Content'));
  });

  it('uses sectionLabel for fields without name', () => {
    const result = _diagnosticToMarkdown({ fields: [{ value: 'val' }] }, '', 'Custom');
    assert.ok(result.includes('### Custom'));
  });

  it('uses dash for fields without value', () => {
    const result = _diagnosticToMarkdown({
      fields: [{ name: 'Empty' }],
    });
    assert.ok(result.includes('-'));
  });

  it('includes footer text with -# prefix', () => {
    const result = _diagnosticToMarkdown({
      footer: { text: 'Footer info' },
    });
    assert.ok(result.includes('-# Footer info'));
  });

  it('returns emptyText when input produces no content', () => {
    assert.equal(_diagnosticToMarkdown({}, 'N/A'), 'N/A');
    assert.equal(_diagnosticToMarkdown(null, 'empty'), 'empty');
  });

  it('handles object with .toJSON() method', () => {
    const obj = {
      toJSON() {
        return { title: 'From toJSON', description: 'works' };
      },
    };
    const result = _diagnosticToMarkdown(obj);
    assert.ok(result.includes('## From toJSON'));
    assert.ok(result.includes('works'));
  });

  it('handles object with .data property', () => {
    const obj = {
      data: { title: 'From data', description: 'also works' },
    };
    const result = _diagnosticToMarkdown(obj);
    assert.ok(result.includes('## From data'));
    assert.ok(result.includes('also works'));
  });

  it('truncates output exceeding 3900 chars', () => {
    const longDesc = 'X'.repeat(4000);
    const result = _diagnosticToMarkdown({ description: longDesc });
    assert.ok(result.length <= 3900);
    assert.ok(result.endsWith('...'));
  });

  it('does not truncate output at exactly 3900 chars', () => {
    // title "## T" = 4 chars, then \n\n = 2, total overhead = 6
    // We need text.length <= 3900 to not truncate
    const desc = 'Y'.repeat(3894); // ## T\n\nYYY... → total after trim = 3900
    const result = _diagnosticToMarkdown({ title: 'T', description: desc });
    assert.ok(!result.endsWith('...') || result.length <= 3900);
  });

  it('skips null fields in array', () => {
    const result = _diagnosticToMarkdown({
      fields: [null, { name: 'Valid', value: 'ok' }],
    });
    assert.ok(result.includes('### Valid'));
  });
});

// ── _toComponentJSON ─────────────────────────────────────────────────────────

describe('_toComponentJSON', () => {
  it('returns plain object as-is', () => {
    const obj = { type: 1, label: 'test' };
    assert.deepEqual(_toComponentJSON(obj), obj);
  });

  it('calls .toJSON() on objects that have it', () => {
    const obj = {
      toJSON() {
        return { type: 1, serialized: true };
      },
    };
    assert.deepEqual(_toComponentJSON(obj), { type: 1, serialized: true });
  });

  it('returns null/undefined as-is', () => {
    assert.equal(_toComponentJSON(null), null);
    assert.equal(_toComponentJSON(undefined), undefined);
  });
});

// ── _textDisplay ─────────────────────────────────────────────────────────────

describe('_textDisplay', () => {
  it('creates text display component with content', () => {
    const result = _textDisplay('Hello');
    assert.deepEqual(result, { type: 10, content: 'Hello' });
  });

  it('converts null to empty string', () => {
    assert.deepEqual(_textDisplay(null), { type: 10, content: '' });
  });

  it('converts undefined to empty string', () => {
    assert.deepEqual(_textDisplay(undefined), { type: 10, content: '' });
  });

  it('converts numbers to string', () => {
    assert.deepEqual(_textDisplay(42), { type: 10, content: '42' });
  });
});

// ── _container ───────────────────────────────────────────────────────────────

describe('_container', () => {
  it('creates container with text blocks', () => {
    const result = _container(['Line 1', 'Line 2']);
    assert.equal(result.type, 17);
    assert.equal(result.components.length, 2);
    assert.deepEqual(result.components[0], { type: 10, content: 'Line 1' });
    assert.deepEqual(result.components[1], { type: 10, content: 'Line 2' });
  });

  it('creates container with rows', () => {
    const row = { type: 1, components: [] };
    const result = _container([], [row]);
    assert.equal(result.components.length, 1);
    assert.deepEqual(result.components[0], row);
  });

  it('skips null/falsy text blocks', () => {
    const result = _container([null, '', 'valid', undefined]);
    // null and undefined skipped; '' is falsy so skipped
    assert.equal(result.components.length, 1);
  });

  it('skips null/falsy rows', () => {
    const result = _container([], [null, { type: 1 }, undefined]);
    assert.equal(result.components.length, 1);
  });

  it('sets accent_color when provided', () => {
    const result = _container([], [], 0xff0000);
    assert.equal(result.accent_color, 0xff0000);
  });

  it('does not set accent_color when null', () => {
    const result = _container([], [], null);
    assert.equal(result.accent_color, undefined);
  });

  it('calls toJSON on row objects that have it', () => {
    const row = {
      toJSON() {
        return { type: 1, serialized: true };
      },
    };
    const result = _container([], [row]);
    assert.deepEqual(result.components[0], { type: 1, serialized: true });
  });

  it('creates empty container with default params', () => {
    const result = _container();
    assert.equal(result.type, 17);
    assert.equal(result.components.length, 0);
  });
});

// ── _componentsKey ───────────────────────────────────────────────────────────

describe('_componentsKey', () => {
  it('returns JSON string of component array', () => {
    const components = [{ type: 1 }, { type: 2 }];
    const result = _componentsKey(components);
    assert.equal(result, JSON.stringify([{ type: 1 }, { type: 2 }]));
  });

  it('calls toJSON on components that have it', () => {
    const components = [
      {
        toJSON() {
          return { type: 1, data: true };
        },
      },
    ];
    const result = _componentsKey(components);
    assert.equal(result, JSON.stringify([{ type: 1, data: true }]));
  });

  it('returns "[]" for empty array', () => {
    assert.equal(_componentsKey([]), '[]');
  });

  it('returns "[]" for undefined (default param)', () => {
    assert.equal(_componentsKey(), '[]');
  });

  it('produces same key for identical content', () => {
    const a = [{ type: 10, content: 'x' }];
    const b = [{ type: 10, content: 'x' }];
    assert.equal(_componentsKey(a), _componentsKey(b));
  });

  it('produces different keys for different content', () => {
    const a = [{ type: 10, content: 'x' }];
    const b = [{ type: 10, content: 'y' }];
    assert.notEqual(_componentsKey(a), _componentsKey(b));
  });
});
