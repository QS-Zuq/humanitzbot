/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call,
   @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return,
   @typescript-eslint/restrict-plus-operands, @typescript-eslint/no-non-null-assertion */

/**
 * Shared utilities for the server scheduler's daily rotation feature.
 *
 * When RESTART_ROTATE_DAILY is enabled, the profile↔time-slot mapping
 * shifts each day so players experience a different difficulty at each
 * time of day.  With 3 profiles and 3 time slots:
 *
 *   Day 0: slot0→Calm   slot1→Surge  slot2→Horde
 *   Day 1: slot0→Surge  slot1→Horde  slot2→Calm
 *   Day 2: slot0→Horde  slot1→Calm   slot2→Surge
 *   Day 3: (repeats Day 0 pattern)
 */

/**
 * Get the day-of-year in the given timezone (0–365).
 * Uses Intl.DateTimeFormat to be timezone-aware.
 * @param {string} timezone  IANA timezone (e.g. 'Europe/Tallinn')
 * @param {Date}   [now]     Optional date (defaults to new Date())
 * @returns {number} 0-based day of year
 */
function getDayOfYear(timezone: any, now?: any) {
  const d = now || new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const year = parseInt(parts.find((p: any) => p.type === 'year')!.value, 10);
  const month = parseInt(parts.find((p: any) => p.type === 'month')!.value, 10);
  const day = parseInt(parts.find((p: any) => p.type === 'day')!.value, 10);
  const jan1 = new Date(year, 0, 1);
  const target = new Date(year, month - 1, day);
  return Math.floor((target.getTime() - jan1.getTime()) / 86400000);
}

/**
 * Get the daily rotation offset for profile assignment.
 * @param {string} timezone      IANA timezone
 * @param {number} profileCount  Number of profiles (e.g. 3)
 * @param {boolean} rotateDaily  Whether rotation is enabled
 * @param {Date}   [now]         Optional date
 * @returns {number} Offset to add to time-slot index (0 when rotation is off)
 */
function getDayOffset(timezone: any, profileCount: any, rotateDaily: any, now?: any) {
  if (!rotateDaily || profileCount <= 1) return 0;
  return getDayOfYear(timezone, now) % profileCount;
}

/**
 * Get the rotated profile index for a given time slot.
 * @param {number} timeSlotIndex  Which restart window (0-based)
 * @param {number} profileCount   Total profiles
 * @param {number} dayOffset      From getDayOffset()
 * @returns {number} Profile index to use
 */
function getRotatedProfileIndex(timeSlotIndex: any, profileCount: any, dayOffset: any) {
  return (timeSlotIndex + dayOffset) % profileCount;
}

/**
 * Build today's full schedule: for each time slot, which profile is assigned.
 * Returns an array of { timeSlotIndex, profileIndex, profileName }.
 * @param {string[]} times     Array of time strings (e.g. ['01:00','09:00','17:00'])
 * @param {string[]} profiles  Array of profile names (e.g. ['calm','surge','horde'])
 * @param {number}   dayOffset From getDayOffset()
 * @returns {Array<{slotIndex: number, profileIndex: number, profileName: string, startTime: string, endTime: string}>}
 */
function getTodaySchedule(times: any, profiles: any, dayOffset: any) {
  return times.map((startTime: any, slotIndex: any) => {
    const profileIndex = getRotatedProfileIndex(slotIndex, profiles.length, dayOffset);
    const endTime = times[(slotIndex + 1) % times.length] || times[0];
    return {
      slotIndex,
      profileIndex,
      profileName: profiles[profileIndex],
      startTime,
      endTime,
    };
  });
}

/**
 * Find which time slot is currently active and return its rotated profile index.
 * @param {number[]} timeMins    Array of restart times in minutes-since-midnight
 * @param {number}   nowMin      Current time in minutes-since-midnight
 * @param {number}   profileCount Total profiles
 * @param {number}   dayOffset   From getDayOffset()
 * @returns {number} Rotated profile index
 */
function getActiveProfileIndex(timeMins: any, nowMin: any, profileCount: any, dayOffset: any) {
  let slotIndex = 0;
  for (let i = timeMins.length - 1; i >= 0; i--) {
    if (nowMin >= timeMins[i]) {
      slotIndex = i;
      break;
    }
  }
  return getRotatedProfileIndex(slotIndex, profileCount, dayOffset);
}

export { getDayOfYear, getDayOffset, getRotatedProfileIndex, getTodaySchedule, getActiveProfileIndex };
