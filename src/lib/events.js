/*
  Descriptions of the event log entries printed by the `log` command. Names and meanings
  follow the LogEntry table in the firmware's DeviceDictionary.h; IDs 16-31 are also the
  bits of `fault_flags` (bit n = ID 16 + n).
*/

export const EVENTS = [
  { id: 0, name: 'EVT_CPU_POR', text: 'The CPU started from a power-on reset (power was applied or fully lost).' },
  { id: 1, name: 'EVT_CPU_BOOT', text: 'The CPU booted (any reset).' },
  { id: 2, name: 'EVT_CPU_WAKE', text: 'The CPU woke from sleep.' },
  { id: 3, name: 'EVT_CPU_SLEEP', text: 'The CPU entered sleep.' },
  { id: 4, name: 'EVT_LOAD_ENABLE', text: 'Power to the load / LDO output was turned on.' },
  { id: 5, name: 'EVT_LOAD_DISABLE', text: 'Power to the load / LDO output was turned off.' },
  { id: 6, name: 'EVT_SRC_NONE', text: 'Input power was lost.' },
  { id: 7, name: 'EVT_SRC_PV', text: 'The input source changed to PV (solar).' },
  { id: 8, name: 'EVT_SRC_VAUX', text: 'The input source changed to VAUX.' },
  { id: 9, name: 'EVT_SRC_USB', text: 'The input source changed to USB.' },
  { id: 10, name: 'EVT_MPPT_SWEEP', text: 'An MPPT I-V curve sweep started.' },
  { id: 11, name: 'EVT_PKEY_PRESS', text: 'A power key press was detected.' },
  { id: 12, name: 'EVT_WDT_TRIP', text: 'The output watchdog timer overran.' },
  { id: 13, name: 'EVT_VDD_OFF', text: 'Battery too low with no input power: the 3.3V regulator was turned off and the clock runs from the backup coin cell.' },
  { id: 14, name: 'EVT_VDD_ON', text: 'The 3.3V regulator was turned back on after input power returned or the battery recovered.' },
  { id: 16, name: 'ERR_BOARD_TEMP', text: 'Board temperature exceeded the maximum for charging.' },
  { id: 17, name: 'ERR_VIN_OV', text: 'The maximum input voltage was exceeded.' },
  { id: 18, name: 'ERR_BAT_POL', text: 'Battery voltage is negative (reversed polarity).' },
  { id: 19, name: 'ERR_BAT_OV', text: 'Battery voltage rose above the termination voltage + 100 mV.' },
  { id: 20, name: 'ERR_BAT_DEAD', text: 'The battery has been over-discharged.' },
  { id: 21, name: 'ERR_BAT_OTP', text: 'Battery temperature exceeded the maximum for charging.' },
  { id: 22, name: 'ERR_LOAD_OC', text: 'The output eFuse tripped (overcurrent).' },
  { id: 23, name: 'ERR_NTC_SHORT', text: 'The battery NTC is shorted.' },
  { id: 24, name: 'ERR_NTC_DISC', text: 'The battery NTC is open circuit (disconnected).' },
  { id: 25, name: 'ERR_VDDA_RANGE', text: 'VDDA is out of range.' },
  { id: 26, name: 'ERR_VDAC_RANGE', text: 'The DAC voltage is outside the expected tolerance.' },
  { id: 31, name: 'ERR_INTERNAL', text: 'Unspecified internal error.' }
];

const BY_NAME = Object.fromEntries(EVENTS.map((event) => [event.name, event]));

export function describeEvent(name) {
  return BY_NAME[name]?.text ?? 'No description available for this event.';
}

export function isErrorEvent(name) {
  return name.startsWith('ERR_');
}

/** Names of the faults set in a `fault_flags` value such as "0x0011". */
export function decodeFaultFlags(value) {
  const flags = Number.parseInt(String(value), 16);
  if (!Number.isFinite(flags) || flags === 0) {
    return [];
  }
  return EVENTS.filter((event) => event.id >= 16 && flags & (1 << (event.id - 16))).map((event) => event.name);
}
