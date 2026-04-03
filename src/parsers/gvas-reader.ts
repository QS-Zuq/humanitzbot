/**
 * Low-level GVAS (Unreal Engine 4 save format) binary reader.
 *
 * This module provides:
 *   - createReader(buf)  — wraps a Buffer with offset-tracking read functions
 *   - parseHeader(r)     — reads and validates the GVAS file header
 *   - readProperty(r)    — reads a single UProperty from the stream
 *   - cleanName(name)    — strips UE4 GUID suffixes from property names
 *
 * The reader handles all standard UE4 property types:
 *   BoolProperty, IntProperty, UInt32Property, Int64Property,
 *   FloatProperty, DoubleProperty, StrProperty, NameProperty,
 *   SoftObjectProperty, ObjectProperty, EnumProperty, ByteProperty,
 *   TextProperty, StructProperty, ArrayProperty, MapProperty, SetProperty
 *
 * Struct subtypes: Vector, Rotator, Quat, Guid, LinearColor, DateTime,
 *   Timespan, Vector2D, GameplayTag, GameplayTagContainer, TimerHandle,
 *   Transform, SoftClassPath, SoftObjectPath, + generic fallback
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GvasReader {
  buf: Buffer;
  readU8: () => number;
  readU16: () => number;
  readU32: () => number;
  readI32: () => number;
  readI64: () => number;
  readF32: () => number;
  readF64: () => number;
  readGuid: () => string;
  readBool: () => boolean;
  readFString: () => string;
  getOffset: () => number;
  setOffset: (o: number) => void;
  remaining: () => number;
  peek: (bytes: number) => Buffer;
  skip: (bytes: number) => void;
  length: number;
}

export interface GvasCustomVersion {
  guid: string;
  version: number;
}

export interface GvasHeader {
  magic: string;
  saveVersion: number;
  packageVersion: number;
  engineVersion: {
    major: number;
    minor: number;
    patch: number;
  };
  build: number;
  branch: string;
  customVersions: GvasCustomVersion[];
  saveClass?: string;
}

export interface GvasProperty {
  name: string;
  type: string;
  raw: string;
  value: unknown;
  structType?: string;
  enumType?: string;
  innerType?: string;
  count?: number;
  arrayStructType?: string;
  keyType?: string;
  valType?: string;
  children?: GvasProperty[];
}

export interface ReadPropertyOptions {
  skipLargeArrays?: boolean;
  skipThreshold?: number;
}

// ─── Binary Reader ──────────────────────────────────────────────────────────

function createReader(buf: Buffer): GvasReader {
  let offset = 0;

  function readU8(): number {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- binary parser controls offset, value guaranteed present
    return buf[offset++]!;
  }
  function readU16(): number {
    const v = buf.readUInt16LE(offset);
    offset += 2;
    return v;
  }
  function readU32(): number {
    const v = buf.readUInt32LE(offset);
    offset += 4;
    return v;
  }
  function readI32(): number {
    const v = buf.readInt32LE(offset);
    offset += 4;
    return v;
  }
  function readI64(): number {
    const lo = buf.readUInt32LE(offset);
    const hi = buf.readInt32LE(offset + 4);
    offset += 8;
    return Number(BigInt(hi) * 0x100000000n + BigInt(lo >>> 0));
  }
  function readF32(): number {
    const v = buf.readFloatLE(offset);
    offset += 4;
    return v;
  }
  function readF64(): number {
    const v = buf.readDoubleLE(offset);
    offset += 8;
    return v;
  }
  function readGuid(): string {
    const g = buf.subarray(offset, offset + 16);
    offset += 16;
    return g.toString('hex');
  }
  function readBool(): boolean {
    return readU8() !== 0;
  }

  /**
   * Read a UE4 FString (length-prefixed, null-terminated).
   * Positive length = UTF-8, negative length = UTF-16LE.
   */
  function readFString(): string {
    const len = readI32();
    if (len === 0) return '';
    if (len > 0 && len < 65536) {
      const s = buf.toString('utf8', offset, offset + len - 1);
      offset += len;
      return s;
    }
    if (len < 0 && len > -65536) {
      const chars = -len;
      const s = buf.toString('utf16le', offset, offset + (chars - 1) * 2);
      offset += chars * 2;
      return s;
    }
    throw new Error(`Bad FString length: ${String(len)} at offset ${String(offset - 4)}`);
  }

  function getOffset(): number {
    return offset;
  }
  function setOffset(o: number): void {
    offset = o;
  }
  function remaining(): number {
    return buf.length - offset;
  }
  function peek(bytes: number): Buffer {
    return buf.subarray(offset, offset + bytes);
  }
  function skip(bytes: number): void {
    offset += bytes;
  }

  return {
    buf,
    readU8,
    readU16,
    readU32,
    readI32,
    readI64,
    readF32,
    readF64,
    readGuid,
    readBool,
    readFString,
    getOffset,
    setOffset,
    remaining,
    peek,
    skip,
    length: buf.length,
  };
}

