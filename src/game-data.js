/* ── Affliction index → display name (save stores numeric index) ── */
const AFFLICTION_MAP = [
  "No Affliction",
  "ACL",
  "Alcoholic",
  "Bad Back",
  "Carnivore",
  "Feeble",
  "Fumble",
  "Gastro",
  "Heavy Feet",
  "Hemophilia",
  "Lingering Pain",
  "Never Full",
  "Night Terrors",
  "Poor Circulation",
  "Shaky Hands",
  "Tactless",
  "Veggie",
  "Wasteful",
  "Zombie Magnet"
];

/* ── Profession name → detailed info ── */
const PROFESSION_DETAILS = {
  "Unemployed": {
    "perk": "25% more experience gained",
    "description": "Having no real skills or the motivation to hold down a job, you start your fight for survival with no useful skills or perks to aide you along the way.",
    "affliction": "No Affliction",
    "unlockedSkills": []
  },
  "Amateur Boxer": {
    "perk": "Fist fighting deals 300% unarmed damage",
    "description": "Years of boxing have hardened your fists and your spirit.",
    "affliction": "Random Affliction",
    "unlockedSkills": [
      "WRESTLER",
      "SPRINTER"
    ]
  },
  "Farmer": {
    "perk": "Fertilizer is more potent",
    "description": "Working the land has taught you patience and resourcefulness.",
    "affliction": "Random Affliction",
    "unlockedSkills": [
      "BANDOLEER",
      "CARPENTRY"
    ]
  },
  "Mechanic": {
    "perk": "50% more effective with Repair Kits",
    "description": "Years of fixing cars and machinery has made you handy with tools.",
    "affliction": "Random Affliction",
    "unlockedSkills": [
      "METAL WORKING",
      "CALLUSED"
    ]
  },
  "Car Salesman": {
    "perk": "25% less NPC trading cost",
    "description": "Smooth talking comes naturally and people trust you.",
    "affliction": "Random Affliction",
    "unlockedSkills": [
      "CHARISMA",
      "HAGGLER"
    ]
  },
  "Outdoorsman": {
    "perk": "10% less bow sway",
    "description": "Living off the land is second nature to you.",
    "affliction": "Random Affliction",
    "unlockedSkills": [
      "VITAL SHOT",
      "SPEED STEALTH"
    ]
  },
  "Chemist": {
    "perk": "Craft x2 treatments at chemistry station",
    "description": "A background in chemistry gives you an edge in crafting medicines.",
    "affliction": "Random Affliction",
    "unlockedSkills": [
      "INFECTION TREATMENT",
      "HEALTHY GUT"
    ]
  },
  "Emergency Medical Technician": {
    "perk": "25% better healing effectiveness",
    "description": "First responder training has prepared you for trauma situations.",
    "affliction": "Random Affliction",
    "unlockedSkills": [
      "CALLUSED",
      "REDEYE"
    ]
  },
  "Military Veteran": {
    "perk": "2x fatigue resistance",
    "description": "Military training has hardened your body and mind.",
    "affliction": "Random Affliction",
    "unlockedSkills": [
      "RELOADER",
      "MAG FLIP"
    ]
  },
  "Thief": {
    "perk": "No alarms triggered when stealing",
    "description": "A life of crime has taught you how to move silently.",
    "affliction": "Random Affliction",
    "unlockedSkills": [
      "DEEP POCKETS",
      "LIGHTFOOT"
    ]
  },
  "Fire Fighter": {
    "perk": "No overheat from fire/heat",
    "description": "Braving fires has made you resistant to heat.",
    "affliction": "Random Affliction",
    "unlockedSkills": [
      "BEAST OF BURDEN",
      "CONTROLLED BREATHING"
    ]
  },
  "Electrical Engineer": {
    "perk": "Unlock all powered structures",
    "description": "Your knowledge of electronics lets you build advanced machinery.",
    "affliction": "Random Affliction",
    "unlockedSkills": [
      "HACKER",
      "RING MY BELL"
    ]
  }
};

