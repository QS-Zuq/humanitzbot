/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-floating-promises */
/**
 * Tests for save file discovery — custom SaveName support.
 * Run: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as _multi_server from '../src/server/multi-server.js';
const { _extractSaveName, SAVE_FILE_PATTERN } = _multi_server as any;

describe('SAVE_FILE_PATTERN', () => {
  it('matches the default save filename', () => {
    assert.ok(SAVE_FILE_PATTERN.test('Save_DedicatedSaveMP.sav'));
  });

  it('matches a custom save filename', () => {
    assert.ok(SAVE_FILE_PATTERN.test('Save_MyWorld.sav'));
  });

  it('matches single-word custom names', () => {
    assert.ok(SAVE_FILE_PATTERN.test('Save_Test.sav'));
  });

  it('matches names with underscores', () => {
    assert.ok(SAVE_FILE_PATTERN.test('Save_My_Custom_World.sav'));
  });

  it('matches names with numbers', () => {
    assert.ok(SAVE_FILE_PATTERN.test('Save_Server01.sav'));
  });

  it('does NOT match Save_ClanData.sav', () => {
    assert.ok(!SAVE_FILE_PATTERN.test('Save_ClanData.sav'));
  });

  it('does NOT match non-save .sav files', () => {
    assert.ok(!SAVE_FILE_PATTERN.test('PlayerData.sav'));
  });

  it('does NOT match files without .sav extension', () => {
    assert.ok(!SAVE_FILE_PATTERN.test('Save_DedicatedSaveMP.txt'));
  });

  it('does NOT match files without Save_ prefix', () => {
    assert.ok(!SAVE_FILE_PATTERN.test('DedicatedSaveMP.sav'));
  });

  it('is case-insensitive', () => {
    assert.ok(SAVE_FILE_PATTERN.test('save_dedicatedsavemp.SAV'));
    assert.ok(SAVE_FILE_PATTERN.test('SAVE_MyWorld.sav'));
  });

  it('does not match Save_ClanData.sav case-insensitively', () => {
    assert.ok(!SAVE_FILE_PATTERN.test('SAVE_CLANDATA.SAV'));
    assert.ok(!SAVE_FILE_PATTERN.test('save_clandata.sav'));
  });
});

describe('_extractSaveName', () => {
  it('extracts quoted SaveName', () => {
    const ini = `[Host Settings]
ServerName="My Server"
SaveName="DedicatedSaveMP"
AdminPass="secret"`;
    assert.equal(_extractSaveName(ini), 'DedicatedSaveMP');
  });

  it('extracts unquoted SaveName', () => {
    const ini = `[Host Settings]
SaveName=MyWorld`;
    assert.equal(_extractSaveName(ini), 'MyWorld');
  });

  it('extracts custom save names', () => {
    const ini = `[Host Settings]
ServerName="Test"
SaveName="My_Custom_World"
MaxPlayers=16`;
    assert.equal(_extractSaveName(ini), 'My_Custom_World');
  });

  it('handles whitespace around the value', () => {
    const ini = `SaveName = "  SpacedName  "`;
    // The regex trims the result
    assert.equal(_extractSaveName(ini), 'SpacedName');
  });

  it('handles Windows-style line endings', () => {
    const ini = `[Host Settings]\r\nSaveName="WinWorld"\r\nMaxPlayers=16\r\n`;
    assert.equal(_extractSaveName(ini), 'WinWorld');
  });

  it('returns null when SaveName is not present', () => {
    const ini = `[Host Settings]
ServerName="My Server"
MaxPlayers=16`;
    assert.equal(_extractSaveName(ini), null);
  });

  it('returns null for empty string', () => {
    assert.equal(_extractSaveName(''), null);
  });

  it('ignores commented-out SaveName', () => {
    const ini = `;SaveName="Old"
SaveName="Active"`;
    assert.equal(_extractSaveName(ini), 'Active');
  });

  it('extracts from real Bisect-style INI', () => {
    const ini = `[Host Settings]
; These are handled on the Startup tab!
; Please refer there for changing these :)
ServerName="[EU1] My Server PVE | Current Mode: Surge | Dynamic Difficulty"
Password=""
SaveName="DedicatedSaveMP"
AdminPass="secret"
MaxPlayers=16
RCONEnabled=true
RConPort=9100
RCONPass=secret123`;
    assert.equal(_extractSaveName(ini), 'DedicatedSaveMP');
  });

  it('extracts a user-changed save name', () => {
    const ini = `[Host Settings]
ServerName="My Private Server"
Password="pass123"
SaveName="cool_world_v2"
AdminPass="admin"`;
    assert.equal(_extractSaveName(ini), 'cool_world_v2');
  });
});
