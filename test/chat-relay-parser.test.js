const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  CHAT_RE,
  JOIN_RE,
  LEFT_RE,
  DIED_RE,
  BOT_ADMIN_RE,
  PLAIN_CHAT_RE,
  TIMESTAMP_RE,
  RICH_TEXT_RE,
  stripAdminPrefix,
  stripTimestamp,
  stripRichText,
  _parseLine,
  _sanitize,
  _sanitizeRcon,
} = require('../src/modules/chat-relay-parser');

// ── Helpers ──────────────────────────────────────────────────

/** Minimal `this` context for prototype mixin methods that reference this._sanitize */
function makeContext() {
  return { _sanitize, _parseLine };
}

// ── Regex patterns ───────────────────────────────────────────

describe('chat-relay-parser', () => {
  describe('TIMESTAMP_RE', () => {
    it('matches standard timestamp prefix', () => {
      assert.ok(TIMESTAMP_RE.test('[1/3/2,026 - 15:5] '));
    });

    it('matches timestamp with spaces around colon', () => {
      assert.ok(TIMESTAMP_RE.test('[28/2/2,026 - 21: 45] '));
    });

    it('does not match plain text', () => {
      assert.ok(!TIMESTAMP_RE.test('Hello world'));
    });

    it('does not match partial bracket', () => {
      assert.ok(!TIMESTAMP_RE.test('[Admin]Player'));
    });
  });

  describe('RICH_TEXT_RE', () => {
    it('matches opening SP tag', () => {
      assert.ok(RICH_TEXT_RE.test('<SP>'));
    });

    it('matches closing FO tag', () => {
      // Reset lastIndex since RICH_TEXT_RE has /g flag
      RICH_TEXT_RE.lastIndex = 0;
      assert.ok(RICH_TEXT_RE.test('</FO>'));
    });

    it('matches PR and CL tags', () => {
      RICH_TEXT_RE.lastIndex = 0;
      assert.ok(RICH_TEXT_RE.test('<PR>'));
      RICH_TEXT_RE.lastIndex = 0;
      assert.ok(RICH_TEXT_RE.test('<CL>'));
    });

    it('does not match PN tag (handled separately)', () => {
      RICH_TEXT_RE.lastIndex = 0;
      assert.ok(!RICH_TEXT_RE.test('<PN>'));
    });
  });

  describe('CHAT_RE', () => {
    it('matches player chat with PN tags', () => {
      const m = CHAT_RE.exec('<PN>fabien:</>Hello world');
      assert.ok(m);
      assert.equal(m[1], 'fabien');
      assert.equal(m[2], 'Hello world');
    });

    it('captures message with special characters', () => {
      const m = CHAT_RE.exec('<PN>Player One:</>GG! @everyone **bold**');
      assert.ok(m);
      assert.equal(m[1], 'Player One');
      assert.equal(m[2], 'GG! @everyone **bold**');
    });

    it('does not match lines without PN tags', () => {
      assert.equal(CHAT_RE.exec('fabien: Hello'), null);
    });
  });

  describe('JOIN_RE', () => {
    it('matches player joined line', () => {
      const m = JOIN_RE.exec('Player Joined (<PN>fabien</>)');
      assert.ok(m);
      assert.equal(m[1], 'fabien');
    });

    it('does not match left line', () => {
      assert.equal(JOIN_RE.exec('Player Left (<PN>fabien</>)'), null);
    });
  });

  describe('LEFT_RE', () => {
    it('matches player left line', () => {
      const m = LEFT_RE.exec('Player Left (<PN>fabien</>)');
      assert.ok(m);
      assert.equal(m[1], 'fabien');
    });

    it('does not match joined line', () => {
      assert.equal(LEFT_RE.exec('Player Joined (<PN>fabien</>)'), null);
    });
  });

  describe('DIED_RE', () => {
    it('matches player died line', () => {
      const m = DIED_RE.exec('Player Died (<PN>fabien</>)');
      assert.ok(m);
      assert.equal(m[1], 'fabien');
    });

    it('does not match joined line', () => {
      assert.equal(DIED_RE.exec('Player Joined (<PN>fabien</>)'), null);
    });
  });

  describe('BOT_ADMIN_RE', () => {
    it('matches admin broadcast prefix', () => {
      assert.ok(BOT_ADMIN_RE.test('<SP>Admin: </>Welcome!'));
    });

    it('matches admin broadcast with extra spaces', () => {
      assert.ok(BOT_ADMIN_RE.test('<SP>Admin:  </>Message'));
    });

    it('does not match player chat', () => {
      assert.ok(!BOT_ADMIN_RE.test('<PN>Admin:</>Hello'));
    });
  });

  describe('PLAIN_CHAT_RE', () => {
    it('matches plain chat without PN tags', () => {
      const m = PLAIN_CHAT_RE.exec('PlayerName: Hello world');
      assert.ok(m);
      assert.equal(m[1], 'PlayerName');
      assert.equal(m[2], 'Hello world');
    });

    it('does not match timestamp-prefixed lines', () => {
      assert.equal(PLAIN_CHAT_RE.exec('[28/2/2,026 - 23:18] some text'), null);
    });

    it('does not match lines starting with angle brackets', () => {
      assert.equal(PLAIN_CHAT_RE.exec('<PN>Player:</>msg'), null);
    });
  });

  // ── stripTimestamp ─────────────────────────────────────────

  describe('stripTimestamp', () => {
    it('removes timestamp prefix from line', () => {
      assert.equal(stripTimestamp('[1/3/2,026 - 15:5] Player Joined (<PN>fabien</>)'), 'Player Joined (<PN>fabien</>)');
    });

    it('returns line unchanged when no timestamp', () => {
      assert.equal(stripTimestamp('Player Joined (<PN>fabien</>)'), 'Player Joined (<PN>fabien</>)');
    });

    it('handles timestamp with spaces around colon', () => {
      assert.equal(stripTimestamp('[28/2/2,026 - 21: 45] Hello'), 'Hello');
    });
  });

  // ── stripRichText ──────────────────────────────────────────

  describe('stripRichText', () => {
    it('removes SP/FO/PR/CL tags and closing tags', () => {
      assert.equal(stripRichText('<SP>Admin: </>Hello <CL>world</>'), 'Admin: Hello world');
    });

    it('returns plain text unchanged', () => {
      assert.equal(stripRichText('Hello world'), 'Hello world');
    });

    it('trims whitespace after stripping', () => {
      assert.equal(stripRichText('  <SP>text</>  '), 'text');
    });

    it('handles empty string', () => {
      assert.equal(stripRichText(''), '');
    });
  });

  // ── stripAdminPrefix ──────────────────────────────────────

  describe('stripAdminPrefix', () => {
    it('removes [Admin] prefix', () => {
      assert.equal(stripAdminPrefix('[Admin]<PN>fabien:</>Hello'), '<PN>fabien:</>Hello');
    });

    it('removes [Admin] prefix with trailing space', () => {
      assert.equal(stripAdminPrefix('[Admin] <PN>fabien:</>Hello'), '<PN>fabien:</>Hello');
    });

    it('returns line unchanged when no [Admin] prefix', () => {
      assert.equal(stripAdminPrefix('<PN>fabien:</>Hello'), '<PN>fabien:</>Hello');
    });
  });

  // ── _sanitize ─────────────────────────────────────────────

  describe('_sanitize', () => {
    it('neutralizes @everyone', () => {
      assert.equal(_sanitize('@everyone'), '@\u200beveryone');
    });

    it('neutralizes @here', () => {
      assert.equal(_sanitize('@here'), '@\u200bhere');
    });

    it('replaces user mentions with @user', () => {
      assert.equal(_sanitize('<@123456>'), '@user');
      assert.equal(_sanitize('<@!789>'), '@user');
    });

    it('replaces role mentions with @role', () => {
      assert.equal(_sanitize('<@&999>'), '@role');
    });

    it('breaks triple backticks with zero-width spaces', () => {
      const result = _sanitize('```code```');
      assert.ok(result.includes('\u200b'));
      assert.ok(!result.includes('```'));
    });

    it('escapes Discord markdown characters', () => {
      const result = _sanitize('**bold** _italic_ ~strike~ `code` ||spoiler||');
      assert.ok(!result.includes('**'));
      assert.ok(result.includes('\\*'));
      assert.ok(result.includes('\\_'));
      assert.ok(result.includes('\\~'));
    });

    it('handles empty string', () => {
      assert.equal(_sanitize(''), '');
    });

    it('handles long string without error', () => {
      const long = 'A'.repeat(5000);
      const result = _sanitize(long);
      assert.equal(result.length, 5000);
    });
  });

  // ── _sanitizeRcon ──────────────────────────────────────────

  describe('_sanitizeRcon', () => {
    it('strips null bytes', () => {
      assert.equal(_sanitizeRcon('hello\x00world'), 'helloworld');
    });

    it('strips control characters', () => {
      assert.equal(_sanitizeRcon('hello\x01\x02\x1fworld'), 'helloworld');
    });

    it('replaces newlines with spaces', () => {
      assert.equal(_sanitizeRcon('line1\nline2\r\nline3'), 'line1 line2 line3');
    });

    it('preserves tabs and normal whitespace', () => {
      // \x09 (tab) is NOT stripped — regex skips 0x09/0x0a/0x0d
      assert.equal(_sanitizeRcon('hello\tworld'), 'hello\tworld');
    });

    it('handles empty string', () => {
      assert.equal(_sanitizeRcon(''), '');
    });

    it('handles long string without error', () => {
      const long = 'B'.repeat(5000);
      assert.equal(_sanitizeRcon(long), long);
    });
  });

  // ── _parseLine ─────────────────────────────────────────────

  describe('_parseLine', () => {
    it('parses player chat line', () => {
      const ctx = makeContext();
      const result = _parseLine.call(ctx, '<PN>fabien:</>Hello world');
      assert.ok(result);
      assert.equal(result.entry.type, 'player');
      assert.equal(result.entry.playerName, 'fabien');
      assert.equal(result.entry.message, 'Hello world');
      assert.equal(result.entry.direction, 'game');
      assert.ok(result.formatted.includes('fabien'));
    });

    it('parses player chat with timestamp prefix', () => {
      const ctx = makeContext();
      const result = _parseLine.call(ctx, '[1/3/2,026 - 15:5] <PN>fabien:</>Hello');
      assert.ok(result);
      assert.equal(result.entry.type, 'player');
      assert.equal(result.entry.playerName, 'fabien');
    });

    it('parses admin player chat with [Admin] prefix', () => {
      const ctx = makeContext();
      const result = _parseLine.call(ctx, '[Admin]<PN>fabien:</>Hello');
      assert.ok(result);
      assert.equal(result.entry.type, 'player');
      assert.equal(result.entry.isAdmin, true);
      assert.ok(result.formatted.includes('🛡️'));
    });

    it('parses player joined line', () => {
      const ctx = makeContext();
      const result = _parseLine.call(ctx, 'Player Joined (<PN>fabien</>)');
      assert.ok(result);
      assert.equal(result.entry.type, 'join');
      assert.equal(result.entry.playerName, 'fabien');
      assert.ok(result.formatted.includes('joined'));
    });

    it('parses player left line', () => {
      const ctx = makeContext();
      const result = _parseLine.call(ctx, 'Player Left (<PN>fabien</>)');
      assert.ok(result);
      assert.equal(result.entry.type, 'leave');
      assert.equal(result.entry.playerName, 'fabien');
      assert.ok(result.formatted.includes('left'));
    });

    it('parses player died line', () => {
      const ctx = makeContext();
      const result = _parseLine.call(ctx, 'Player Died (<PN>fabien</>)');
      assert.ok(result);
      assert.equal(result.entry.type, 'death');
      assert.equal(result.entry.playerName, 'fabien');
      assert.ok(result.formatted.includes('died'));
    });

    it('parses admin broadcast line', () => {
      const ctx = makeContext();
      const result = _parseLine.call(ctx, '<SP>Admin: </>Server restarting in 5 minutes');
      assert.ok(result);
      assert.equal(result.entry.type, 'admin_broadcast');
      assert.equal(result.entry.isAdmin, true);
      assert.ok(result.formatted.includes('📢'));
    });

    it('skips [Discord] admin broadcast (already logged at source)', () => {
      const ctx = makeContext();
      const result = _parseLine.call(ctx, '<SP>Admin: </>[Discord] user: hello');
      assert.equal(result, null);
    });

    it('skips [Panel] admin broadcast (already logged at source)', () => {
      const ctx = makeContext();
      const result = _parseLine.call(ctx, '<SP>Admin: </>[Panel] admin: hello');
      assert.equal(result, null);
    });

    it('skips empty admin broadcast', () => {
      const ctx = makeContext();
      const result = _parseLine.call(ctx, '<SP>Admin: </>');
      assert.equal(result, null);
    });

    it('returns null for unrecognized line format', () => {
      const ctx = makeContext();
      assert.equal(_parseLine.call(ctx, 'random garbage line'), null);
    });

    it('falls back to PLAIN_CHAT_RE for admin players without PN tags', () => {
      const ctx = makeContext();
      const result = _parseLine.call(ctx, '[Admin]fabien: Hello world');
      assert.ok(result);
      assert.equal(result.entry.type, 'player');
      assert.equal(result.entry.playerName, 'fabien');
      assert.equal(result.entry.isAdmin, true);
    });

    it('sanitizes chat message text for Discord display', () => {
      const ctx = makeContext();
      const result = _parseLine.call(ctx, '<PN>fabien:</>@everyone **bold**');
      assert.ok(result);
      // Formatted output should have sanitized @everyone
      assert.ok(result.formatted.includes('@\u200beveryone'));
      // Entry message should have raw text (only rich text stripped)
      assert.equal(result.entry.message, '@everyone **bold**');
    });
  });
});
