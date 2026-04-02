/**
 * Config access-control helpers — Discord permission checks.
 */

import type { Guild, GuildMember, PermissionResolvable, ThreadChannel } from 'discord.js';

/**
 * Check whether a section is visible for a given user.
 * Returns true when the toggle is enabled AND either the admin-only flag is off
 * or the user is a Discord admin.
 */
export function canShow(config: Record<string, unknown>, toggleKey: string, isAdmin = false): boolean {
  if (!config[toggleKey]) return false;
  const adminOnlyKey = toggleKey + 'AdminOnly';
  if (config[adminOnlyKey] && !isAdmin) return false;
  return true;
}

/**
 * Check whether a Discord GuildMember has admin-view access.
 * Returns true if the member has ANY of the permissions listed in adminViewPermissions.
 */
export function isAdminView(adminViewPermissions: string[], member: GuildMember | null): boolean {
  if (!member?.permissions) return false;
  return adminViewPermissions.some((p) => member.permissions.has(p as PermissionResolvable));
}

/**
 * Add all configured admin users and role members to a Discord thread.
 * Resolves ADMIN_USER_IDS (explicit) + ADMIN_ROLE_IDS (fetches role members).
 */
export async function addAdminMembers(
  adminUserIds: string[],
  adminRoleIds: string[],
  thread: ThreadChannel,
  guild: Guild,
): Promise<void> {
  // Explicit user IDs
  for (const uid of adminUserIds) {
    thread.members.add(uid).catch(() => {});
  }
  // Role-based — requires GuildMembers privileged intent
  // Fetch all members once (not per-role) so the role.members cache is populated.
  if (adminRoleIds.length > 0 && guild.members.cache.size <= 1) {
    try {
      await guild.members.fetch();
    } catch (e) {
      const err = e as Error & { code?: number };
      if (err.code === 50001 || /disallowed intents|privileged/i.test(err.message)) {
        console.error(
          `[CONFIG] ADMIN_ROLE_IDS requires the "Server Members Intent" to be enabled in the Discord Developer Portal (Bot → Privileged Gateway Intents).`,
        );
      } else {
        console.warn(`[CONFIG] Could not fetch guild members:`, err.message);
      }
      return; // Cannot resolve roles without member cache
    }
  }
  for (const roleId of adminRoleIds) {
    try {
      const role = guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId));
      if (!role) continue;
      for (const [uid] of role.members) {
        thread.members.add(uid).catch(() => {});
      }
    } catch (e) {
      const err = e as Error & { code?: number };
      if (err.code === 50001 || /disallowed intents|privileged/i.test(err.message)) {
        console.error(
          `[CONFIG] ADMIN_ROLE_IDS requires the "Server Members Intent" to be enabled in the Discord Developer Portal (Bot → Privileged Gateway Intents).`,
        );
      } else {
        console.warn(`[CONFIG] Could not resolve role ${roleId}:`, err.message);
      }
    }
  }
}
