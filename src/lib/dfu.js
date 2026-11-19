/*
  WebUSB client for the STM32 ROM bootloader's USB DFU mode (DfuSe, ST's DFU 1.1a extensions).

  The MeshJuice firmware has no DFU code of its own. The `dfu` CLI command (or holding PKEY
  while resetting) starts the STM32L072's system memory bootloader, which enumerates as
  0483:DF11 "STM32 BOOTLOADER" with one alternate setting per memory, each named with its
  layout, e.g. "@Internal Flash  /0x08000000/1024*128 g".

  DfuSe commands are DNLOAD requests to block 0 (USB DFU spec + ST AN3156):
    0x21 addr   set address pointer
    0x41 addr   erase the page containing addr
  Data blocks use wBlockNum >= 2; block n goes to pointer + (n - 2) * transferSize. Every
  DNLOAD is followed by GETSTATUS polling until the state leaves dfuDNBUSY. A zero-length
  DNLOAD followed by GETSTATUS "leaves" DFU: the bootloader jumps to the address pointer.

  WebUSB needs the WinUSB driver on Windows. ST's own DFU driver (installed with
  STM32CubeProgrammer) can't be opened from the browser.
*/

export const STM32_DFU = { vendorId: 0x0483, productId: 0xdf11 };

const REQ = { DETACH: 0, DNLOAD: 1, UPLOAD: 2, GETSTATUS: 3, CLRSTATUS: 4, GETSTATE: 5, ABORT: 6 };

const STATE = {
  appIDLE: 0,
  appDETACH: 1,
  dfuIDLE: 2,
  dfuDNLOAD_SYNC: 3,
  dfuDNBUSY: 4,
  dfuDNLOAD_IDLE: 5,
  dfuMANIFEST_SYNC: 6,
  dfuMANIFEST: 7,
  dfuMANIFEST_WAIT_RESET: 8,
  dfuUPLOAD_IDLE: 9,
  dfuERROR: 10
};

const STATUS_TEXT = [
  'OK',
  'errTARGET: file is not for this device',
  'errFILE: file failed a vendor check',
  'errWRITE: unable to write memory',
  'errERASE: memory erase failed',
  'errCHECK_ERASED: memory erase check failed',
  'errPROG: program memory failed',
  'errVERIFY: programmed memory failed verification',
  'errADDRESS: address out of range',
  'errNOTDONE: unexpected end of data',
  'errFIRMWARE: firmware is corrupt',
  'errVENDOR: vendor error',
  'errUSBR: unexpected USB reset',
  'errPOR: unexpected power-on reset',
  'errUNKNOWN',
  'errSTALLEDPKT: unexpected request (read protection may be active)'
];

const DEFAULT_TRANSFER_SIZE = 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class DfuError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DfuError';
  }
}

export function webUsbSupported() {
  return typeof navigator !== 'undefined' && 'usb' in navigator;
}

/**
 * Parse a DfuSe memory layout string: "@Internal Flash  /0x08000000/0512*128 g,0512*128 g"
 * Returns { name, segments: [{ start, end, pageSize, readable, erasable, writable }] }.
 */
export function parseMemoryLayout(text) {
  const match = /^@([^/]+)\/(0x[0-9a-fA-F]+)\/(.*)$/.exec(text?.trim() ?? '');
  if (!match) {
    return null;
  }
  const name = match[1].trim();
  let address = parseInt(match[2], 16);
  const segments = [];
  for (const sector of match[3].split(',')) {
    const parts = /^\s*(\d+)\s*\*\s*(\d+)\s*([ BKM])\s*([a-g])\s*$/.exec(sector);
    if (!parts) {
      continue;
    }
    const count = parseInt(parts[1], 10);
    const multiplier = { ' ': 1, B: 1, K: 1024, M: 1024 * 1024 }[parts[3]];
    const pageSize = parseInt(parts[2], 10) * multiplier;
    const flags = parts[4].charCodeAt(0) - 'a'.charCodeAt(0) + 1;    // bit 0 read, 1 erase, 2 write
    segments.push({
      start: address,
      end: address + count * pageSize,
      pageSize,
      readable: Boolean(flags & 1),
      erasable: Boolean(flags & 2),
      writable: Boolean(flags & 4)
    });
    address += count * pageSize;
  }
  return { name, segments };
}

export function describeUsbError(error) {
  const text = error instanceof Error ? error.message : String(error);
  if (error?.name === 'SecurityError' || /access denied|unable to claim|failed to open/i.test(text)) {
    return 'The browser could not open the DFU device. On Windows it needs the WinUSB driver: run Zadig, '
      + 'select "STM32 BOOTLOADER" and install WinUSB, then unplug and replug the board. '
      + '(STM32CubeProgrammer\'s driver blocks WebUSB.) Also close any other program using the device.';
  }
  return text;
}

export class DfuDevice {
  /** @param {USBDevice} usb */
  constructor(usb) {
    this.usb = usb;
    this.interfaceNumber = 0;
    this.alternate = 0;
    this.transferSize = DEFAULT_TRANSFER_SIZE;
    this.memory = null;
    this.alternates = [];
  }

