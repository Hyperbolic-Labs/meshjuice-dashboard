/*
  Display formatting only. Values are the strings the firmware prints; nothing here changes
  what is sent back to the device.
*/

export function formatDuration(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total)) {
    return String(seconds);
  }
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const hms = `${hours}h ${minutes}m ${secs}s`;
  return days ? `${days}d ${hms}` : hms;
}

/** "-12.46", 0 -> "-12"; "-0.4", 0 -> "0". Non-numbers, or no `decimals`, pass through. */
export function roundValue(value, decimals) {
  const number = Number(value);
  if (decimals === undefined || value === '' || value === null || !Number.isFinite(number)) {
    return value;
  }
  const rounded = Number(number.toFixed(decimals));
  return (rounded === 0 ? 0 : rounded).toFixed(decimals);     // no "-0"
}

/**
 * "3.312" + "V" -> "3.312 V"; durations become "0h 15m 0s"; missing values become "—".
 * `decimals` rounds numbers for display.
 */
export function formatValue(value, unit = '', decimals = undefined) {
  if (value === undefined || value === null || value === '') {
    return '—';
  }
  if (unit === 'duration') {
    return formatDuration(value);
  }
  const shown = roundValue(value, decimals);
  return unit ? `${shown} ${unit}` : String(shown);
}

/** Unit shown next to the raw value while editing (durations are edited in seconds). */
export function editUnit(unit) {
  return unit === 'duration' ? 's' : unit;
}

/** "-12.5" -> 'negative', "12.5" -> 'positive', "0.0" -> '' */
export function signClass(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) {
    return '';
  }
  return number > 0 ? 'positive' : 'negative';
}

/** Local time as the `time` command expects it: "2026-02-19 10:24:51" */
export function deviceTimeString(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
