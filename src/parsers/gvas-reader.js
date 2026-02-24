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

// ─── Binary Reader ──────────────────────────────────────────────────────────

function createReader(buf) {
  let offset = 0;

  function readU8()  { return buf[offset++]; }
  function readU16() { const v = buf.readUInt16LE(offset); offset += 2; return v; }
  function readU32() { const v = buf.readUInt32LE(offset); offset += 4; return v; }
  function readI32() { const v = buf.readInt32LE(offset); offset += 4; return v; }
  function readI64() {
    const lo = buf.readUInt32LE(offset);
    const hi = buf.readInt32LE(offset + 4);
    offset += 8;
    return Number(BigInt(hi) * 0x100000000n + BigInt(lo >>> 0));
  }
  function readF32() { const v = buf.readFloatLE(offset); offset += 4; return v; }
  function readF64() { const v = buf.readDoubleLE(offset); offset += 8; return v; }
  function readGuid() {
    const g = buf.subarray(offset, offset + 16);
    offset += 16;
    return g.toString('hex');
  }
  function readBool() { return readU8() !== 0; }

  /**
   * Read a UE4 FString (length-prefixed, null-terminated).
   * Positive length = UTF-8, negative length = UTF-16LE.
   */
  function readFString() {
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
    throw new Error(`Bad FString length: ${len} at offset ${offset - 4}`);
  }

  function getOffset() { return offset; }
  function setOffset(o) { offset = o; }
  function remaining() { return buf.length - offset; }
  function peek(bytes) { return buf.subarray(offset, offset + bytes); }
  function skip(bytes) { offset += bytes; }

  return {
    buf,
    readU8, readU16, readU32, readI32, readI64,
    readF32, readF64, readGuid, readBool, readFString,
    getOffset, setOffset, remaining, peek, skip,
    length: buf.length,
  };
}

// ─── Clean UE4 GUID suffixes from property names ───────────────────────────

function cleanName(name) {
  return name.replace(/_\d+_[A-F0-9]{32}$/i, '');
}

// ─── GVAS header parser ────────────────────────────────────────────────────

function parseHeader(r) {
  const magic = Buffer.from([
    r.readU8(), r.readU8(), r.readU8(), r.readU8(),
  ]).toString('ascii');

  if (magic !== 'GVAS') throw new Error('Not a GVAS save file');

  const header = {
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
  'GameStats', 'FloatData', 'CustomData', 'LODHouseData',
  'RandQuestConfig', 'SGlobalContainerSave',
]);

// ─── Read a single UProperty ───────────────────────────────────────────────

/**
 * Read one UProperty from the stream.
 * Returns { name, type, raw, value, ...extras } or null at end/error.
 *
 * @param {object} r - Reader from createReader()
 * @param {object} [options]
 * @param {boolean} [options.skipLargeArrays=false] - Skip arrays >100 elements of Vector/Rotator/Transform
 * @returns {object|null}
 */
function readProperty(r, options = {}) {
  const skipLargeArrays = options.skipLargeArrays ?? false;
  const skipThreshold = options.skipThreshold ?? 10;

  if (r.remaining() < 4) return null;
  const startOff = r.getOffset();

  let name;
  try { name = r.readFString(); } catch { return null; }
  if (name === 'None' || name === '') return null;

  let typeName;
  try { typeName = r.readFString(); } catch { r.setOffset(startOff); return null; }

  const dataSize = r.readI64();
  if (dataSize < 0 || dataSize > r.length) { r.setOffset(startOff); return null; }

  const cname = cleanName(name);
  const prop = { name: cname, type: typeName, raw: name };

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
  } catch (e) {
    // Unrecoverable parse error within this property
    return null;
  }

  return prop;
}

// ─── Struct subtypes ───────────────────────────────────────────────────────

function _readStructProperty(r, prop, dataSize) {
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
      prop.value = [];
      for (let i = 0; i < c; i++) prop.value.push(r.readFString());
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
      const subProps = [];
      let sub;
      while ((sub = readProperty(r)) !== null) subProps.push(sub);
      const translation = subProps.find(s => s.name === 'Translation');
      const rotation = subProps.find(s => s.name === 'Rotation');
      const scale = subProps.find(s => s.name === 'Scale3D');
      prop.value = {
        translation: translation?.value || null,
        rotation: rotation?.value || null,
        scale: scale?.value || null,
      };
      prop.children = subProps;
      break;
    }

    default: {
      // Generic struct — recursively read child properties
      prop.value = 'struct';
      const children = [];
      let child;
      while ((child = readProperty(r)) !== null) children.push(child);
      prop.children = children;
      break;
    }
  }
}

// ─── Array subtypes ────────────────────────────────────────────────────────

