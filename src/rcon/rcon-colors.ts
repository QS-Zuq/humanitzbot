/**
 * Shared RCON color tag helpers for in-game admin messages.
 *
 * HumanitZ supports these tags in chat/admin commands:
 *   <PN> dark red   — player names, alerts
 *   <PR> green      — positive, bot identity
 *   <SP> ember      — headings, emphasis
 *   <FO> gray       — secondary info
 *   <CL> blue       — Discord identity
 */
export const COLOR: Record<string, string> = {
  red: 'PN',
  green: 'PR',
  ember: 'SP',
  gray: 'FO',
  blue: 'CL',
};

/**
 * Wrap text in an RCON color tag (simple open tag, no close).
 * Works in WelcomeMessage.txt and other file contexts.
 * @param tag  A key from COLOR (e.g. 'ember') or a raw tag code (e.g. 'SP')
 * @param text The text to colorise
 * @returns e.g. `<SP>Hello`
 */
export function color(tag: string, text: string): string {
  return `<${COLOR[tag] ?? tag}>${text}`;
}

/**
 * Color tag for RCON admin commands — close previous color first.
 * Admin messages start in yellow; each new color needs </> before opening.
 * Never end a message with </> (renders visibly).
 * @param tag  A key from COLOR or raw tag code
 * @param text
 * @returns e.g. `</><SP>Hello`
 */
export function rconColor(tag: string, text: string): string {
  return `</><${COLOR[tag] ?? tag}>${text}`;
}

/**
 * Open a color tag without closing the previous one.
 * Use for the first tag in an admin message (no prior color to close)
 * or in file contexts.
 * @param tag  A key from COLOR or raw tag code
 * @param text
 * @returns e.g. `<FO>Hello`
 */
export function colorOpen(tag: string, text: string): string {
  return `<${COLOR[tag] ?? tag}>${text}`;
}

/**
 * Switch to white in an admin command (close current color).
 * @param text
 * @returns
 */
export function white(text: string): string {
  return `</>${text}`;
}

/**
 * Strip all RCON color tags from a string.
 * Use this when you need plain text (e.g. Discord embeds, logs).
 * Note: the RCON `admin` command DOES render color tags in-game.
 * @param text
 * @returns Plain text with all color tags removed
 */
export function stripColorTags(text: string): string {
  return text.replace(/<(?:PN|PR|SP|FO|CL|\/)>/g, '');
}
