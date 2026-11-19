/*
  MeshJuice CLI commands, one method per firmware command. The firmware does the work
  (parsing, range checks, cross-field validation, formatting); this file only builds
  command lines and splits up the replies.

  How the CLI answers (see Core/CLI in the firmware):
    - A command line is echoed back, followed by "\r\n", then the command's output.
    - get/default/min/max/step/options/valid print one line ending in "\n".
    - A line starting with "{" is a JSON object of assignments. It is echoed as it is
      parsed, `invalid: <key>` is printed for each rejected pair, then "OK" or "FAIL".
    - The firmware's receive buffer is 256 bytes and a command line holds 63 characters,
      so batches are split into small writes.
*/

import { DisconnectedError, SerialTimeoutError } from './serial.js';

const MAX_LINE = 63;            // StringBuffer<63> in CommandProcessor.h
const MAX_BATCH_BYTES = 192;    // stays well inside the 256 byte receive FIFO
const MAX_JSON_BYTES = 180;
const MAX_JSON_TOKEN = 31;      // json::ObjectParser::MAX_LEN

/** Characters the CLI can carry: printable ASCII only (anything else is dropped by the firmware). */
export function transportProblem(value, { allowSpaces = true } = {}) {
  if (/[^\x20-\x7e]/.test(value)) {
    return 'Only plain ASCII characters can be sent to the device.';
  }
  if (!allowSpaces && /\s/.test(value)) {
    return 'Value cannot contain spaces.';
  }
  return null;
}

function chunkLines(lines, maxBytes) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const line of lines) {
    const bytes = line.length + 1;
    if (current.length && size + bytes > maxBytes) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += bytes;
  }
  if (current.length) {
    chunks.push(current);
  }
  return chunks;
}

/**
 * Split the reply to a batch of single-line commands. Returns null until every command's
 * echo and output line has arrived.
 */
function parseBatch(rx, lines) {
  const results = [];
  let cursor = 0;
  for (const line of lines) {
    const echo = `${line}\r\n`;
    const echoAt = rx.indexOf(echo, cursor);
    if (echoAt < 0) {
      return null;
    }
    const start = echoAt + echo.length;
    const end = rx.indexOf('\n', start);
    if (end < 0) {
      return null;
    }
    results.push(rx.slice(start, end).replace(/\r$/, ''));
    cursor = end + 1;
  }
  return results;
}

/** Output of a single command line: everything after its echo, or null before the echo arrives. */
function outputAfterEcho(rx, line) {
  const echo = `${line}\r\n`;
  const at = rx.indexOf(echo);
  return at < 0 ? null : rx.slice(at + echo.length);
}