  /** Ask the user to pick the bootloader, or reuse one already granted to this page. */
  static async request() {
    const usb = await navigator.usb.requestDevice({ filters: [STM32_DFU] });
    const device = new DfuDevice(usb);
    await device.open();
    return device;
  }

  /** Bootloader devices this page already has permission for (no picker). */
  static async granted() {
    if (!webUsbSupported()) {
      return [];
    }
    const devices = await navigator.usb.getDevices();
    return devices.filter((usb) => usb.vendorId === STM32_DFU.vendorId && usb.productId === STM32_DFU.productId);
  }

  get name() {
    const { productName, serialNumber } = this.usb;
    return `${productName || 'STM32 BOOTLOADER'}${serialNumber ? ` (${serialNumber})` : ''}`;
  }

  async open() {
    try {
      await this.usb.open();
      if (this.usb.configuration === null) {
        await this.usb.selectConfiguration(1);
      }
      this.alternates = this.findAlternates();
      const flash = this.alternates.find((alt) => /flash/i.test(alt.name)) ?? this.alternates[0];
      if (!flash) {
        throw new DfuError('The USB device has no DFU interface. Is it the STM32 bootloader?');
      }
      this.interfaceNumber = flash.interfaceNumber;
      this.alternate = flash.alternate;
      this.memory = parseMemoryLayout(flash.name);
      if (!this.memory?.segments.length) {
        throw new DfuError(`Unrecognised DFU memory description: "${flash.name ?? ''}"`);
      }
      await this.usb.claimInterface(this.interfaceNumber);
      await this.usb.selectAlternateInterface(this.interfaceNumber, this.alternate);
      this.transferSize = (await this.readTransferSize()) ?? DEFAULT_TRANSFER_SIZE;
      await this.toIdle();
    } catch (error) {
      await this.close();
      if (error instanceof DfuError) {
        throw error;
      }
      throw new DfuError(describeUsbError(error));
    }
  }

  async close() {
    try {
      if (this.usb.opened) {
        await this.usb.close();
      }
    } catch (error) {
      // already gone (e.g. after leaving DFU)
    }
  }

  findAlternates() {
    const found = [];
    for (const iface of this.usb.configuration?.interfaces ?? []) {
      for (const alt of iface.alternates) {
        if (alt.interfaceClass === 0xfe && alt.interfaceSubclass === 0x01) {
          found.push({ interfaceNumber: iface.interfaceNumber, alternate: alt.alternateSetting, name: alt.interfaceName });
        }
      }
    }
    return found;
  }

  /** wTransferSize from the DFU functional descriptor (type 0x21) in the configuration descriptor. */
  async readTransferSize() {
    try {
      const request = { requestType: 'standard', recipient: 'device', request: 6, value: 0x0200, index: 0 };
      const head = await this.usb.controlTransferIn(request, 9);
      const total = head.data.getUint16(2, true);
      const result = await this.usb.controlTransferIn(request, total);
      const data = result.data;
      for (let offset = 0; offset + 1 < data.byteLength;) {
        const length = data.getUint8(offset);
        if (length < 2) {
          break;
        }
        if (data.getUint8(offset + 1) === 0x21 && length >= 7) {
          return data.getUint16(offset + 5, true);
        }
        offset += length;
      }
    } catch (error) {
      // fall back to the default
    }
    return null;
  }

  /* ------------------------------------------------------------ DFU requests */

  setup(request, value = 0) {
    return { requestType: 'class', recipient: 'interface', request, value, index: this.interfaceNumber };
  }

  async out(request, value, data = new ArrayBuffer(0)) {
    const result = await this.usb.controlTransferOut(this.setup(request, value), data);
    if (result.status !== 'ok') {
      throw new DfuError(`DFU request ${request} failed (${result.status}).`);
    }
  }

  async getStatus() {
    const result = await this.usb.controlTransferIn(this.setup(REQ.GETSTATUS), 6);
    if (result.status !== 'ok') {
      throw new DfuError(`DFU GETSTATUS failed (${result.status}).`);
    }
    const data = result.data;
    return {
      status: data.getUint8(0),
      pollTimeout: data.getUint8(1) | (data.getUint8(2) << 8) | (data.getUint8(3) << 16),
      state: data.getUint8(4)
    };
  }

  /** Get to dfuIDLE from whatever state a previous session left the bootloader in. */
  async toIdle() {
    let status = await this.getStatus();
    if (status.state === STATE.dfuERROR) {
      await this.out(REQ.CLRSTATUS, 0);
      status = await this.getStatus();
    }
    if (status.state !== STATE.dfuIDLE) {
      await this.out(REQ.ABORT, 0);
      status = await this.getStatus();
    }
    if (status.state !== STATE.dfuIDLE) {
      throw new DfuError(`The bootloader is stuck in DFU state ${status.state}. Reset the board and try again.`);
    }
  }