// ─── Clean UE4 GUID suffixes from property names ───────────────────────────

function cleanName(name: string): string {
  return name.replace(/_\d+_[A-F0-9]{32}$/i, '');
}

// ─── GVAS header parser ────────────────────────────────────────────────────

function parseHeader(r: GvasReader): GvasHeader {
  const magic = Buffer.from([r.readU8(), r.readU8(), r.readU8(), r.readU8()]).toString('ascii');

  if (magic !== 'GVAS') throw new Error('Not a GVAS save file');

  const header: GvasHeader = {
    magic,
    saveVersion: r.readU32(),
    packageVersion: r.readU32(),
    engineVersion: {
      major: r.readU16(),
      minor: r.readU16(),
      patch: r.readU16(),
    },
    build: r.readU32(),
    branch: r.readFString(),
    customVersions: [],
  };

  r.readU32(); // custom version format
  const numCV = r.readU32();
  for (let i = 0; i < numCV; i++) {
    header.customVersions.push({ guid: r.readGuid(), version: r.readI32() });
  }
  header.saveClass = r.readFString();

  return header;
}

// ─── Property type names we capture MapProperty values for ─────────────────

const MAP_CAPTURE = new Set([
  'GameStats',
  'FloatData',
  'CustomData',
  'LODHouseData',
  'RandQuestConfig',
  'SGlobalContainerSave',
  'LodModularLootActor',
]);

// ─── Read a single UProperty ───────────────────────────────────────────────

/**
 * Read one UProperty from the stream.
 * Returns { name, type, raw, value, ...extras } or null at end/error.
 */
function readProperty(r: GvasReader, options: ReadPropertyOptions = {}): GvasProperty | null {
  const skipLargeArrays = options.skipLargeArrays ?? false;
  const skipThreshold = options.skipThreshold ?? 10;

  if (r.remaining() < 4) return null;
  const startOff = r.getOffset();

  let name: string;
  try {
    name = r.readFString();
  } catch {
    return null;
  }
  if (name === 'None' || name === '') return null;

  let typeName: string;
  try {
    typeName = r.readFString();
  } catch {
    r.setOffset(startOff);
    return null;
  }

  const dataSize = r.readI64();
  if (dataSize < 0 || dataSize > r.length) {
    r.setOffset(startOff);
    return null;
  }

  const cname = cleanName(name);
  const prop: GvasProperty = { name: cname, type: typeName, raw: name, value: null };

  try {
    switch (typeName) {
      case 'BoolProperty':
        prop.value = r.readBool();
        r.readU8(); // separator
        break;

      case 'IntProperty':
        r.readU8();
        prop.value = r.readI32();
        break;

      case 'UInt32Property':
        r.readU8();
        prop.value = r.readU32();
        break;

      case 'Int64Property':
        r.readU8();
        prop.value = r.readI64();
        break;

      case 'FloatProperty':
        r.readU8();
        prop.value = r.readF32();
        break;

      case 'DoubleProperty':
        r.readU8();
        prop.value = r.readF64();
        break;

      case 'StrProperty':
      case 'NameProperty':
      case 'SoftObjectProperty':
      case 'ObjectProperty':
        r.readU8();
        prop.value = r.readFString();
        break;

      case 'EnumProperty':
        prop.enumType = r.readFString();
        r.readU8();
        prop.value = r.readFString();
        break;

      case 'ByteProperty': {
        const enumName = r.readFString();
        r.readU8();
        if (enumName === 'None') {
          prop.value = r.readU8();
        } else {
          prop.enumType = enumName;
          prop.value = r.readFString();
        }
        break;
      }

      case 'TextProperty':
        r.readU8();
        r.setOffset(r.getOffset() + dataSize);
        prop.value = '<text>';
        break;

      case 'StructProperty':
        _readStructProperty(r, prop, dataSize);
        break;

      case 'ArrayProperty':
        _readArrayProperty(r, prop, dataSize, { skipLargeArrays, skipThreshold });
        break;

      case 'MapProperty':
        _readMapProperty(r, prop, dataSize, cname);
        break;

      case 'SetProperty': {
        r.readFString(); // inner type
        r.readU8();
        r.setOffset(r.getOffset() + dataSize);
        prop.value = null;
        break;
      }

      default:
        r.readU8();
        r.setOffset(r.getOffset() + dataSize);
        prop.value = null;
        break;
    }
  } catch {
    // Unrecoverable parse error within this property
    return null;
  }

  return prop;
}

