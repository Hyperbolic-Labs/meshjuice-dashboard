/*
  Where each firmware property appears on the dashboard. Keys are the property names in
  DeviceDictionary.h. Only presentation lives here (label, display unit, position); every
  value, limit, default and option list is read from the device.

  `unit` is the unit of the string the firmware prints, e.g. "mV" properties with 3
  decimals print volts. `duration` values are seconds, shown as h/m/s. An optional `decimals`
  rounds a numeric value for display.
*/

const field = (key, label, unit = '') => ({ key, label, unit });

/** A config row shown only when `when(values)` is true (values: current device values). */
const fieldIf = (when, key, label, unit = '') => ({ ...field(key, label, unit), when });

/** Rows of a config card that apply with the current values. */
export const visibleRows = (rows, values) => rows.filter((row) => !row.when || row.when(values));

/** RTC is edited with the `time` command rather than get/assign. */
export const RTC_FIELD = { key: '__rtc', label: 'RTC Date/Time', unit: '', kind: 'time' };

/* ---------------------------------------------------------------- telemetry */

export const telemetryInput = {
  title: 'INPUT',
  main: field('vin', 'Input Voltage', 'V'),
  rows: [
    field('input_src', 'Source'),
    field('pwr_mode', 'Power Mode'),
    field('vpv', 'PV Voltage', 'V'),
    field('pv_voc', 'PV VOC', 'V'),
    field('pv_vmpp', 'PV VMPP', 'V'),
    field('vusb', 'USB Voltage', 'V'),
    field('vaux', 'AUX Voltage', 'V')
  ]
};

export const telemetryOutput = {
  title: 'OUTPUT',
  main: field('vout', 'Output Voltage', 'V'),
  rows: [
    field('vout_sts', 'Output'),
    field('load_sts', 'Load'),
    field('vout_inh', 'Output Inhibit'),
    field('out_uptime', 'Output Uptime', 'duration'),
    field('vout_tmr_rem', 'Timer Remaining', 'duration')
  ]
};

export const telemetryBattery = {
  title: 'BATTERY',
  main: field('vbat', 'Battery Voltage', 'V'),
  secondary: { ...field('ibat', 'Battery Current', 'mA'), decimals: 0 },     // net current, 1 mA resolution
  rows: [
    field('bat_chem', 'Chemistry'),
    field('chg_sts', 'Charge State'),
    field('chg_inh_src', 'Charge Inhibit'),
    field('chg_lim_src', 'Charge Limit'),
    field('ichg_lim', 'Current Limit', 'mA'),
    field('bat_temp', 'Temperature', '°C'),
    field('ichg', 'Charge Current', 'mA'),
    field('idsc', 'Discharge Current', 'mA'),
    field('pchg', 'Charge Power', 'W')
  ]
};

/** Battery accumulators: rows x columns of firmware keys. */
export const batteryTotals = {
  columns: ['1 Hr', '24 Hr', '1 Hr', '24 Hr'],
  groups: [
    { label: 'Net', keys: [field('mah_1h', '', 'mAh'), field('mah_24h', '', 'mAh'), field('mwh_1h', '', 'mWh'), field('mwh_24h', '', 'Wh')] },
    { label: 'Charged', keys: [field('chg_mah_1h', '', 'mAh'), field('chg_mah_24h', '', 'mAh'), field('chg_mwh_1h', '', 'mWh'), field('chg_mwh_24h', '', 'Wh')] },
    { label: 'Discharged', keys: [field('dsc_mah_1h', '', 'mAh'), field('dsc_mah_24h', '', 'mAh'), field('dsc_mwh_1h', '', 'mWh'), field('dsc_mwh_24h', '', 'Wh')] }
  ]
};

export const telemetrySystem = [
  field('uptime', 'Uptime', 'duration'),
  field('boot_count', 'Boot Count'),
  field('save_count', 'Save Count'),
  field('changes_saved', 'Config'),
  field('boot_flags', 'Boot Flags'),
  field('fault_flags', 'Fault Flags'),
  field('brd_temp', 'Board Temp', '°C'),
  field('vdda', 'VDDA', 'V'),
  field('vsys', 'VSYS', 'V'),
  field('vdac', 'VDAC', 'V'),
  field('fw_version', 'Firmware'),
  field('hw_version', 'Hardware'),
  field('crc', 'Config CRC')
];

/* ---------------------------------------------------------------- config */

