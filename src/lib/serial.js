/*
  Web Serial transport for the MeshJuice CLI.

  One reader runs for the whole connection. Everything the device sends is appended to the
  receive buffer of whichever transaction is active, and also reported to `onRx` so the
  terminal can show it.

  Commands run as exclusive transactions (see `run`). The CLI has no request IDs and no
  prompt, so only one conversation may be in flight at a time. A transaction clears the
  receive buffer, writes, and waits for the text it expects.
*/

const encoder = new TextEncoder();

/*
  The firmware's USART1 runs at 115200 baud (Core/Src/usart.c). USB CDC ignores the baud rate,
  so the same setting works for both connections.
*/
export const BAUD_RATE = 115200;

export class SerialTimeoutError extends Error {
  constructor(message = 'The device did not answer in time.') {
    super(message);
    this.name = 'SerialTimeoutError';
  }
}

export class DisconnectedError extends Error {
  constructor(message = 'Not connected to a device.') {
    super(message);
    this.name = 'DisconnectedError';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class SerialLink {
  /**
   * @param {object} handlers
   * @param {(text: string, owner: string | null) => void} [handlers.onRx]   every received chunk
   * @param {(text: string, owner: string | null) => void} [handlers.onTx]   every written chunk
   * @param {(connected: boolean) => void} [handlers.onConnectionChange]
   * @param {() => void} [handlers.onBusyChange]
   */
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.port = null;
    this.portInfo = null;
    this.writer = null;
    this.reader = null;
    this.closing = false;

    this.rx = '';
    this.lastRxAt = 0;
    this.waiters = new Set();

    this.queue = Promise.resolve();
    this.pending = 0;
    this.owner = null;
  }

  get connected() {
    return this.port !== null;
  }

  /** True while a transaction is running or waiting to run. */
  get busy() {
    return this.pending > 0;
  }

  static get supported() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  async connect() {
    if (!SerialLink.supported) {
      throw new Error('Web Serial is not supported in this browser. Use Chrome or Edge.');
    }
    const port = await navigator.serial.requestPort();
    await this.open(port);
  }

  async open(port) {
    await port.open({ baudRate: BAUD_RATE });
    this.port = port;
    this.portInfo = port.getInfo?.() ?? null;
    this.writer = port.writable.getWriter();
    this.closing = false;
    this.rx = '';
    this.readLoop(port);
    this.handlers.onConnectionChange?.(true);
  }

  async disconnect() {
    if (!this.port) {
      return;
    }
    this.closing = true;
    await this.teardown();
  }

  async readLoop(port) {
    const decoder = new TextDecoder();
    const reader = port.readable.getReader();
    this.reader = reader;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        const text = decoder.decode(value, { stream: true });
        if (text) {
          this.receive(text);
        }
      }
    } catch (error) {
      // The device went away (unplugged, rebooted) or the port was closed
    } finally {
      try {
        reader.releaseLock();
      } catch (error) {
        // already released
      }
    }