/* ── Challenge definitions from DT_StatConfig ── */
const CHALLENGES = [
  {
    "id": "PowerPlant",
    "name": "Power Plant",
    "description": "Get the Power Plant back online"
  },
  {
    "id": "RadioTower",
    "name": "Radio Tower",
    "description": "Repair the Radio Tower"
  },
  {
    "id": "FirstQuest",
    "name": "First Quest",
    "description": "Complete a Quest"
  },
  {
    "id": "QuestMaster",
    "name": "Quest Master",
    "description": "Complete 5 Quests"
  },
  {
    "id": "Survivor3Days",
    "name": "Survivor",
    "description": "Survive for 3 Days"
  },
  {
    "id": "ShotGunner",
    "name": "Shot Gunner",
    "description": "100 Kills with a Shotgun"
  },
  {
    "id": "HeadShotKing",
    "name": "HeadShot King",
    "description": "Headshot 500 Zeeks"
  },
  {
    "id": "FistFighter",
    "name": "Fist Fighter",
    "description": "Kill Zeeks with your fist"
  },
  {
    "id": "VehicleArmor",
    "name": "Vehicle Armor",
    "description": "Completely armor a vehicle"
  },
  {
    "id": "GunDoctor",
    "name": "Gun Doctor",
    "description": "2x the amount of gunpowder crafted"
  },
  {
    "id": "SilencedKiller",
    "name": "Silenced Killer",
    "description": "Kill x10 Zeeks with a Silenced Gun"
  },
  {
    "id": "VehicleKiller",
    "name": "Vehicle Killer",
    "description": "Kill x50 Zeeks with vehicles"
  },
  {
    "id": "Completionist",
    "name": "Completionist",
    "description": "Complete 100% of all available challenges"
  },
  {
    "id": "SiphonFuel",
    "name": "Fuel Siphoner",
    "description": "Siphon fuel from a vehicle"
  },
  {
    "id": "Takedown",
    "name": "Takedown Expert",
    "description": "Perform a Takedown on an enemy"
  },
  {
    "id": "CanningStation",
    "name": "Canner",
    "description": "Can some food for the winter at the Canning Station"
  },
  {
    "id": "RepairVehicle",
    "name": "Mechanic",
    "description": "Repair a vehicle to 100% HP"
  }
];

/* ── Loading tips from DT_LoadingTips ── */
const LOADING_TIPS = [
  // General gameplay advice
  "It may be advantageous to focus on looting early",
  "Get a rain collector up so you have access to fresh water",
  "Be prepared for winter",
  "You can get seeds from eating raw vegetables",
  "Running over zeeks is fun, but it damages the vehicles",
  "Some vehicles can be destroyed for scrap metal",
  "Certain vehicles can be destroyed for scrap and sheet metal",
  "You don't need to pickup every rock that you come across",
  "Zeeks spawning in your base? Build and turn on the Spawn Point.",
  "Gas Masks help against toxic Zeeks!",
  "Check the boot/trunk of vehicles for loot",
  "Hold Interact to pick up and put down explodable barrels",
  "Bait can also sometimes be found by chopping up bushes",
  "You can get logs and wood from chopping down trees",
  "Fiber and sticks for Rope from chopping down bushes",
  "A backpack can increase carrying capacity considerably",
  "Some vehicles have significantly more storage space than others",
  "The trunk of a vehicle also has storage space you can access by pressing F",
  "Infection can be caused by zeek bites, there is no cure for infection...",
  "It can be treated with infection treatment, crafted at a medical station",
  "If a treatment is not administered in time you will die",
  "When it rains the rain collector will catch some fresh water",
  "In the UK they say \"give me a tinkle\" instead of \"call me\"",
  "You can follow the suggestions or not. It's your story.",

  // Controls & UI
  "At any point you can hit F1 to access the help menu",
  "RMB will zoom out on most weapons",
  "If unarmed, press RMB to enter melee mode",
  "RMB to enter and exit combat stance",
  "Q and E rotate the camera to give you a better angle on the situation",
  "Hold Interact to enter a vehicle",
  "If your car stalls press E to crank the engine",
  "Ctrl+Click to quick move a stack of items",
  "Ctrl+Right click to drop half of a stacked item",
  "Quickly drop your weapon/backpack by pressing X/U",
  "V to kick and middle mouse to perform a finisher on an enemy",
  "You can sleep using the Emote Wheel",
  "Toggle C to Crouch",
  "Toggle Left Shift to Sprint",
  "Toggle Left CTRL to walk",
  "Spacebar to jump or vault",
  "Press T to toggle your flashlight, don't forget to turn it off",
  "Press B to enter build mode",
  "You can open and close your inventory by pressing Tab",
  "Use M and N to cycle through different inventory screens",
  "You can use hot keys 1 through 4 to switch weapons",
  "Add a quick use item to slot 5 by toggling Left CTRL — handy for meds",
  "H will sound the horn, T will turn on the headlights and F will exit the vehicle",
  "When crouched you can sneak around zeeks",
  "If you have knocked a zeek down, press V to finish him off",
  "You can use MMB to execute a takedown but it will cost a lot of stamina",
  "Walking or crouching reduces your footsteps and minimizes the chance of being spotted",
  "You can change the colour of your cursor",
  "Make sure you are facing the item you want to interact with",
  "Your character will face in the direction of the crosshair",
  "While looking at a build, required resources are displayed at the top right",

  // Vitals & survival info
  "The bottom left displays your current vital statuses",
  "From left to right is Health, Thirst, Hunger, Stamina, and Infection",
  "These vitals can be managed by consuming the appropriate items",

  // Inventory & loadout
  "You may hold four weapons and one item in your quick slots",
  "Two large weapons in slots 1 and 2, a sidearm in slot 3, and a small melee weapon in slot 4",
  "If slots 1 and 2 are full and you have a large weapon in your hands, hot keys will not work",

  // Fishing
  "When a fish bites you will see a significant increase in tension on the line",
  "You can reel in your line by repeatedly clicking LMB",
  "If the tension bar fills to the top the line will break, so be careful",
];