function _readArrayProperty(r, prop, dataSize, options) {
  const innerType = r.readFString();
  r.readU8();
  const afterSep = r.getOffset();
  const count = r.readI32();
  prop.innerType = innerType;
  prop.count = count;

  if (innerType === 'StructProperty') {
    r.readFString(); // arrName
    r.readFString(); // arrType
    r.readI64();     // arrSize
    const arrStructType = r.readFString();
    r.readGuid();
    r.readU8();
    prop.arrayStructType = arrStructType;

    // Skip large world-geometry arrays (Transform, Vector, Rotator)
    if (options.skipLargeArrays
        && ['Transform', 'Vector', 'Rotator'].includes(arrStructType)
        && count > options.skipThreshold) {
      r.setOffset(afterSep + dataSize);
      prop.value = `<skipped ${count}>`;
      return;
    }

    if (arrStructType === 'S_Slots') {
      // Inventory slots — parse to extract items  
      prop.value = _parseInventorySlots(r, count);
    } else if (arrStructType === 'Guid') {
      // Guid arrays are inline 16-byte values, not property lists
      prop.value = [];
      for (let i = 0; i < count; i++) prop.value.push(r.readGuid());
    } else if (arrStructType === 'Vector' || arrStructType === 'Rotator') {
      // Inline 12-byte structs (3 x float32)
      prop.value = [];
      for (let i = 0; i < count; i++) prop.value.push({ x: r.readF32(), y: r.readF32(), z: r.readF32() });
    } else if (arrStructType === 'Quat') {
      // Inline 16-byte structs (4 x float32)
      prop.value = [];
      for (let i = 0; i < count; i++) prop.value.push({ x: r.readF32(), y: r.readF32(), z: r.readF32(), w: r.readF32() });
    } else if (arrStructType === 'LinearColor') {
      // Inline 16-byte structs (4 x float32)
      prop.value = [];
      for (let i = 0; i < count; i++) prop.value.push({ r: r.readF32(), g: r.readF32(), b: r.readF32(), a: r.readF32() });
    } else if (arrStructType === 'DateTime' || arrStructType === 'Timespan') {
      // Inline 8-byte values
      prop.value = [];
      for (let i = 0; i < count; i++) prop.value.push(r.readI64());
    } else if (arrStructType === 'Vector2D') {
      // Inline 8-byte structs (2 x float32)
      prop.value = [];
      for (let i = 0; i < count; i++) prop.value.push({ x: r.readF32(), y: r.readF32() });
    } else {
      // Generic struct array — parse each element
      const elements = [];
      for (let i = 0; i < count; i++) {
        const elemProps = [];
        let child;
        while ((child = readProperty(r)) !== null) elemProps.push(child);
        elements.push(elemProps);
      }
      prop.value = elements;
    }
  } else if (innerType === 'NameProperty' || innerType === 'StrProperty' || innerType === 'ObjectProperty') {
    prop.value = [];
    for (let i = 0; i < count; i++) prop.value.push(r.readFString());
  } else if (innerType === 'IntProperty') {
    prop.value = [];
    for (let i = 0; i < count; i++) prop.value.push(r.readI32());
  } else if (innerType === 'FloatProperty') {
    prop.value = [];
    for (let i = 0; i < count; i++) prop.value.push(r.readF32());
  } else if (innerType === 'BoolProperty') {
    prop.value = [];
    for (let i = 0; i < count; i++) prop.value.push(r.readBool());
  } else if (innerType === 'ByteProperty') {
    prop.value = [];
    for (let i = 0; i < count; i++) prop.value.push(r.readU8());
  } else if (innerType === 'EnumProperty') {
    prop.value = [];
    for (let i = 0; i < count; i++) prop.value.push(r.readFString());
  } else if (innerType === 'UInt32Property') {
    prop.value = [];
    for (let i = 0; i < count; i++) prop.value.push(r.readU32());
  } else {
    // Unknown inner type — skip the data
    r.setOffset(afterSep + dataSize);
    prop.value = `<unknown ${innerType}>`;
  }
}

// ─── Inventory slot parsing ────────────────────────────────────────────────

function _parseInventorySlots(r, count) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const slotProps = [];
    let child;
    while ((child = readProperty(r)) !== null) slotProps.push(child);

    let itemName = null, amount = 0, durability = 0;
    for (const sp of slotProps) {
      if (sp.name === 'Item' && sp.children) {
        for (const c of sp.children) {
          if (c.name === 'RowName') itemName = c.value;
        }
      }
      if (sp.name === 'Amount') amount = sp.value || 0;
      if (sp.name === 'Durability') durability = sp.value || 0;
    }

    if (itemName && itemName !== 'None') {
      items.push({
        item: itemName,
        amount,
        durability: Math.round(durability * 10) / 10,
      });
    }
  }
  return items;
}

// ─── Map property ──────────────────────────────────────────────────────────

function _readMapProperty(r, prop, dataSize, cname) {
  const keyType = r.readFString();
  const valType = r.readFString();
  r.readU8();
  const afterSep = r.getOffset();
  prop.keyType = keyType;
  prop.valType = valType;

  if (MAP_CAPTURE.has(cname)) {
    r.readI32(); // removedCount
    const count = r.readI32();
    const entries = {};
    for (let i = 0; i < count; i++) {
      let key;
      if (keyType === 'StrProperty' || keyType === 'NameProperty') key = r.readFString();
      else if (keyType === 'IntProperty') key = r.readI32();
      else if (keyType === 'EnumProperty') key = r.readFString();
      else { r.setOffset(afterSep + dataSize); prop.value = null; return; }

      let val;
      if (valType === 'FloatProperty') val = r.readF32();
      else if (valType === 'IntProperty') val = r.readI32();
      else if (valType === 'StrProperty') val = r.readFString();
      else if (valType === 'BoolProperty') val = r.readBool();
      else { r.setOffset(afterSep + dataSize); prop.value = null; return; }

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
 * @param {object} r - Reader
 * @param {number} startPos - Position where we got stuck
 * @param {number} [maxScan=50000] - Max bytes to scan forward
 * @returns {boolean} true if a valid offset was found and reader repositioned
 */
function recoverForward(r, startPos, maxScan = 50000) {
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

module.exports = {
  createReader,
  cleanName,
  parseHeader,
  readProperty,
  recoverForward,
  MAP_CAPTURE,
};