    if (this.port === port) {
      await this.teardown();
    }
  }

  async teardown() {
    const port = this.port;
    const reader = this.reader;
    const writer = this.writer;

    this.port = null;
    this.reader = null;
    this.writer = null;

    for (const waiter of [...this.waiters]) {
      waiter.fail(new DisconnectedError('The device disconnected.'));
    }

    try {
      await reader?.cancel();
    } catch (error) {
      // ignore
    }
    try {
      writer?.releaseLock();
    } catch (error) {
      // ignore
    }
    try {
      await port?.close();
    } catch (error) {
      // ignore: the port may already be gone
    }

    if (port) {
      this.handlers.onConnectionChange?.(false);
    }
  }

  receive(text) {
    this.rx += text;
    this.lastRxAt = Date.now();
    this.handlers.onRx?.(text, this.owner);
    for (const waiter of [...this.waiters]) {
      waiter.check();
    }
  }

  /** Write immediately, outside any transaction (used for Ctrl-C). */
  async writeRaw(text, owner = 'terminal') {
    if (!this.writer) {
      throw new DisconnectedError();
    }
    this.handlers.onTx?.(text, owner);
    await this.writer.write(encoder.encode(text));
  }

  /**
   * Run `fn(txn)` with exclusive use of the link. Transactions run one at a time, in the
   * order they were requested. `owner` labels the traffic for the terminal view.
   */
  run(owner, fn) {
    this.pending += 1;
    this.handlers.onBusyChange?.();

    const job = this.queue.then(async () => {
      if (!this.port) {
        throw new DisconnectedError();
      }
      this.owner = owner;
      this.rx = '';
      this.lastRxAt = Date.now();
      try {
        return await fn(this.transaction(owner));
      } finally {
        this.owner = null;
      }
    });

    const settle = () => {
      this.pending -= 1;
      this.handlers.onBusyChange?.();
    };
    this.queue = job.then(settle, settle);
    return job;
  }

  transaction(owner) {
    const link = this;
    return {
      /** Text received since the transaction started. */
      get rx() {
        return link.rx;
      },

      async write(text) {
        if (!link.writer) {
          throw new DisconnectedError();
        }
        link.handlers.onTx?.(text, owner);
        await link.writer.write(encoder.encode(text));
      },

      /**
       * Resolve with `predicate(rx)` once it returns something other than null/undefined/false.
       */
      until(predicate, timeoutMs) {
        return link.waitFor(predicate, timeoutMs);
      },

      /**
       * Resolve with the received text once `isDone(rx)` is true, or once nothing has arrived
       * for `quietMs` after the first data, or after `maxMs` in total.
       */
      async collect({ isDone = () => false, quietMs = 500, maxMs = 5000, firstByteMs = 2000 } = {}) {
        const started = Date.now();
        while (true) {
          if (!link.port) {
            throw new DisconnectedError('The device disconnected.');
          }
          const rx = link.rx;
          if (isDone(rx)) {
            return rx;
          }
          const now = Date.now();
          if (rx.length === 0 && now - started > firstByteMs) {
            throw new SerialTimeoutError();
          }
          if (rx.length > 0 && now - link.lastRxAt >= quietMs) {
            return rx;
          }
          if (now - started >= maxMs) {
            return rx;
          }
          await sleep(25);
        }
      }
    };
  }

  waitFor(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const waiter = {
        check: () => {
          let result;
          try {
            result = predicate(this.rx);
          } catch (error) {
            waiter.fail(error);
            return;
          }
          if (result !== null && result !== undefined && result !== false) {
            cleanup();
            resolve(result);
          }
        },
        fail: (error) => {
          cleanup();
          reject(error);
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
      };

      if (!this.port) {
        reject(new DisconnectedError());
        return;
      }
      this.waiters.add(waiter);
      timer = setTimeout(() => waiter.fail(new SerialTimeoutError()), timeoutMs);
      waiter.check();
    });
  }

  /**
   * After a reboot the USB CDC port drops and re-enumerates. Wait for it to go away, then
   * reopen the same device. Returns true when connected again.
   */
  async reconnectAfterReset({ dropWaitMs = 3000, timeoutMs = 20000 } = {}) {
    const info = this.portInfo;
    const dropDeadline = Date.now() + dropWaitMs;
    while (this.port && Date.now() < dropDeadline) {
      await sleep(100);
    }

    if (this.port) {
      // The link survived the reset (e.g. a UART adapter): give the firmware time to boot
      await sleep(1500);
      return true;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(500);
      const ports = await navigator.serial.getPorts();
      const match = ports.find((candidate) => {
        const candidateInfo = candidate.getInfo?.() ?? {};
        return !info || (candidateInfo.usbVendorId === info.usbVendorId && candidateInfo.usbProductId === info.usbProductId);
      });
      if (!match) {
        continue;
      }
      try {
        await this.open(match);
        await sleep(300);
        return true;
      } catch (error) {
        // Not ready yet; keep trying
      }
    }
    return false;
  }
}
