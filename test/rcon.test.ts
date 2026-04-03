/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-deprecated */
/**
 * Tests for rcon.js — Source Engine RCON binary packet parsing & building.
 * Run: node --test test/rcon.test.js
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import * as _rcon from '../src/rcon/rcon.js';
const { RconManager } = _rcon as any;

// ── Helpers ─────────────────────────────────────────────

/**
 * Build a valid Source Engine RCON packet.
 * Format: [4-byte size LE][4-byte id LE][4-byte type LE][body string][2 null bytes]
 * Size = 4 (id) + 4 (type) + body.length + 1 + 1
 */
function buildRconPacket(id: number, type: number, body: string): Buffer {
  const bodyBuf = Buffer.from(body, 'utf8');
  const size = 4 + 4 + bodyBuf.length + 1 + 1;
  const packet = Buffer.alloc(4 + size);
  packet.writeInt32LE(size, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  bodyBuf.copy(packet, 12);
  packet.writeInt8(0, 12 + bodyBuf.length);
  packet.writeInt8(0, 13 + bodyBuf.length);
  return packet;
}

/** Create a fresh RconManager for testing (no real connection). */
function createTestRcon() {
  return new RconManager({ host: '127.0.0.1', port: 27015, password: 'test' });
}

/** Collect callback invocations into an array. */
function collector() {
  const calls: unknown[] = [];
  const fn = (val: unknown) => calls.push(val);
  (fn as typeof fn & { calls: unknown[] }).calls = calls;
  return fn as typeof fn & { calls: unknown[] };
}

// ══════════════════════════════════════════════════════════
// _onData — packet parsing
// ══════════════════════════════════════════════════════════

describe('_onData', () => {
  let rcon: ReturnType<typeof createTestRcon>;

  beforeEach(() => {
    rcon = createTestRcon();
  });

  // ── Single packet ───────────────────────────────────

  it('delivers body from a single complete packet when authenticated', () => {
    rcon.authenticated = true;
    const cb = collector();
    rcon._commandCallback = cb;

    rcon._onData(buildRconPacket(101, 0, 'hello world'));

    assert.deepEqual(cb.calls, ['hello world']);
  });

  it('does not deliver body when not authenticated and no authCallback', () => {
    const cb = collector();
    rcon._commandCallback = cb;

    rcon._onData(buildRconPacket(101, 0, 'hello'));

    assert.deepEqual(cb.calls, []);
  });

  it('does not deliver body when no commandCallback is set', () => {
    rcon.authenticated = true;
    // _commandCallback is null by default — should not throw
    rcon._onData(buildRconPacket(101, 0, 'hello'));
    assert.equal(rcon._responseBuffer.length, 0, 'buffer should be fully consumed');
  });

  // ── Empty body filtering ────────────────────────────

  it('filters out packets with empty body when authenticated', () => {
    rcon.authenticated = true;
    const cb = collector();
    rcon._commandCallback = cb;

    rcon._onData(buildRconPacket(101, 0, ''));

    assert.deepEqual(cb.calls, []);
  });

  // ── Fragmented packets ──────────────────────────────

  it('reassembles a packet split across 2 chunks', () => {
    rcon.authenticated = true;
    const cb = collector();
    rcon._commandCallback = cb;

    const packet = buildRconPacket(101, 0, 'fragmented');
    const mid = Math.floor(packet.length / 2);

    rcon._onData(packet.slice(0, mid));
    assert.deepEqual(cb.calls, [], 'should not fire after first fragment');

    rcon._onData(packet.slice(mid));
    assert.deepEqual(cb.calls, ['fragmented']);
  });

  it('reassembles a packet split across 3 chunks', () => {
    rcon.authenticated = true;
    const cb = collector();
    rcon._commandCallback = cb;

    const packet = buildRconPacket(101, 0, 'three-part');
    const a = Math.floor(packet.length / 3);
    const b = Math.floor((packet.length * 2) / 3);

    rcon._onData(packet.slice(0, a));
    rcon._onData(packet.slice(a, b));
    assert.deepEqual(cb.calls, [], 'should not fire after 2 of 3 fragments');

    rcon._onData(packet.slice(b));
    assert.deepEqual(cb.calls, ['three-part']);
  });

  it('waits when buffer has header but incomplete body', () => {
    rcon.authenticated = true;
    const cb = collector();
    rcon._commandCallback = cb;

    // Only send the first 12 bytes (header) of a longer packet
    const packet = buildRconPacket(101, 0, 'long body text');
    rcon._onData(packet.slice(0, 12));

    assert.deepEqual(cb.calls, [], 'should wait for rest of packet');
    assert.equal(rcon._responseBuffer.length, 12, 'buffer should retain header');
  });

  // ── Multiple packets in one chunk ───────────────────

  it('delivers both bodies when 2 packets arrive in one chunk', () => {
    rcon.authenticated = true;
    const cb = collector();
    rcon._commandCallback = cb;

    const p1 = buildRconPacket(101, 0, 'first');
    const p2 = buildRconPacket(102, 0, 'second');
    rcon._onData(Buffer.concat([p1, p2]));

    assert.deepEqual(cb.calls, ['first', 'second']);
  });

  it('delivers 3 packets from a single chunk', () => {
    rcon.authenticated = true;
    const cb = collector();
    rcon._commandCallback = cb;

    const packets = Buffer.concat([
      buildRconPacket(1, 0, 'alpha'),
      buildRconPacket(2, 0, 'beta'),
      buildRconPacket(3, 0, 'gamma'),
    ]);
    rcon._onData(packets);

    assert.deepEqual(cb.calls, ['alpha', 'beta', 'gamma']);
  });

  // ── Raw text fallback (invalid size) ────────────────

  it('treats packet with oversized size field (>65536) as raw text', () => {
    rcon.authenticated = true;
    const cb = collector();
    rcon._commandCallback = cb;

    // Craft a buffer where the first 4 bytes encode a size > 65536
    const buf = Buffer.alloc(20);
    buf.writeInt32LE(70000, 0); // size = 70000
    buf.write('raw text data', 4);

    rcon._onData(buf);

    assert.equal(cb.calls.length, 1);
    assert.ok((cb.calls[0] as string).includes('raw text data'));
  });

  it('treats packet with undersized size field (<10) as raw text', () => {
    rcon.authenticated = true;
    const cb = collector();
    rcon._commandCallback = cb;

    const buf = Buffer.alloc(20);
    buf.writeInt32LE(5, 0); // size = 5, too small
    buf.write('small size', 4);

    rcon._onData(buf);

    assert.equal(cb.calls.length, 1);
    assert.ok((cb.calls[0] as string).includes('small size'));
  });

  it('treats packet with negative size field as raw text', () => {
    rcon.authenticated = true;
    const cb = collector();
    rcon._commandCallback = cb;

    const buf = Buffer.alloc(16);
    buf.writeInt32LE(-1, 0); // negative size
    buf.write('negative', 4);

    rcon._onData(buf);

    assert.equal(cb.calls.length, 1);
    assert.ok((cb.calls[0] as string).includes('negative'));
  });

  it('clears the response buffer after raw text fallback', () => {
    rcon.authenticated = true;
    rcon._commandCallback = () => {};

    const buf = Buffer.alloc(20);
    buf.writeInt32LE(100000, 0);

    rcon._onData(buf);

    assert.equal(rcon._responseBuffer.length, 0, 'buffer should be cleared');
  });

  it('does not call commandCallback for raw text if no callback set', () => {
    rcon.authenticated = true;
    // _commandCallback is null — should not throw
    const buf = Buffer.alloc(20);
    buf.writeInt32LE(99999, 0);
    rcon._onData(buf);
    assert.equal(rcon._responseBuffer.length, 0);
  });

  // ── Auth phase ──────────────────────────────────────

  it('calls _authCallback on type 2 auth response', () => {
    const cb = collector();
    rcon._authCallback = cb;
    rcon.authenticated = false;

    rcon._onData(buildRconPacket(1, 2, ''));

    assert.deepEqual(cb.calls, [1]);
  });

  it('passes id -1 to _authCallback on auth failure', () => {
    const cb = collector();
    rcon._authCallback = cb;
    rcon.authenticated = false;

    rcon._onData(buildRconPacket(-1, 2, ''));

    assert.deepEqual(cb.calls, [-1]);
  });

  it('skips empty type-0 packet with id 1 during auth (pre-auth ACK)', () => {
    const cb = collector();
    rcon._authCallback = cb;
    rcon.authenticated = false;

    // Some servers send an empty type-0 with id 1 before the real auth response
    const ack = buildRconPacket(1, 0, '');
    const authResp = buildRconPacket(1, 2, '');
    rcon._onData(Buffer.concat([ack, authResp]));

    // Should only receive the real auth response, not the ACK
    assert.deepEqual(cb.calls, [1]);
  });

  it('calls _authCallback for type 0 with non-empty body during auth', () => {
    const cb = collector();
    rcon._authCallback = cb;
    rcon.authenticated = false;

    rcon._onData(buildRconPacket(1, 0, 'data'));

    assert.deepEqual(cb.calls, [1]);
  });

  it('does not route auth-phase packets to commandCallback', () => {
    const authCb = collector();
    const cmdCb = collector();
    rcon._authCallback = authCb;
    rcon._commandCallback = cmdCb;
    rcon.authenticated = false;

    rcon._onData(buildRconPacket(1, 2, 'auth-body'));

    assert.deepEqual(authCb.calls, [1], 'authCallback should receive id');
    assert.deepEqual(cmdCb.calls, [], 'commandCallback should NOT receive anything');
  });

  // ── Mixed scenarios ─────────────────────────────────

  it('handles packet with special UTF-8 characters', () => {
    rcon.authenticated = true;
    const cb = collector();
    rcon._commandCallback = cb;

    rcon._onData(buildRconPacket(101, 0, '日本語テスト 🎮'));

    assert.deepEqual(cb.calls, ['日本語テスト 🎮']);
  });

  it('consumes multiple packets leaving no residual buffer', () => {
    rcon.authenticated = true;
    rcon._commandCallback = () => {};

    const data = Buffer.concat([buildRconPacket(1, 0, 'a'), buildRconPacket(2, 0, 'b')]);
    rcon._onData(data);

    assert.equal(rcon._responseBuffer.length, 0, 'buffer should be fully consumed');
  });

  it('retains trailing incomplete packet in buffer', () => {
    rcon.authenticated = true;
    rcon._commandCallback = collector();

    const complete = buildRconPacket(1, 0, 'done');
    const incomplete = buildRconPacket(2, 0, 'pending').slice(0, 8);
    rcon._onData(Buffer.concat([complete, incomplete]));

    assert.equal(rcon._commandCallback.calls.length, 1);
    assert.equal(rcon._commandCallback.calls[0], 'done');
    assert.equal(rcon._responseBuffer.length, 8, 'trailing fragment should remain');
  });
});

// ══════════════════════════════════════════════════════════
// _nextId — request ID generation
// ══════════════════════════════════════════════════════════

describe('_nextId', () => {
  it('increments from initial value (100)', () => {
    const rcon = createTestRcon();
    assert.equal(rcon._nextId(), 101);
    assert.equal(rcon._nextId(), 102);
    assert.equal(rcon._nextId(), 103);
  });

  it('wraps at 0x7fffffff to stay positive', () => {
    const rcon = createTestRcon();
    rcon.requestId = 0x7ffffffe;
    assert.equal(rcon._nextId(), 0x7fffffff);
    assert.equal(rcon._nextId(), 0); // wraps
    assert.equal(rcon._nextId(), 1);
  });
});

// ══════════════════════════════════════════════════════════
// _sendPacket — packet building
// ══════════════════════════════════════════════════════════

describe('_sendPacket', () => {
  let rcon: ReturnType<typeof createTestRcon>;
  let written: Buffer[];

  beforeEach(() => {
    rcon = createTestRcon();
    written = [];
    rcon.socket = { write: (buf: Buffer) => written.push(Buffer.from(buf)) };
  });

  it('builds a packet with correct size, id, type, body, and null terminators', () => {
    rcon._sendPacket(42, 3, 'test');

    assert.equal(written.length, 1);
    const pkt = written[0]!;

    // size = 4(id) + 4(type) + 4(body "test") + 1 + 1 = 14
    assert.equal(pkt.readInt32LE(0), 14, 'size field');
    assert.equal(pkt.readInt32LE(4), 42, 'id field');
    assert.equal(pkt.readInt32LE(8), 3, 'type field');
    assert.equal(pkt.toString('utf8', 12, 16), 'test', 'body');
    assert.equal(pkt[16], 0, 'first null terminator');
    assert.equal(pkt[17], 0, 'second null terminator');
    assert.equal(pkt.length, 18, 'total packet length = 4 + 14');
  });

  it('builds a packet with empty body', () => {
    rcon._sendPacket(1, 2, '');

    const pkt = written[0]!;
    // size = 4 + 4 + 0 + 1 + 1 = 10
    assert.equal(pkt.readInt32LE(0), 10, 'size field for empty body');
    assert.equal(pkt.length, 14, 'total = 4 + 10');
    assert.equal(pkt[12], 0, 'first null terminator');
    assert.equal(pkt[13], 0, 'second null terminator');
  });

  it('handles multi-byte UTF-8 body correctly', () => {
    const body = '中文';
    const bodyLen = Buffer.byteLength(body, 'utf8'); // 6 bytes
    rcon._sendPacket(5, 0, body);

    const pkt = written[0]!;
    const expectedSize = 4 + 4 + bodyLen + 1 + 1;
    assert.equal(pkt.readInt32LE(0), expectedSize, 'size accounts for UTF-8 byte length');
    assert.equal(pkt.toString('utf8', 12, 12 + bodyLen), body);
    assert.equal(pkt[12 + bodyLen], 0, 'null after UTF-8 body');
    assert.equal(pkt[13 + bodyLen], 0, 'second null after UTF-8 body');
  });
});

// ══════════════════════════════════════════════════════════
// buildRconPacket helper — self-test
// ══════════════════════════════════════════════════════════

describe('buildRconPacket helper', () => {
  it('produces a packet that _onData can parse', () => {
    const rcon = createTestRcon();
    rcon.authenticated = true;
    const cb = collector();
    rcon._commandCallback = cb;

    const packet = buildRconPacket(999, 0, 'round-trip');
    rcon._onData(packet);

    assert.deepEqual(cb.calls, ['round-trip']);
  });

  it('matches the format produced by _sendPacket', () => {
    const rcon = createTestRcon();
    const writtenBufs: Buffer[] = [];
    rcon.socket = { write: (buf: Buffer) => writtenBufs.push(Buffer.from(buf)) };

    rcon._sendPacket(42, 3, 'match');
    const fromSend = writtenBufs[0]!;
    const fromHelper = buildRconPacket(42, 3, 'match');

    assert.ok(fromSend.equals(fromHelper), '_sendPacket and buildRconPacket should produce identical buffers');
  });
});
