/*
  Chart helpers for the `history` command's hourly records
  ({ date, vin, vbat, ichg, idsc, temp }, oldest first; see Device.powerHistory).
*/

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The firmware keeps 168 hourly records (PowerHistory::HOURS). */
export const POWER_LOG_HOURS = 168;

/** Columns of the `history` table; precision matches what the firmware prints. */
export const Y_METRICS = [
  { key: 'vin', label: 'Input Voltage', unit: 'V', precision: 1 },
  { key: 'vbat', label: 'Battery Voltage', unit: 'V', precision: 3 },
  { key: 'ichg', label: 'Charge Current', unit: 'mA', precision: 0 },
  { key: 'idsc', label: 'Discharge Current', unit: 'mA', precision: 0 },
  { key: 'temp', label: 'Battery Temperature', unit: '°C', precision: 0 }
];

export function formatHourLabel(date) {
  if (!(date instanceof Date)) {
    return '';
  }
  const hour = date.getHours();
  const period = hour >= 12 ? 'PM' : 'AM';
  return `${DAY_NAMES[date.getDay()]} ${hour % 12 || 12}${period}`;
}

export function formatFullLabel(date) {
  if (!(date instanceof Date)) {
    return '';
  }
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${String(date.getHours()).padStart(2, '0')}:00`;
}

export function getMetricValues(entries, metricKey) {
  return entries.map((entry) => Number(entry[metricKey] ?? 0));
}

export function getYRange(values) {
  if (!values.length) {
    return [0, 1];
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    return [min - pad, max + pad];
  }
  const pad = (max - min) * 0.08;
  // Don't dip below zero for quantities that never go negative (voltages, currents)
  return [min >= 0 ? Math.max(0, min - pad) : min - pad, max + pad];
}

export function formatAxisValue(value, precision = 2) {
  return Number(value).toFixed(precision);
}

/** CSV of the records, oldest first. */
export function toCsv(entries) {
  const header = 'time,vin_V,vbat_V,ichg_mA,idsc_mA,temp_C';
  const rows = entries.map((entry) => {
    const time = entry.date instanceof Date ? entry.date.toISOString() : '';
    return [time, entry.vin, entry.vbat, entry.ichg, entry.idsc, entry.temp].join(',');
  });
  return [header, ...rows].join('\n');
}
