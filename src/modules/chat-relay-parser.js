/**
 * Chat relay data-layer: line parsing, diffing, and sanitisation.
 *
 * These are pure functions with no Discord or RCON dependency.
 * They can be unit-tested in isolation and reused by any consumer
 * that needs to interpret fetchchat output (web panel, recap service, etc.).
 *
 * Mixed into ChatRelay.prototype by chat-relay.js.
 */

// ── Chat line regexes ────────────────────────────────────────
// Player chat:   <PN>PlayerName:</>Message text
// Admin chat:    [Admin]<PN>PlayerName:</>Message text (admin players get this prefix)
const CHAT_RE = /^<PN>(.+?):<\/>(.+)$/;
// Player joined: Player Joined (<PN>PlayerName</>)
const JOIN_RE = /^Player Joined \(<PN>(.+?)<\/>\)$/;
// Player left:   Player Left (<PN>PlayerName</>)
const LEFT_RE = /^Player Left \(<PN>(.+?)<\/>\)$/;
// Player died:   Player Died (<PN>PlayerName</>)
const DIED_RE = /^Player Died \(<PN>(.+?)<\/>\)$/;
// Plain chat fallback — admin player lines may lack <PN> tags
// Must NOT match timestamp-prefixed lines like "[28/2/2,026 - 23:18] ..."
const PLAIN_CHAT_RE = /^([^\[:<>\n][^:<>\n]{0,31}):\s*(.+)$/;

/** Strip [Admin] prefix from admin player lines so the other regexes can match. */
function stripAdminPrefix(line) {
  return line.startsWith('[Admin]') ? line.replace(/^\[Admin\]\s*/, '') : line;
}

// ── Methods mixed into ChatRelay.prototype ───────────────────

/**
 * Parse a raw fetchchat line into a structured object for DB insertion
 * and a formatted Discord message string.
 * Returns { formatted, entry } or null if the line should be skipped.
 */
function _parseLine(line) {
  // Strip [Admin] prefix so admin players' messages match the regular regexes
  const cleaned = stripAdminPrefix(line);
  const isAdmin = cleaned !== line;

  // Player chat (game uses <PN> tags in fetchChat output)
  let m = CHAT_RE.exec(cleaned);
  if (!m) m = PLAIN_CHAT_RE.exec(cleaned); // admin players may lack <PN> tags
  if (m) {
    const name = m[1].trim();
    const rawText = m[2].trim();
    const text = this._sanitize(rawText);
    const badge = isAdmin ? ' 🛡️' : '';
    return {
      formatted: `💬 **${name}${badge}:** ${text}`,
      entry: { type: 'player', playerName: name, message: rawText, direction: 'game', isAdmin },
    };
  }

  // Player joined
  m = JOIN_RE.exec(cleaned);
  if (m) return {
    formatted: `📥 **${m[1]}** joined the server`,
    entry: { type: 'join', playerName: m[1], message: 'joined', direction: 'game', isAdmin: false },
  };

  // Player left
  m = LEFT_RE.exec(cleaned);
  if (m) return {
    formatted: `📤 **${m[1]}** left the server`,
    entry: { type: 'leave', playerName: m[1], message: 'left', direction: 'game', isAdmin: false },
  };

  // Player died
  m = DIED_RE.exec(cleaned);
  if (m) return {
    formatted: `💀 **${m[1]}** died`,
    entry: { type: 'death', playerName: m[1], message: 'died', direction: 'game', isAdmin: false },
  };

  // Unknown format — skip silently
  return null;
}

/** Legacy wrapper — returns only the formatted string. */
function _formatLine(line) {
  const parsed = this._parseLine(line);
  return parsed ? parsed.formatted : null;
}

/**
 * Compute new lines since last snapshot.
 * Returns an array of lines that were not present in the previous poll.
 */
function _diff(currentLines) {
  if (this._lastLines.length === 0) {
    // First poll — don't replay the whole buffer
    return [];
  }

  // Find where the old snapshot ends in the new one
  // Walk backward through old lines to find the last matching line
  const lastOld = this._lastLines[this._lastLines.length - 1];
  let splitIdx = -1;

  // Search from end of current lines backwards for the last old line
  for (let i = currentLines.length - 1; i >= 0; i--) {
    if (currentLines[i] === lastOld) {
      // Verify the preceding lines match too (avoid false positives)
      let match = true;
      for (let j = 1; j <= Math.min(2, this._lastLines.length - 1); j++) {
        if (i - j < 0 || currentLines[i - j] !== this._lastLines[this._lastLines.length - 1 - j]) {
          match = false;
          break;
        }
      }
      if (match) {
        splitIdx = i;
        break;
      }
    }
  }

  if (splitIdx === -1) {
    // No overlap found — entire response is new (or buffer rotated)
    return currentLines;
  }

  return currentLines.slice(splitIdx + 1);
}

/** Sanitize text from in-game chat for safe Discord display. */
function _sanitize(text) {
  return text
    .replace(/@everyone/g, '@\u200beveryone')
    .replace(/@here/g, '@\u200bhere')
    .replace(/<@!?(\d+)>/g, '@user')
    .replace(/<@&(\d+)>/g, '@role')
    // Escape Discord markdown characters to prevent formatting injection
    .replace(/```/g, '\u200b`\u200b`\u200b`')
    .replace(/([*_~`|\\])/g, '\\$1');
}

/** Sanitize text for use in RCON commands — strip control characters and null bytes. */
function _sanitizeRcon(text) {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/[\r\n]+/g, ' ');
}

// ── Exports ──────────────────────────────────────────────────

module.exports = {
  // Regexes & helpers (available to external consumers like tests/web panel)
  CHAT_RE,
  JOIN_RE,
  LEFT_RE,
  DIED_RE,
  PLAIN_CHAT_RE,
  stripAdminPrefix,

  // Prototype methods (mixed into ChatRelay)
  _parseLine,
  _formatLine,
  _diff,
  _sanitize,
  _sanitizeRcon,
};