export const configCards = [
  {
    title: 'GENERAL',
    rows: [
      field('bat_chem', 'Battery Chemistry'),
      field('leds', 'LEDs'),
      field('i2c', 'I2C Interface'),
      field('pkey', 'Power Key'),
      RTC_FIELD
    ]
  },
  {
    title: 'INPUT',
    rows: [
      field('sweep_rate', 'MPPT Sweep Rate'),
      field('vin_pt_en', 'Min Passthru Voltage', 'V'),
      field('max_pv_iin', 'Max PV Current', 'mA'),
      field('max_usb_iin', 'Max USB Current', 'mA'),
      field('max_aux_iin', 'Max AUX Current', 'mA'),
      field('usb_chg', 'USB Charging'),
      field('aux_chg', 'AUX Charging')
    ]
  },
  {
    title: 'OUTPUT',
    rows: [
      field('vout_set', 'Output Voltage', 'V'),
      field('lv_vout_inh', 'Low Battery Cutoff', 'V'),
      field('lv_vout_en', 'Low Battery Re-enable', 'V')
    ]
  },
  {
    title: 'OUTPUT TIMER',
    rows: [
      field('vout_timer', 'Output Timer'),
      field('vout_on_dur', 'ON Duration', 'duration'),
      field('vout_off_dur', 'OFF Duration', 'duration')
    ]
  },
  /* User GPIO (GPIOManager.h). Output settings show only for outputs, input settings only
     for inputs; option lists come from the device. */
  ...[0, 1].map((n) => {
    const mode = (values) => values[`gpio${n}_mode`];
    const isInput = (values) => mode(values) === 'INPUT';
    const isOutput = (values) => mode(values) === 'OUTPUT';
    const isEnabled = (values) => isInput(values) || isOutput(values);
    return {
      title: `GPIO${n} (PA${n})`,
      rows: [
        field(`gpio${n}_mode`, 'Mode'),
        fieldIf(isEnabled, `gpio${n}_pol`, 'Polarity'),
        fieldIf(isOutput, `gpio${n}_out_fn`, 'Output Function'),
        fieldIf(isOutput, `gpio${n}_drive`, 'Output Drive'),
        fieldIf(isInput, `gpio${n}_in_fn`, 'Input Function'),
        fieldIf(isInput, `gpio${n}_pull`, 'Input Pull')
      ]
    };
  })
  /* The charge current PID settings (kp, ki, kd, int_leak_coef, *_boost, min/max_slewrate)
     are deliberately not shown: they're tuning values, changed from the CLI if needed. */
];

/* Charge profile diagram (figma_charge_profile_page.svg, 1010 x 588). Positions are the
   top-left of each 160 px field, as a percentage of the diagram. */
export const chargeProfileFields = [
  { ...field('bat_chem', 'Battery Chemistry'), left: '0%', top: '1.1%' },
  { ...field('ichg_max', 'Max Charge Current', 'mA'), left: '0%', top: '21.7%' },
  { ...field('max_iprechg', 'Precharge Current', 'mA'), left: '0%', top: '55.7%' },
  { ...field('lv_vout_inh', 'Output Inhibit', 'V'), left: '37.6%', top: '1.1%' },
  { ...field('rechg_lvl', 'Recharge Threshold', 'V'), left: '57.4%', top: '1.1%' },
  { ...field('lv_vout_en', 'Output Re-enable', 'V'), left: '77.2%', top: '1.1%' },
  { ...field('uv_chg_inh', 'UV Charge Cutoff', 'V'), left: '21.8%', top: '89.3%' },
  { ...field('lv_prechg_ths', 'Precharge Threshold', 'V'), left: '41.6%', top: '89.3%' },
  { ...field('ov_chg_inh', 'Charge Termination', 'V'), left: '69.3%', top: '89.3%' }
];

/* Temperature derating diagram (figma_temp_management_page.svg). Below the low cutoff and
   above the high cutoff charging stops; between cutoff and foldback the current ramps. */
export const tempManagementFields = [
  { ...field('ichg_max', 'Max Charge Current', 'mA'), left: '0%', top: '21.7%' },
  { ...field('lt_ichg', 'Lo Temp Current', 'mA'), left: '0%', top: '55.7%' },
  { ...field('lt_chg_ths', 'Lo Temp Foldback', '°C'), left: '37.6%', top: '1.1%' },
  { ...field('ht_chg_ths', 'Hi Temp Foldback', '°C'), left: '61.4%', top: '1.1%' },
  { ...field('lt_chg_inh', 'Lo Temp Cutoff', '°C'), left: '21.8%', top: '89.3%' },
  { ...field('ht_chg_inh', 'Hi Temp Cutoff', '°C'), left: '69.3%', top: '89.3%' }
];

export const tempManagementExtra = [
  field('temp_mgmt', 'Temp Management'),
  field('ntc_r', 'NTC R25', 'kΩ'),
  field('ntc_beta', 'NTC Beta', 'K'),
  field('ht_ichg', 'Hi Temp Current', 'mA')
];

/* ---------------------------------------------------------------- key lists */

const unique = (keys) => [...new Set(keys)];

/** Every config property shown on the dashboard (also what Export Config writes). */
export const CONFIG_KEYS = unique([
  ...configCards.flatMap((card) => card.rows),
  ...chargeProfileFields,
  ...tempManagementFields,
  ...tempManagementExtra
].filter((entry) => !entry.kind).map((entry) => entry.key));

/** Status properties polled for the Telemetry tab. */
export const STATUS_KEYS = unique([
  telemetryInput.main,
  ...telemetryInput.rows,
  telemetryOutput.main,
  ...telemetryOutput.rows,
  telemetryBattery.main,
  telemetryBattery.secondary,
  ...telemetryBattery.rows,
  ...batteryTotals.groups.flatMap((group) => group.keys),
  ...telemetrySystem
].map((entry) => entry.key).filter((key) => !CONFIG_KEYS.includes(key)));

/** Unit for any key on the dashboard, for formatting values outside their home card. */
export const UNIT_BY_KEY = Object.fromEntries(
  [
    ...configCards.flatMap((card) => card.rows),
    ...chargeProfileFields,
    ...tempManagementFields,
    ...tempManagementExtra
  ].map((entry) => [entry.key, entry.unit])
);