function unknownCommand(output) {
  const match = /^Unknown command: `([^`]*)`/.exec(output);
  return match ? match[1] : null;
}

/**
 * True when the firmware rejected a command name we didn't send, i.e. stray bytes in its
 * line buffer were prepended to our command. (A genuinely missing command, such as `min` on
 * old firmware, comes back with the name we sent and is reported by the caller instead.)
 */
function isGarbled(output, command) {
  const rejected = unknownCommand(output);
  return rejected !== null && rejected !== command.split(' ')[0];
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** "FEB 19 10:24" -> Date in the most recent year that doesn't put it in the future. */
function dateFromLog(monthName, day, hour, minute = 0, second = 0, now = new Date()) {
  const month = MONTHS.indexOf(monthName);
  if (month < 0) {
    return null;
  }
  let date = new Date(now.getFullYear(), month, day, hour, minute, second);
  if (date.getTime() - now.getTime() > 24 * 3600 * 1000) {
    date = new Date(now.getFullYear() - 1, month, day, hour, minute, second);
  }
  return date;
}

export class Device {
  /** @param {import('./serial.js').SerialLink} link */
  constructor(link) {
    this.link = link;
  }

  /* ------------------------------------------------------------------ helpers */

  /**
   * Empty the firmware's command-line buffer. Stray bytes (UART noise, an adapter being
   * plugged in, bytes sent at the wrong baud rate) sit in that buffer and get glued onto the
   * next command, e.g. "7wJ{get bat_chem" -> "Unknown command". The CLI treats DEL as
   * backspace, so one DEL per buffer slot erases whatever is there and does nothing when it
   * is already empty. ESC (with `abort`) also leaves JSON input mode, but it aborts a
   * running command too, so it's only sent when connecting.
   */
  async clearLine(txn, { abort = false } = {}) {
    await txn.write(`${abort ? '\x1b' : ''}${'\x7f'.repeat(MAX_LINE + 1)}`);
    // Wait for any "\b \b" echoes to finish so they don't mix with the next reply
    await txn.collect({ quietMs: 250, maxMs: 2000, firstByteMs: 400 }).catch(() => {});
  }

  /** Clear the firmware's line buffer; call after connecting or rebooting. */
  resync() {
    return this.link.run('dashboard', (txn) => this.clearLine(txn, { abort: true }));
  }

  /** Run single-line commands in as few writes as possible; returns one output line each. */
  // A full batch and its reply is ~0.5 KB (~50 ms at 115200 baud); generous for slow links
  async lines(commands, { owner = 'dashboard', timeoutMs = 4000 } = {}) {
    for (const command of commands) {
      if (command.length > MAX_LINE) {
        throw new Error(`Command too long for the device CLI: ${command}`);
      }
    }

    const runChunk = async (txn, chunk) => {
      const start = txn.rx.length;
      await txn.write(chunk.map((line) => `${line}\n`).join(''));
      return txn.until((rx) => parseBatch(rx.slice(start), chunk), timeoutMs);
    };

    return this.link.run(owner, async (txn) => {
      const results = [];
      for (const chunk of chunkLines(commands, MAX_BATCH_BYTES)) {
        let outputs;
        try {
          outputs = await runChunk(txn, chunk);
        } catch (error) {
          if (!(error instanceof SerialTimeoutError)) {
            throw error;
          }
          outputs = null;     // maybe stray bytes put the CLI in JSON mode; clear and retry once
        }

        if (!outputs || outputs.some((output, index) => isGarbled(output, chunk[index]))) {
          await this.clearLine(txn);
          outputs = await runChunk(txn, chunk);
          const bad = outputs.findIndex((output, index) => isGarbled(output, chunk[index]));
          if (bad >= 0) {
            throw new Error(`The device received a corrupted command (${outputs[bad]}). Check the serial connection.`);
          }
        }
        results.push(...outputs);
      }
      return results;
    });
  }

  async line(command, options) {
    const [output] = await this.lines([command], options);
    const missing = unknownCommand(output);
    if (missing) {
      throw new Error(`The firmware has no \`${missing}\` command. Update the firmware.`);
    }
    return output;
  }

  /** Run one command whose output is several lines and ends when `isDone` says so (or goes quiet). */
  async collect(command, { isDone = () => false, quietMs = 600, maxMs = 10000, owner = 'dashboard' } = {}) {
    return this.link.run(owner, async (txn) => {
      await txn.write(`${command}\n`);
      const rx = await txn.collect({
        isDone: (text) => {
          const output = outputAfterEcho(text, command);
          return output !== null && isDone(output);
        },
        quietMs,
        maxMs
      });
      const output = outputAfterEcho(rx, command);
      if (output === null) {
        throw new SerialTimeoutError();
      }
      const missing = unknownCommand(output);
      if (missing) {
        throw new Error(`The firmware has no \`${missing}\` command.`);
      }
      return output;
    });
  }

  /* ------------------------------------------------------------------ values */

  /** `get` for each key. Returns { key: value }; unknown keys come back as ''. */
  async getMany(keys, options) {
    const outputs = await this.lines(keys.map((key) => `get ${key}`), options);
    return Object.fromEntries(keys.map((key, index) => [key, outputs[index]]));
  }

  /**
   * Everything the edit dialog shows, straight from the firmware:
   *   get / default / min / max / step / options
   */
  async fieldInfo(key) {
    const commands = ['get', 'default', 'min', 'max', 'step', 'options'].map((command) => `${command} ${key}`);
    const outputs = await this.lines(commands);

    outputs.forEach((output) => {
      const missing = unknownCommand(output);
      if (missing) {
        throw new Error(`The firmware has no \`${missing}\` command. Flash firmware with min/max/step/options support.`);
      }
    });

    const [current, defaultValue, min, max, step, options] = outputs;
    return {
      current,
      default: defaultValue,
      min,
      max,
      step,
      options: options ? options.split(',') : []
    };
  }

  /**
   * `valid <key> <value>`: true if the firmware would accept it. The CLI splits arguments on
   * spaces, so values containing spaces can't be checked this way; returns null for those
   * (they are still validated by the firmware when applied, see `assign`).
   */
  async valid(key, value) {
    if (value === '' || /\s/.test(value)) {
      return value === '' ? false : null;
    }
    const output = await this.line(`valid ${key} ${value}`);
    return output.trim() === 'OK';
  }

  /**
   * Assign values with the firmware's JSON line, which validates each pair exactly like
   * `assign` and accepts values with spaces. Returns the keys the firmware rejected.
   */
  async assign(values, { owner = 'dashboard' } = {}) {
    const entries = Object.entries(values).map(([key, value]) => [key, String(value)]);
    for (const [key, value] of entries) {
      if (key.length > MAX_JSON_TOKEN || value.length > MAX_JSON_TOKEN) {
        throw new Error(`"${key}" is too long for the device (31 characters max).`);
      }
      const problem = transportProblem(value) ?? (value.includes('"') || value.includes('\\') ? 'Value cannot contain quotes or backslashes.' : null);
      if (problem) {
        throw new Error(`${key}: ${problem}`);
      }
    }

    // Several small objects, so each one fits in the firmware's receive buffer
    const chunks = [];
    let current = [];
    for (const entry of entries) {
      const candidate = [...current, entry];
      if (current.length && JSON.stringify(Object.fromEntries(candidate)).length > MAX_JSON_BYTES) {
        chunks.push(current);
        current = [entry];
      } else {
        current = candidate;
      }
    }
    if (current.length) {
      chunks.push(current);
    }

    const rejected = [];
    for (const chunk of chunks) {
      const json = JSON.stringify(Object.fromEntries(chunk));
      const output = await this.link.run(owner, async (txn) => {
        await txn.write(json);
        return txn.until((rx) => (/(?:^|[}\n])(OK|FAIL)\n/.test(rx) ? rx : null), 3000);
      });
      for (const match of output.matchAll(/invalid: ([^\r\n]+)\n/g)) {
        rejected.push(match[1]);
      }
      if (/FAIL\n/.test(output) && !/invalid: /.test(output)) {
        throw new Error('The device rejected the JSON assignment.');
      }
    }
    return { ok: rejected.length === 0, rejected };
  }

  /* ------------------------------------------------------------------ persistence / power */

  /** `save`: writes config to EEPROM. Prints dots while writing, then OK. */
  async save() {
    const output = await this.collect('save', {
      isDone: (text) => /(OK|FAIL)\n/.test(text),
      quietMs: 8000,
      maxMs: 8000
    });
    if (!/OK\n/.test(output)) {
      throw new Error('The device did not confirm the save.');
    }
  }

  async reboot() {
    await this.resetWith('reboot');
  }

  /** `erase`: wipes config, power history and event log, then resets. */
  async erase() {
    await this.resetWith('erase');
  }

  /**
   * `dfu`: reset into the STM32 ROM bootloader (USB DFU). No reply on success: the USB serial
   * port drops. Over a UART adapter the link stays up, so silence counts as success too.
   * Afterwards the link is closed either way.
   */
  async enterDfu() {
    const output = await this.link.run('dashboard', async (txn) => {
      await txn.write('dfu\n');
      try {
        return await txn.until((rx) => {
          const text = outputAfterEcho(rx, 'dfu');
          return text !== null && text.includes('\n') ? text : null;
        }, 3000);
      } catch (error) {
        if (error instanceof DisconnectedError || error instanceof SerialTimeoutError) {
          return null;
        }
        throw error;
      }
    });

    if (output !== null) {
      if (unknownCommand(output)) {
        throw new Error('This firmware has no `dfu` command. Enter DFU mode by holding PKEY while resetting the board.');
      }
      if (/FAIL/.test(output)) {
        throw new Error('The device refused: the configuration lock input is active.');
      }
    }
    await this.link.disconnect();
  }

  async resetWith(command) {
    await this.link.run('dashboard', (txn) => txn.write(`${command}\n`));
    const back = await this.link.reconnectAfterReset();
    if (!back) {
      throw new Error('The device reset but could not be reopened. Click Connect.');
    }
    await this.resync();    // boot noise on the UART can leave bytes in the line buffer
  }

  /* ------------------------------------------------------------------ clock */

  /** `time`: "2026-02-19 10:24:51" */
  async time() {
    return (await this.line('time')).trim();
  }

  /** `time YYYY-MM-DD HH:MM:SS`: returns true if the firmware accepted it. */
  async setTime(text) {
    const output = await this.line(`time ${text.trim()}`);
    return output.trim() === 'OK';
  }

  /* ------------------------------------------------------------------ control */

  /** `chg on|off` */
  async setCharging(allow) {
    const output = await this.collect(`chg ${allow ? 'on' : 'off'}`, {
      isDone: (text) => /(OK|FAIL)\n/.test(text),
      maxMs: 3000
    });
    if (!/OK\n/.test(output)) {
      throw new Error(output.replace(/FAIL\n?/, '').trim() || 'The device refused.');
    }
  }

  /** `on [seconds]` / `off`. `on` reports VOUT about a second after switching. */
  async setOutput(on, seconds = 0) {
    const command = on ? (seconds ? `on ${seconds}` : 'on') : 'off';
    const output = await this.collect(command, {
      // `on` goes quiet for ~1 s before its VOUT/VSYS/IDSC report, so don't stop on silence
      isDone: (text) => /FAIL\n|OK\n/.test(text) || /idsc[^\n]*\n/.test(text),
      quietMs: on ? 2500 : 600,
      maxMs: 4000
    });
    if (/FAIL\n/.test(output)) {
      throw new Error(output.replace(/FAIL\n?/, '').trim() || 'The device refused.');
    }
    return output.trim();
  }

  /* ------------------------------------------------------------------ logs */

  /**
   * `log <count>`: newest first, "[FEB 19 10:24:51] ERR_VIN_OV". Returned oldest first.
   */
  async eventLog(count = 1023) {
    const output = await this.collect(`log ${count}`, {
      isDone: (text) => /no events/.test(text) || /usage:/.test(text) || (text.match(/\n/g) ?? []).length >= count,
      quietMs: 700,
      maxMs: 60000      // 1023 events are ~33 KB: ~3 s at 115200 baud, ~35 s at 9600
    });
    if (/usage:/.test(output)) {
      throw new Error(output.trim());
    }

    const now = new Date();
    const events = [];
    for (const match of output.matchAll(/\[([A-Z?]{3}) (\d{2}) (\d{2}):(\d{2}):(\d{2})\] (\S+)/g)) {
      const [, month, day, hour, minute, second, name] = match;
      events.push({
        stamp: `${month} ${day} ${hour}:${minute}:${second}`,
        date: dateFromLog(month, Number(day), Number(hour), Number(minute), Number(second), now),
        name
      });
    }
    return events.reverse();
  }

  /**
   * `history <hours>`: hourly averages, newest first. Returned oldest first, skipping
   * hours with no record.
   */
  async powerHistory(hours = 168) {
    const isRow = /^\s*\d+\s{2}/;
    const output = await this.collect(`history ${hours}`, {
      isDone: (text) => /usage:/.test(text) || text.split('\n').filter((row) => isRow.test(row)).length >= hours,
      quietMs: 700,
      maxMs: 40000      // 168 rows are ~10 KB: ~1 s at 115200 baud, ~11 s at 9600
    });
    if (/usage:/.test(output)) {
      throw new Error(output.trim());
    }

    const now = new Date();
    const rows = [];
    const pattern = /^\s*(\d+)\s+([A-Z?]{3}) (\d{2}) (\d{2}):00\s+([-\d.]+)V\s+([-\d.]+)V\s+(-?\d+)mA\s+(-?\d+)mA\s+(-?\d+)C/;
    for (const row of output.split(/\r?\n/)) {
      const match = pattern.exec(row);
      if (!match) {
        continue;
      }
      const [, hoursAgo, month, day, hour, vin, vbat, ichg, idsc, temp] = match;
      rows.push({
        hoursAgo: Number(hoursAgo),
        date: dateFromLog(month, Number(day), Number(hour), 0, 0, now),
        vin: Number(vin),
        vbat: Number(vbat),
        ichg: Number(ichg),
        idsc: Number(idsc),
        temp: Number(temp)
      });
    }
    return rows.sort((a, b) => b.hoursAgo - a.hoursAgo);
  }

  /** `log clear`: erases the event log. */
  clearEventLog() {
    return this.clearLog('log');
  }

  /** `history clear`: erases the power history. */
  clearPowerHistory() {
    return this.clearLog('history');
  }

  /**
   * `<command> clear`: the firmware erases in the background, printing a dot every 100 ms,
   * then OK (FAIL while the config lock is active). A full event log takes ~8 s.
   */
  async clearLog(command) {
    const output = await this.collect(`${command} clear`, {
      isDone: (text) => /(OK|FAIL)\n/.test(text) || /usage:/.test(text),
      quietMs: 3000,
      maxMs: 30000
    });
    if (/usage:/.test(output)) {
      throw new Error(`This firmware can't clear the ${command === 'log' ? 'event log' : 'power history'}. Update the firmware.`);
    }
    if (/FAIL\n/.test(output)) {
      throw new Error('The device refused: the configuration lock input is active.');
    }
    if (!/OK\n/.test(output)) {
      throw new Error('The device did not confirm the erase.');
    }
  }

  /* ------------------------------------------------------------------ terminal */

  /**
   * Send a line typed in the terminal. Holds the link until the device has been quiet for
   * a moment, so long-running commands (watch, cycletest) aren't interrupted by polling.
   */
  terminal(line) {
    return this.link.run('terminal', async (txn) => {
      await txn.write(`${line}\n`);
      await txn.collect({ quietMs: 1500, maxMs: Number.POSITIVE_INFINITY, firstByteMs: 3000 }).catch(() => {});
    });
  }
}
