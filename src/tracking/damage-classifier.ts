/**
 * Damage source classification — single source of truth.
 *
 * Two consumers:
 *   • LogWatcher  — classifyDamageSource() for death cause attribution + DB logging
 *   • PlayerStats — classifyDamageLabel() for damage-taken stat bucketing
 *
 * Zero runtime dependencies. Pure functions only.
 */

// ── Ordered rules: specific variants first, generic catch-alls last ──

const ZOMBIE_RULES: [RegExp, string][] = [
  [/Dogzombie/i, 'Dog Zombie'],
  [/ZombieBear/i, 'Zombie Bear'],
  [/Mutant/i, 'Mutant'],
  [/Runner.*Brute|Brute.*Runner|RunnerBrute/i, 'Runner Brute'],
  [/Runner/i, 'Runner'],
  [/BruteCop/i, 'Riot Brute'],
  [/Brute/i, 'Brute'],
  [/Pudge|BellyToxic/i, 'Bloater'],
  [/MilitaryArmoured/i, 'Military Armoured'],
  [/PoliceArmor/i, 'Police Armoured'],
  [/Police|Cop/i, 'Police Zombie'],
  [/Medic/i, 'Medic Zombie'],
  [/Hazmat/i, 'Hazmat Zombie'],
  [/Camo/i, 'Camo Zombie'],
  [/Urban/i, 'Urban Zombie'],
  [/Girl|Female/i, 'Female Zombie'],
  [/Zombie/i, 'Zombie'], // generic catch-all
];

const BANDIT_RULES: [RegExp, string][] = [[/KaiHuman/i, 'Bandit']];

const ANIMAL_RULES: [RegExp, string][] = [
  [/Wolf/i, 'Wolf'],
  [/Bear(?!.*Zombie)/i, 'Bear'],
  [/Deer|Stag|Doe/i, 'Deer'],
  [/Snake/i, 'Snake'],
  [/Spider/i, 'Spider'],
  [/Pig/i, 'Pig'],
  [/Rabbit/i, 'Rabbit'],
  [/Chicken/i, 'Chicken'],
];

export interface DamageClassification {
  name: string;
  type: string;
}

/**
 * Classify a raw BP_ damage source into a human-readable name + category.
 * Used for death attribution, embed text, and DB records.
 *
 * @param source - Raw damage source (e.g. 'BP_PawnZombie_Runner_C_123')
 * @returns {{ name: string, type: string }}
 */
export function classifyDamageSource(source: string): DamageClassification {
  for (const [re, name] of ZOMBIE_RULES) {
    if (re.test(source)) return { name, type: 'zombie' };
  }
  for (const [re, name] of BANDIT_RULES) {
    if (re.test(source)) return { name, type: 'bandit' };
  }
  for (const [re, name] of ANIMAL_RULES) {
    if (re.test(source)) return { name, type: 'animal' };
  }
  // No BP_ prefix → player name
  if (!source.startsWith('BP_')) return { name: source, type: 'player' };
  return { name: 'Unknown', type: 'environment' };
}

/**
 * Classify a raw damage source into a flat display label.
 * Used by PlayerStats for damage-taken stat bucketing.
 *
 * Same classification logic but with simplified return values
 * optimised for stat counters (merges armoured variants, etc.).
 *
 * @param source - Raw damage source
 * @returns Human-readable label
 */
export function classifyDamageLabel(source: string): string {
  // Specific zombie variants
  if (/Dogzombie/i.test(source)) return 'Dog Zombie';
  if (/ZombieBear/i.test(source)) return 'Zombie Bear';
  if (/Mutant/i.test(source)) return 'Mutant';
  if (/Runner.*Brute|Brute.*Runner|RunnerBrute/i.test(source)) return 'Runner Brute';
  if (/Runner/i.test(source)) return 'Runner';
  if (/Brute/i.test(source)) return 'Brute';
  if (/Pudge|BellyToxic/i.test(source)) return 'Bloater';
  // PlayerStats groups all armoured into one bucket
  if (/Police|Cop|MilitaryArmoured|Camo|Hazmat/i.test(source)) return 'Armoured';
  if (/Zombie/i.test(source)) return 'Zombie';
  if (/KaiHuman/i.test(source)) return 'Bandit';
  if (/Wolf/i.test(source)) return 'Wolf';
  if (/Bear/i.test(source)) return 'Bear';
  if (/Deer/i.test(source)) return 'Deer';
  if (/Snake/i.test(source)) return 'Snake';
  if (/Spider/i.test(source)) return 'Spider';
  if (/Human/i.test(source)) return 'NPC';
  // No BP_ prefix → player
  if (!source.startsWith('BP_')) return 'Player';
  return 'Other';
}

/**
 * Check if a damage source looks like an NPC/AI entity rather than a player.
 * UE4 blueprint-style names always have underscores — player names don't.
 * Secondary regex catches bare NPC type names without BP_ prefix.
 *
 * @param source - Damage source string
 * @returns boolean
 */
export function isNpcDamageSource(source: string): boolean {
  if (source.includes('_')) return true;
  // Space-separated UE4 pawn format: "Pawn Zombie Runner C 2147019193(25m) Weapon()"
  if (/^Pawn\s/i.test(source)) return true;
  return /^(?:Zombie|ZombieBear|KaiHuman|Mutant|Runner|Brute|RunnerBrute|Pudge|Dogzombie|BellyToxic|Police|Cop|Military|MilitaryArmoured|Hazmat|Camo|Wolf|Bear|Deer|Snake|Spider)$/i.test(
    source,
  );
}
