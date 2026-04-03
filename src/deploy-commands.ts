import 'dotenv/config';

import { REST, Routes } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { getDirname } from './utils/paths.js';

const __dirname = getDirname(import.meta.url);

// Only need Discord credentials for deploying commands — skip full config validation
const token = process.env['DISCORD_TOKEN'];
const clientId = process.env['DISCORD_CLIENT_ID'];
const guildId = process.env['DISCORD_GUILD_ID'];

if (!token || !clientId || !guildId) {
  console.error('[DEPLOY] Missing DISCORD_TOKEN, DISCORD_CLIENT_ID, or DISCORD_GUILD_ID in .env');
  process.exit(1);
}

const commands: unknown[] = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs
  .readdirSync(commandsPath)
  .filter((f) => (f.endsWith('.js') || f.endsWith('.ts')) && !f.endsWith('.d.ts'));

for (const file of commandFiles) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const command = require(path.join(commandsPath, file)) as { data?: { name: string; toJSON(): unknown } };
  if (command.data) {
    commands.push(command.data.toJSON());
    console.log(`[DEPLOY] Loaded command: /${command.data.name}`);
  }
}

const rest = new REST({ version: '10' }).setToken(token);

void (async () => {
  try {
    console.log(`[DEPLOY] Registering ${String(commands.length)} slash commands...`);

    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });

    console.log('[DEPLOY] Successfully registered all commands!');
  } catch (err) {
    console.error('[DEPLOY] Failed:', err);
  }
})();