// ─── Struct subtypes ───────────────────────────────────────────────────────

function _readStructProperty(r: GvasReader, prop: GvasProperty, _dataSize: number): void {
  const structType = r.readFString();
  r.readGuid();
  r.readU8();
  prop.structType = structType;

  switch (structType) {
    case 'Vector':
    case 'Rotator':
      prop.value = { x: r.readF32(), y: r.readF32(), z: r.readF32() };
      break;

    case 'Quat':
      prop.value = { x: r.readF32(), y: r.readF32(), z: r.readF32(), w: r.readF32() };
      break;

    case 'Guid':
      prop.value = r.readGuid();
      break;

    case 'LinearColor':
      prop.value = { r: r.readF32(), g: r.readF32(), b: r.readF32(), a: r.readF32() };
      break;

    case 'DateTime':
    case 'Timespan':
      prop.value = r.readI64();
      break;

    case 'Vector2D':
      prop.value = { x: r.readF32(), y: r.readF32() };
      break;

    case 'GameplayTagContainer': {
      const c = r.readU32();
      const tags: string[] = [];
      for (let i = 0; i < c; i++) {
        tags.push(r.readFString());
      }
      prop.value = tags;
      break;
    }

    case 'TimerHandle':
      prop.value = r.readFString();
      break;

    case 'SoftClassPath':
    case 'SoftObjectPath':
      prop.value = r.readFString();
      break;

    case 'Transform': {
      const subProps: GvasProperty[] = [];
      let sub: GvasProperty | null;
      while ((sub = readProperty(r)) !== null) {
        subProps.push(sub);
      }
      const translation = subProps.find((s) => s.name === 'Translation');
      const rotation = subProps.find((s) => s.name === 'Rotation');
      const scale = subProps.find((s) => s.name === 'Scale3D');
      prop.value = {
        translation: translation?.value ?? null,
        rotation: rotation?.value ?? null,
        scale: scale?.value ?? null,
      };
      prop.children = subProps;
      break;
    }

    default: {
      // Generic struct — recursively read child properties
      prop.value = 'struct';
      const children: GvasProperty[] = [];
      let child: GvasProperty | null;
      while ((child = readProperty(r)) !== null) {
        children.push(child);
      }
      prop.children = children;
      break;
    }
  }
}

// ─── Array subtypes ────────────────────────────────────────────────────────

interface ArrayOptions {
  skipLargeArrays: boolean;
  skipThreshold: number;
}

