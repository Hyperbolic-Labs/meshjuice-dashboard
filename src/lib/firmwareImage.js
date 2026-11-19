/*
  Firmware image files for the DFU tab: raw .bin (written at the start of flash) or Intel
  .hex (addresses taken from the file). CubeIDE writes these when "Convert to binary/Intel Hex
  file" is enabled in the project's post-build settings.
*/

export const FLASH_BASE = 0x08000000;
export const FLASH_SIZE = 128 * 1024;          // STM32L072RB
const RAM_BASE = 0x20000000;
const RAM_SIZE = 20 * 1024;
const FLASH_ERASED = 0x00;                     // STM32L0 flash reads 0x00 when erased

const hex = (value) => `0x${value.toString(16).toUpperCase().padStart(8, '0')}`;

/** Intel HEX -> [{ address, data }] (contiguous runs, sorted). */
export function parseIntelHex(text) {
  const bytes = new Map();
  let base = 0;
  let sawEof = false;
  const lines = text.split(/\r?\n/);
  for (let lineNumber = 0; lineNumber < lines.length && !sawEof; lineNumber += 1) {
    const line = lines[lineNumber].trim();
    if (!line) {
      continue;
    }
    if (!/^:([0-9A-Fa-f]{2})+$/.test(line)) {
      throw new Error(`Line ${lineNumber + 1} is not an Intel HEX record.`);
    }
    const record = line.slice(1).match(/../g).map((pair) => parseInt(pair, 16));
    const count = record[0];
    if (record.length !== count + 5) {
      throw new Error(`Line ${lineNumber + 1} has the wrong length.`);
    }
    if (record.reduce((sum, byte) => sum + byte, 0) & 0xff) {
      throw new Error(`Line ${lineNumber + 1} has a bad checksum.`);
    }
    const offset = (record[1] << 8) | record[2];
    const type = record[3];
    const data = record.slice(4, 4 + count);
    switch (type) {
      case 0x00:
        data.forEach((byte, index) => bytes.set(base + offset + index, byte));
        break;
      case 0x01:
        sawEof = true;
        break;
      case 0x02:
        base = ((data[0] << 8) | data[1]) * 16;
        break;
      case 0x04:
        base = ((data[0] << 24) | (data[1] << 16)) >>> 0;
        break;
      case 0x03:
      case 0x05:
        break;      // start address: the bootloader is told where to jump separately
      default:
        throw new Error(`Line ${lineNumber + 1} has unknown record type ${type}.`);
    }
  }
  if (!sawEof) {
    throw new Error('The HEX file has no end-of-file record (truncated?).');
  }
  if (!bytes.size) {
    throw new Error('The HEX file contains no data.');
  }

  const addresses = [...bytes.keys()].sort((a, b) => a - b);
  const segments = [];
  let start = addresses[0];
  let previous = start;
  const flush = (end) => {
    const data = new Uint8Array(end - start + 1);
    for (let index = 0; index < data.length; index += 1) {
      data[index] = bytes.get(start + index);
    }
    segments.push({ address: start, data });
  };
  for (const address of addresses.slice(1)) {
    if (address !== previous + 1) {
      flush(previous);
      start = address;
    }
    previous = address;
  }
  flush(previous);
  return segments;
}

/**
 * Read a .bin or .hex file. Returns { name, segments, size, start, end, warnings }.
 * Throws when the file can't be what the MeshJuice runs.
 */
export async function loadFirmwareFile(file) {
  const name = file.name;
  let segments;
  if (/\.(hex|ihex|ihx)$/i.test(name)) {
    segments = parseIntelHex(await file.text());
  } else if (/\.bin$/i.test(name)) {
    const data = new Uint8Array(await file.arrayBuffer());
    if (!data.length) {
      throw new Error(`${name} is empty.`);
    }
    segments = [{ address: FLASH_BASE, data }];
  } else {
    throw new Error('Choose a .bin or .hex firmware file (the .elf can\'t be flashed directly).');
  }

  const start = segments[0].address;
  const last = segments[segments.length - 1];
  const end = last.address + last.data.length;
  const size = segments.reduce((sum, segment) => sum + segment.data.length, 0);

  if (start < FLASH_BASE || end > FLASH_BASE + FLASH_SIZE) {
    throw new Error(`${name} covers ${hex(start)}–${hex(end - 1)}, outside the STM32L072's flash (${hex(FLASH_BASE)}–${hex(FLASH_BASE + FLASH_SIZE - 1)}).`);
  }
  if (start !== FLASH_BASE) {
    throw new Error(`${name} starts at ${hex(start)}; MeshJuice firmware starts at ${hex(FLASH_BASE)}.`);
  }

  // The vector table: initial stack pointer in RAM, reset handler in flash (Thumb)
  const head = segments[0].data;
  if (head.length < 8) {
    throw new Error(`${name} is too short to be firmware.`);
  }
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const stack = view.getUint32(0, true);
  const reset = view.getUint32(4, true);
  if (stack < RAM_BASE || stack > RAM_BASE + RAM_SIZE || !(reset & 1) || reset < FLASH_BASE || reset >= FLASH_BASE + FLASH_SIZE) {
    throw new Error(`${name} doesn't start with an STM32L072 vector table (stack ${hex(stack)}, reset ${hex(reset)}). Is it the right file?`);
  }

  return { name, segments, size, start, end };
}

/**
 * Pad each segment out to whole flash pages (with the erased value) and merge segments that
 * share a page, so every write covers pages that were erased for it.
 */
export function toPageBlocks(segments, pageSize) {
  const pages = new Map();
  for (const { address, data } of segments) {
    for (let index = 0; index < data.length; index += 1) {
      const absolute = address + index;
      const pageAddress = absolute - (absolute % pageSize);
      let page = pages.get(pageAddress);
      if (!page) {
        page = new Uint8Array(pageSize).fill(FLASH_ERASED);
        pages.set(pageAddress, page);
      }
      page[absolute - pageAddress] = data[index];
    }
  }

  const blocks = [];
  for (const pageAddress of [...pages.keys()].sort((a, b) => a - b)) {
    const previous = blocks[blocks.length - 1];
    if (previous && previous.address + previous.pages.length * pageSize === pageAddress) {
      previous.pages.push(pages.get(pageAddress));
    } else {
      blocks.push({ address: pageAddress, pages: [pages.get(pageAddress)] });
    }
  }
  return blocks.map(({ address, pages: list }) => {
    const data = new Uint8Array(list.length * pageSize);
    list.forEach((page, index) => data.set(page, index * pageSize));
    return { address, data };
  });
}

export function formatAddress(value) {
  return hex(value);
}