  /** After a DNLOAD: poll until the operation finishes; throws on a DFU error status. */
  async waitWhileBusy() {
    while (true) {
      const status = await this.getStatus();
      if (status.status !== 0) {
        const text = STATUS_TEXT[status.status] ?? `status ${status.status}`;
        await this.out(REQ.CLRSTATUS, 0).catch(() => {});
        throw new DfuError(`The bootloader reported ${text}.`);
      }
      if (status.state !== STATE.dfuDNBUSY) {
        return status;
      }
      await sleep(status.pollTimeout);
    }
  }

  async command(bytes) {
    await this.out(REQ.DNLOAD, 0, new Uint8Array(bytes));
    await this.waitWhileBusy();
  }

  static addressBytes(address) {
    return [address & 0xff, (address >>> 8) & 0xff, (address >>> 16) & 0xff, (address >>> 24) & 0xff];
  }

  setAddress(address) {
    return this.command([0x21, ...DfuDevice.addressBytes(address)]);
  }

  erasePage(address) {
    return this.command([0x41, ...DfuDevice.addressBytes(address)]);
  }

  /* ------------------------------------------------------------ high-level operations */

  segmentFor(address) {
    return this.memory.segments.find((segment) => address >= segment.start && address < segment.end) ?? null;
  }

  /** Throws unless every block lies in writable flash. */
  checkFits(blocks) {
    for (const block of blocks) {
      const last = block.address + block.data.length - 1;
      const first = this.segmentFor(block.address);
      const end = this.segmentFor(last);
      if (!first || !end || !first.writable || !end.writable) {
        throw new DfuError(
          `The image covers 0x${block.address.toString(16)}–0x${last.toString(16)}, outside the bootloader's `
            + `writable ${this.memory.name}.`
        );
      }
    }
  }

  /**
   * Erase, write and (optionally) verify `blocks` ([{ address, data: Uint8Array }]).
   * `onProgress({ phase, done, total })` is called as it goes.
   */
  async flash(blocks, { verify = true, onProgress = () => {} } = {}) {
    this.checkFits(blocks);

    // Erase every page the image touches
    const pages = [];
    for (const block of blocks) {
      for (let address = block.address; address < block.address + block.data.length;) {
        const segment = this.segmentFor(address);
        const page = address - ((address - segment.start) % segment.pageSize);
        if (pages[pages.length - 1] !== page) {
          pages.push(page);
        }
        address = page + segment.pageSize;
      }
    }
    for (let index = 0; index < pages.length; index += 1) {
      onProgress({ phase: 'Erasing', done: index, total: pages.length });
      await this.erasePage(pages[index]);
    }

    // Write
    const total = blocks.reduce((sum, block) => sum + block.data.length, 0);
    let written = 0;
    for (const block of blocks) {
      for (let offset = 0; offset < block.data.length; offset += this.transferSize) {
        onProgress({ phase: 'Writing', done: written, total });
        const chunk = block.data.subarray(offset, offset + this.transferSize);
        await this.setAddress(block.address + offset);
        await this.out(REQ.DNLOAD, 2, chunk);
        await this.waitWhileBusy();
        written += chunk.length;
      }
    }
    onProgress({ phase: 'Writing', done: total, total });

    if (verify) {
      let checked = 0;
      for (const block of blocks) {
        const readBack = await this.read(block.address, block.data.length, (count) => {
          onProgress({ phase: 'Verifying', done: checked + count, total });
        });
        const mismatch = block.data.findIndex((byte, index) => byte !== readBack[index]);
        if (mismatch >= 0) {
          throw new DfuError(`Verify failed at 0x${(block.address + mismatch).toString(16)}. Flash the image again.`);
        }
        checked += block.data.length;
      }
      onProgress({ phase: 'Verifying', done: total, total });
    }
  }

  /** Read `length` bytes from `address` with UPLOAD. */
  async read(address, length, onProgress = () => {}) {
    await this.setAddress(address);
    await this.out(REQ.ABORT, 0);       // UPLOAD is only accepted from dfuIDLE
    const out = new Uint8Array(length);
    let done = 0;
    for (let block = 2; done < length; block += 1) {
      const want = Math.min(this.transferSize, length - done);
      const result = await this.usb.controlTransferIn(this.setup(REQ.UPLOAD, block), this.transferSize);
      if (result.status !== 'ok') {
        throw new DfuError(`DFU UPLOAD failed (${result.status}). Read protection may be active.`);
      }
      const bytes = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
      out.set(bytes.subarray(0, want), done);
      done += want;
      onProgress(done);
      if (bytes.length < this.transferSize && done < length) {
        throw new DfuError('The bootloader ended the read early.');
      }
    }
    await this.out(REQ.ABORT, 0);
    return out;
  }

  /** Leave DFU and start the firmware at `address`. The device disconnects. */
  async leave(address) {
    await this.toIdle();
    await this.setAddress(address);
    try {
      await this.out(REQ.DNLOAD, 0);
      await this.getStatus();     // triggers the jump; the device usually drops before answering
    } catch (error) {
      // expected: the bootloader resets away
    }
    await this.close();
  }
}
