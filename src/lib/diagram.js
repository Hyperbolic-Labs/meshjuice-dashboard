/*
  Places live readings on the charge profile / temperature diagrams. The diagrams are
  schematics, not to scale: each configured threshold sits at a fixed spot on the drawing,
  so a reading is mapped piecewise-linearly between the thresholds around it. A reading at
  a threshold lands exactly on that threshold's line.

  Coordinates are in the SVG's own units (viewBox 0 0 1010 588).
*/

export const DIAGRAM_VIEWBOX = { width: 1010, height: 588 };

// Plot area of both diagrams (grid lines in the SVGs)
const PLOT = { left: 222, right: 858, top: 136, bottom: 452 };

/**
 * Map `value` through anchors [{ value, px }]. Outside the anchors the nearest segment's
 * slope is extended (or `fallbackSlope` px per unit when all anchors coincide), then the
 * result is clamped to [min, max].
 */
export function piecewise(value, anchors, { fallbackSlope, min, max }) {
  const points = anchors
    .filter((anchor) => Number.isFinite(anchor.value))
    .sort((a, b) => a.value - b.value);
  if (!Number.isFinite(value) || points.length === 0) {
    return null;
  }

  const clamp = (px) => Math.min(max, Math.max(min, px));
  const slopeOf = (a, b) => (b.value !== a.value ? (b.px - a.px) / (b.value - a.value) : null);

  const first = points[0];
  const last = points[points.length - 1];

  if (value <= first.value) {
    const next = points.find((point) => point.value !== first.value);
    const slope = next ? slopeOf(first, next) : fallbackSlope;
    return clamp(first.px - (first.value - value) * slope);
  }
  if (value >= last.value) {
    const previous = [...points].reverse().find((point) => point.value !== last.value);
    const slope = previous ? slopeOf(previous, last) : fallbackSlope;
    return clamp(last.px + (value - last.value) * slope);
  }
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (value >= a.value && value <= b.value) {
      return clamp(b.value === a.value ? b.px : a.px + ((value - a.value) / (b.value - a.value)) * (b.px - a.px));
    }
  }
  return null;
}

const num = (text) => (text === undefined || text === null || text === '' ? Number.NaN : Number(text));

/** Battery current axis, shared by both diagrams: 0 on the axis, the low step, the max. */
function currentToY(ibat, lowStep, max) {
  return piecewise(num(ibat), [
    { value: 0, px: 414 },
    { value: num(lowStep), px: 374 },
    { value: num(max), px: 174 }
  ], { fallbackSlope: -0.2, min: PLOT.top, max: PLOT.bottom });
}

/** Charge profile: battery voltage across, battery current up. */
export function chargeProfilePoint(values, reading) {
  const x = piecewise(num(reading.vbat), [
    { value: num(values.uv_chg_inh), px: 300 },
    { value: num(values.lv_prechg_ths), px: 380 },
    { value: num(values.rechg_lvl), px: 660 },
    { value: num(values.ov_chg_inh), px: 780 }
  ], { fallbackSlope: 100, min: PLOT.left, max: PLOT.right });
  const y = currentToY(reading.ibat, values.max_iprechg, values.ichg_max);
  return x === null || y === null ? null : { x, y };
}

/** Temperature management: battery temperature across, battery current up. */
export function tempManagementPoint(values, reading) {
  const x = piecewise(num(reading.bat_temp), [
    { value: num(values.lt_chg_inh), px: 300 },
    { value: num(values.lt_chg_ths), px: 460 },
    { value: num(values.ht_chg_ths), px: 700 },
    { value: num(values.ht_chg_inh), px: 780 }
  ], { fallbackSlope: 8, min: PLOT.left, max: PLOT.right });
  const y = currentToY(reading.ibat, values.lt_ichg, values.ichg_max);
  return x === null || y === null ? null : { x, y };
}