function _readArrayProperty(r: GvasReader, prop: GvasProperty, dataSize: number, options: ArrayOptions): void {
  const innerType = r.readFString();
  r.readU8();
  const afterSep = r.getOffset();
  const count = r.readI32();
  prop.innerType = innerType;
  prop.count = count;

  if (innerType === 'StructProperty') {
    r.readFString(); // arrName
    r.readFString(); // arrType
    r.readI64(); // arrSize
    const arrStructType = r.readFString();
    r.readGuid();
    r.readU8();
    prop.arrayStructType = arrStructType;

    // Skip large world-geometry arrays (Transform, Vector, Rotator)
    if (
      options.skipLargeArrays &&
      ['Transform', 'Vector', 'Rotator'].includes(arrStructType) &&
      count > options.skipThreshold
    ) {
      r.setOffset(afterSep + dataSize);
      prop.value = `<skipped ${String(count)}>`;
      return;
    }

    if (arrStructType === 'S_Slots') {
      // Inventory slots — parse to extract items
      prop.value = _parseInventorySlots(r, count);
    } else if (arrStructType === 'Guid') {
      // Guid arrays are inline 16-byte values, not property lists
      const guids: string[] = [];
      for (let i = 0; i < count; i++) {
        guids.push(r.readGuid());
      }
      prop.value = guids;
    } else if (arrStructType === 'Vector' || arrStructType === 'Rotator') {
      // Inline 12-byte structs (3 x float32)
      const vecs: Array<{ x: number; y: number; z: number }> = [];
      for (let i = 0; i < count; i++) {
        vecs.push({ x: r.readF32(), y: r.readF32(), z: r.readF32() });
      }
      prop.value = vecs;
    } else if (arrStructType === 'Quat') {
      // Inline 16-byte structs (4 x float32)
      const quats: Array<{ x: number; y: number; z: number; w: number }> = [];
      for (let i = 0; i < count; i++) {
        quats.push({ x: r.readF32(), y: r.readF32(), z: r.readF32(), w: r.readF32() });
      }
      prop.value = quats;
    } else if (arrStructType === 'LinearColor') {
      // Inline 16-byte structs (4 x float32)
      const colors: Array<{ r: number; g: number; b: number; a: number }> = [];
      for (let i = 0; i < count; i++) {
        colors.push({ r: r.readF32(), g: r.readF32(), b: r.readF32(), a: r.readF32() });
      }
      prop.value = colors;
    } else if (arrStructType === 'DateTime' || arrStructType === 'Timespan') {
      // Inline 8-byte values
      const times: number[] = [];
      for (let i = 0; i < count; i++) {
        times.push(r.readI64());
      }
      prop.value = times;
    } else if (arrStructType === 'Vector2D') {
      // Inline 8-byte structs (2 x float32)
      const vec2s: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < count; i++) {
        vec2s.push({ x: r.readF32(), y: r.readF32() });
      }
      prop.value = vec2s;
    } else {
      // Generic struct array — parse each element
      const elements: GvasProperty[][] = [];
      for (let i = 0; i < count; i++) {
        const elemProps: GvasProperty[] = [];
        let child: GvasProperty | null;
        while ((child = readProperty(r)) !== null) {
          elemProps.push(child);
        }
        elements.push(elemProps);
      }
      prop.value = elements;
    }
  } else if (innerType === 'NameProperty' || innerType === 'StrProperty' || innerType === 'ObjectProperty') {
    const strs: string[] = [];
    for (let i = 0; i < count; i++) {
      strs.push(r.readFString());
    }
    prop.value = strs;
  } else if (innerType === 'IntProperty') {
    const ints: number[] = [];
    for (let i = 0; i < count; i++) {
      ints.push(r.readI32());
    }
    prop.value = ints;
  } else if (innerType === 'FloatProperty') {
    const floats: number[] = [];
    for (let i = 0; i < count; i++) {
      floats.push(r.readF32());
    }
    prop.value = floats;
  } else if (innerType === 'BoolProperty') {
    const bools: boolean[] = [];
    for (let i = 0; i < count; i++) {
      bools.push(r.readBool());
    }
    prop.value = bools;
  } else if (innerType === 'ByteProperty') {
    const bytes: number[] = [];
    for (let i = 0; i < count; i++) {
      bytes.push(r.readU8());
    }
    prop.value = bytes;
  } else if (innerType === 'EnumProperty') {
    const enums: string[] = [];
    for (let i = 0; i < count; i++) {
      enums.push(r.readFString());
    }
    prop.value = enums;
  } else if (innerType === 'UInt32Property') {
    const uints: number[] = [];
    for (let i = 0; i < count; i++) {
      uints.push(r.readU32());
    }
    prop.value = uints;
  } else {
    // Unknown inner type — skip the data
    r.setOffset(afterSep + dataSize);
    prop.value = `<unknown ${innerType}>`;
  }
}

// ─── Inventory slot parsing ────────────────────────────────────────────────

interface InventorySlot {
  item: string;
  amount: number;
  durability: number;
  ammo?: number;
  attachments?: unknown[];
  cap?: number;
  weight?: number;
  maxDur?: number;
  wetness?: number;
}

function _parseInventorySlots(r: GvasReader, count: number): InventorySlot[] {
  const items: InventorySlot[] = [];
  for (let i = 0; i < count; i++) {
    const slotProps: GvasProperty[] = [];
    let child: GvasProperty | null;
    while ((child = readProperty(r)) !== null) {
      slotProps.push(child);
    }

    let itemName: string | null = null;
    let amount = 0;
    let durability = 0;
    let ammo = 0;
    let attachments: unknown[] = [];
    let cap = 0;
    let weight = 0;
    let maxDur = 0;
    let wetness = 0;
    for (const sp of slotProps) {
      if (sp.name === 'Item' && sp.children) {
        for (const c of sp.children) {
          if (c.name === 'RowName') itemName = c.value as string;
        }
      }
      if (sp.name === 'Amount') amount = (sp.value as number) || 0;
      if (sp.name === 'Durability') durability = (sp.value as number) || 0;
      if (sp.name === 'Ammo') ammo = (sp.value as number) || 0;
      if (sp.name === 'Attachments' && Array.isArray(sp.value)) attachments = sp.value;
      if (sp.name === 'Cap') cap = (sp.value as number) || 0;
      if (sp.name === 'Weight') weight = (sp.value as number) || 0;
      if (sp.name === 'MaxDur') maxDur = (sp.value as number) || 0;
      if (sp.name === 'Wetness') wetness = (sp.value as number) || 0;
    }

    if (itemName && itemName !== 'None' && itemName !== 'Empty') {
      const slot: InventorySlot = {
        item: itemName,
        amount,
        durability: Math.round(durability * 100) / 100,
      };
      if (ammo) slot.ammo = ammo;
      if (attachments.length) slot.attachments = attachments;
      if (cap) slot.cap = Math.round(cap * 100) / 100;
      if (weight) slot.weight = Math.round(weight * 10000) / 10000;
      if (maxDur) slot.maxDur = Math.round(maxDur * 100) / 100;
      if (wetness) slot.wetness = Math.round(wetness * 100) / 100;
      items.push(slot);
    }
  }
  return items;
}

