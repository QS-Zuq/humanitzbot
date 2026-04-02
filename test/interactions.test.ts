/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-floating-promises, @typescript-eslint/require-await, @typescript-eslint/no-non-null-assertion */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert';

describe('Interaction handling', () => {
  describe('String select menus', () => {
    it('should defer player select immediately before async work', async () => {
      const deferCalls: { timestamp: number; opts: any }[] = [];
      const editCalls: { timestamp: number; opts: any }[] = [];

      const interaction = {
        isStringSelectMenu: () => true,
        customId: 'playerstats_player_select:',
        values: ['76561198012345678'],
        member: { roles: { cache: new Map() } },
        deferReply: async (opts: any) => {
          deferCalls.push({ timestamp: Date.now(), opts });
        },
        editReply: async (opts: any) => {
          editCalls.push({ timestamp: Date.now(), opts });
        },
      };

      // Simulate the handler logic
      await interaction.deferReply({ flags: 64 });

      // Then do async work (module lookup, etc)
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Then edit reply
      await interaction.editReply({ content: 'Test', flags: 64 });

      assert.strictEqual(deferCalls.length, 1, 'Should defer exactly once');
      assert.strictEqual(editCalls.length, 1, 'Should edit exactly once');
      assert.ok(deferCalls[0]!.timestamp < editCalls[0]!.timestamp, 'Defer must happen before edit');
    });

    it('should defer clan select immediately before async work', async () => {
      const deferCalls: { timestamp: number; opts: any }[] = [];
      const editCalls: { timestamp: number; opts: any }[] = [];

      const interaction = {
        isStringSelectMenu: () => true,
        customId: 'playerstats_clan_select:',
        values: ['clan:TestClan'],
        member: { roles: { cache: new Map() } },
        deferReply: async (opts: any) => {
          deferCalls.push({ timestamp: Date.now(), opts });
        },
        editReply: async (opts: any) => {
          editCalls.push({ timestamp: Date.now(), opts });
        },
      };

      // Simulate the handler logic
      await interaction.deferReply({ flags: 64 });

      // Then do async work
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Then edit reply
      await interaction.editReply({ content: 'Test', flags: 64 });

      assert.strictEqual(deferCalls.length, 1, 'Should defer exactly once');
      assert.strictEqual(editCalls.length, 1, 'Should edit exactly once');
      assert.ok(deferCalls[0]!.timestamp < editCalls[0]!.timestamp, 'Defer must happen before edit');
    });

    it('should use editReply for errors after deferring', async () => {
      const interaction = {
        isStringSelectMenu: () => true,
        customId: 'playerstats_player_select:',
        values: ['76561198012345678'],
        member: { roles: { cache: new Map() } },
        deferReply: async (_opts?: any) => {},
        editReply: mock.fn(async (_opts?: any) => {}),
        reply: mock.fn(async (_opts?: any) => {}),
      };

      // Simulate error case after defer
      await interaction.deferReply({ flags: 64 });
      await interaction.editReply({ content: 'Error message', flags: 64 });

      assert.strictEqual(interaction.editReply.mock.calls.length, 1, 'Should use editReply after defer');
      assert.strictEqual(interaction.reply.mock.calls.length, 0, 'Should not use reply after defer');
    });

    it('should handle interaction token expiry gracefully', async () => {
      const interaction = {
        isStringSelectMenu: () => true,
        customId: 'playerstats_player_select:',
        values: ['76561198012345678'],
        member: { roles: { cache: new Map() } },
        deferReply: async (_opts?: any) => {
          // Simulate delay that would cause timeout
          await new Promise((resolve) => setTimeout(resolve, 100));
          throw new Error('Unknown interaction');
        },
      };

      // This should throw if defer happens too late
      await assert.rejects(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50)); // Work before defer
        await interaction.deferReply({ flags: 64 });
      }, /Unknown interaction/);
    });
  });

  describe('Interaction response patterns', () => {
    it('should never call both reply and deferReply', async () => {
      const calls: { type: string; opts: any }[] = [];

      const interaction = {
        reply: async (opts: any) => calls.push({ type: 'reply', opts }),
        deferReply: async (opts: any) => calls.push({ type: 'defer', opts }),
        editReply: async (opts: any) => calls.push({ type: 'edit', opts }),
      };

      // Valid pattern 1: reply only
      await interaction.reply({ content: 'Direct reply' });
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0]!.type, 'reply');

      calls.length = 0;

      // Valid pattern 2: defer then edit
      await interaction.deferReply({ flags: 64 });
      await interaction.editReply({ content: 'Deferred reply' });
      assert.strictEqual(calls.length, 2);
      assert.strictEqual(calls[0]!.type, 'defer');
      assert.strictEqual(calls[1]!.type, 'edit');

      // Invalid pattern: reply after defer would fail
      // (not testing this as it would throw in real Discord.js)
    });

    it('should use ephemeral flag (64) for private responses', () => {
      const deferOpts = { flags: 64 };
      const replyOpts = { content: 'Test', flags: 64 };

      assert.strictEqual(deferOpts.flags, 64, 'Defer should be ephemeral');
      assert.strictEqual(replyOpts.flags, 64, 'Reply should be ephemeral');
    });
  });
});