/* ── Skill effect descriptions (from perk/profession data) ── */
const SKILL_EFFECTS = {
  'CALLUSED': 'Melee damage reduced by 25%',
  'SPRINTER': 'Sprint speed increased',
  'WRESTLER': 'Grapple attack damage increased',
  'BANDOLEER': 'Carry more ammo',
  'CARPENTRY': 'Building speed increased',
  'METAL WORKING': 'Metal crafting improved',
  'CHARISMA': 'Better NPC interactions',
  'HAGGLER': 'Better trade prices',
  'VITAL SHOT': 'Critical hit chance increased',
  'SPEED STEALTH': 'Move faster while crouching',
  'INFECTION TREATMENT': 'Infection cure effectiveness up',
  'HEALTHY GUT': 'Food poisoning resistance',
  'REDEYE': 'Reduced recoil',
  'RELOADER': 'Faster reload speed',
  'MAG FLIP': 'Instant magazine swap',
  'DEEP POCKETS': 'Extra inventory slots',
  'LIGHTFOOT': 'Quieter movement',
  'BEAST OF BURDEN': 'Carry weight increased by 25%',
  'CONTROLLED BREATHING': 'Steadier aim when aiming down sights',
  'HACKER': 'Can hack electronic locks',
  'RING MY BELL': 'Electronic traps more effective',
};

/* ── GameServerSettings.ini key descriptions ── */
const SERVER_SETTING_DESCRIPTIONS = {
  'ServerName': 'Server Name',
  'MaxPlayers': 'Max Players',
  'GameMode': 'Game Mode',
  'DifficultyLevel': 'Difficulty',
  'ZombiePopulation': 'Zombie Population',
  'ZombieDifficulty': 'Zombie Difficulty',
  'LootRespawnTime': 'Loot Respawn Time',
  'DayNightCycle': 'Day/Night Cycle Speed',
  'PvPEnabled': 'PvP Enabled',
  'FriendlyFire': 'Friendly Fire',
  'BuildAnywhere': 'Build Anywhere',
  'DropItemsOnDeath': 'Drop Items On Death',
  'ShowMapPlayerPosition': 'Show Player Position on Map',
  'MaxStructures': 'Max Structures',
  'VehicleRespawnTime': 'Vehicle Respawn Time',
  'StaminaDrain': 'Stamina Drain Rate',
  'HungerDrain': 'Hunger Drain Rate',
  'ThirstDrain': 'Thirst Drain Rate',
  'PlayerDamageMultiplier': 'Player Damage Multiplier',
  'ZombieDamageMultiplier': 'Zombie Damage Multiplier',
  'StructureDamageMultiplier': 'Structure Damage Multiplier',
  'ResourceGatherMultiplier': 'Resource Gather Multiplier',
  'XPMultiplier': 'XP Multiplier',
  'CraftingSpeedMultiplier': 'Crafting Speed Multiplier',
};

module.exports = {
  AFFLICTION_MAP,
  PROFESSION_DETAILS,
  CHALLENGES,
  LOADING_TIPS,
  SKILL_EFFECTS,
  SERVER_SETTING_DESCRIPTIONS,
};