// ─── Map property ──────────────────────────────────────────────────────────

interface MapEntry {
  key: unknown;
  value: unknown;
}

function _readMapProperty(r: GvasReader, prop: GvasProperty, dataSize: number, cname: string): void {
  const keyType = r.readFString();
  const valType = r.readFString();
  r.readU8();
  const afterSep = r.getOffset();
  prop.keyType = keyType;
  prop.valType = valType;

  if (MAP_CAPTURE.has(cname)) {
    r.readI32(); // removedCount
    const count = r.readI32();

    // StructProperty values require recursive parsing
    if (valType === 'StructProperty' || keyType === 'StructProperty') {
      const entries: MapEntry[] = [];
      for (let i = 0; i < count; i++) {
        const entry: MapEntry = { key: null, value: null };
        // Read key
        if (keyType === 'StrProperty' || keyType === 'NameProperty') entry.key = r.readFString();
        else if (keyType === 'IntProperty') entry.key = r.readI32();
        else if (keyType === 'EnumProperty') entry.key = r.readFString();
        else if (keyType === 'StructProperty') {
          const keyProps: GvasProperty[] = [];
          let kp: GvasProperty | null;
          while ((kp = readProperty(r)) !== null) {
            keyProps.push(kp);
          }
          entry.key = keyProps;
        }
        // Read value
        if (valType === 'StructProperty') {
          const valProps: GvasProperty[] = [];
          let vp: GvasProperty | null;
          while ((vp = readProperty(r)) !== null) {
            valProps.push(vp);
          }
          entry.value = valProps;
        } else if (valType === 'FloatProperty') entry.value = r.readF32();
        else if (valType === 'IntProperty') entry.value = r.readI32();
        else if (valType === 'StrProperty') entry.value = r.readFString();
        else if (valType === 'BoolProperty') entry.value = r.readBool();
        entries.push(entry);
      }
      prop.value = entries;
      return;
    }

    const entries: Record<string, unknown> = {};
    for (let i = 0; i < count; i++) {
      let key: string | number;
      if (keyType === 'StrProperty' || keyType === 'NameProperty') key = r.readFString();
      else if (keyType === 'IntProperty') key = r.readI32();
      else if (keyType === 'EnumProperty') key = r.readFString();
      else {
        r.setOffset(afterSep + dataSize);
        prop.value = null;
        return;
      }

      let val: unknown;
      if (valType === 'FloatProperty') val = r.readF32();
      else if (valType === 'IntProperty') val = r.readI32();
      else if (valType === 'StrProperty') val = r.readFString();
      else if (valType === 'BoolProperty') val = r.readBool();
      else {
        r.setOffset(afterSep + dataSize);
        prop.value = null;
        return;
      }

      entries[key] = val;
    }
    prop.value = entries;
  } else {
    // Skip maps we don't need to capture
    r.setOffset(afterSep + dataSize);
    prop.value = null;
  }
}

// ─── Recovery: scan forward for next valid property ────────────────────────

/**
 * When parsing gets stuck (null property without offset advancement),
 * scan forward to find the next valid property header.
 */
function recoverForward(r: GvasReader, startPos: number, maxScan = 500000): boolean {
  const buf = r.buf;
  for (let scan = startPos + 1; scan < Math.min(startPos + maxScan, buf.length - 10); scan++) {
    const len = buf.readInt32LE(scan);
    if (len > 3 && len < 80) {
      const peek = buf.toString('utf8', scan + 4, scan + 4 + len - 1);
      if (/^[A-Z][a-zA-Z0-9_]{2,60}$/.test(peek)) {
        r.setOffset(scan);
        return true;
      }
    }
  }
  return false;
}

export { createReader, cleanName, parseHeader, readProperty, recoverForward, MAP_CAPTURE };
