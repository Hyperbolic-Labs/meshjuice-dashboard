<script>
  import {
    POWER_LOG_HOURS,
    Y_METRICS,
    formatAxisValue,
    formatFullLabel,
    formatHourLabel,
    getMetricValues,
    getYRange
  } from '../lib/powerHistory.js';

  export let entries = [];
  export let selectedMetricKey = 'vin';
  export let loading = false;
  export let connected = false;
  export let error = '';
  export let onRefresh = () => {};
  export let onExport = () => {};
  export let onErase = () => {};
  export let erasing = false;

  const MARGIN = { top: 28, right: 28, bottom: 56, left: 84 };
  const VIEW_WIDTH = 1280;
  const VIEW_HEIGHT = 560;
  const plotWidth = VIEW_WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = VIEW_HEIGHT - MARGIN.top - MARGIN.bottom;
  const TICK_HOURS = [0, 12];

  $: selectedMetric = Y_METRICS.find((metric) => metric.key === selectedMetricKey) ?? Y_METRICS[0];
  $: metricValues = getMetricValues(entries, selectedMetric.key);
  $: [yMin, yMax] = getYRange(metricValues);
  $: plotPoints = buildPoints(entries, selectedMetric, yMin, yMax);
  $: yTicks = buildYTicks(yMin, yMax, selectedMetric.precision);
  $: xTicks = buildXTicks(entries);

  /** x position: hours since the oldest record, so gaps in the log show as gaps */
  function xFor(entry, first, span) {
    return span > 0 ? ((entry.date - first) / span) * plotWidth : plotWidth / 2;
  }

  function timeSpan(logEntries) {
    if (logEntries.length < 2) {
      return { first: logEntries[0]?.date ?? 0, span: 0 };
    }
    const first = logEntries[0].date;
    return { first, span: logEntries[logEntries.length - 1].date - first };
  }

  function buildYTicks(min, max, precision) {
    const tickCount = 5;
    const range = max - min || 1;
    const step = range / (tickCount - 1);
    return Array.from({ length: tickCount }, (_, index) => {
      const value = max - step * index;
      return { value, y: MARGIN.top + ((step * index) / range) * plotHeight, label: formatAxisValue(value, precision) };
    });
  }

  function buildPoints(logEntries, metric, min, max) {
    const { first, span } = timeSpan(logEntries);
    const range = max - min || 1;
    return logEntries.map((entry) => {
      const value = Number(entry[metric.key] ?? 0);
      return {
        x: xFor(entry, first, span),
        y: plotHeight - ((value - min) / range) * plotHeight,
        title: `${formatFullLabel(entry.date)}: ${formatAxisValue(value, metric.precision)} ${metric.unit}`
      };
    });
  }

  function buildXTicks(logEntries) {
    const { first, span } = timeSpan(logEntries);
    return logEntries
      .filter((entry, index) => index > 0 && index < logEntries.length - 1 && TICK_HOURS.includes(entry.date.getHours()))
      .map((entry) => ({ x: MARGIN.left + xFor(entry, first, span), label: formatHourLabel(entry.date) }));
  }

  /** Break the line where an hour is missing */
  $: segments = buildSegments(entries, plotPoints);
  function buildSegments(logEntries, points) {
    const result = [];
    let current = [];
    points.forEach((point, index) => {
      const gap = index > 0 && logEntries[index].date - logEntries[index - 1].date > 3600 * 1000 * 1.5;
      if (gap && current.length) {
        result.push(current);
        current = [];
      }
      current.push(`${MARGIN.left + point.x},${MARGIN.top + point.y}`);
    });
    if (current.length) {
      result.push(current);
    }
    return result.filter((segment) => segment.length > 1).map((segment) => segment.join(' '));
  }
</script>

<section class="power-history-panel" aria-label="Power history chart">
  <div class="power-history-toolbar">
    <div class="power-history-toolbar-group">
      <label class="power-history-label" for="power-history-metric">Y axis</label>
      <select id="power-history-metric" class="power-history-select" bind:value={selectedMetricKey}>
        {#each Y_METRICS as metric}
          <option value={metric.key}>{metric.label} ({metric.unit})</option>
        {/each}
      </select>
    </div>

    <div class="power-history-toolbar-group power-history-toolbar-group--meta">
      <span class="power-history-meta">{entries.length} / {POWER_LOG_HOURS} hours</span>
      <button class="power-history-refresh power-history-refresh--secondary" type="button" on:click={onExport} disabled={!entries.length}>
        Export CSV
      </button>
      <button class="power-history-refresh power-history-refresh--danger" type="button" on:click={onErase} disabled={loading || erasing || !connected}>
        {erasing ? 'Erasing…' : 'Erase History'}
      </button>
      <button class="power-history-refresh" type="button" on:click={onRefresh} disabled={loading || erasing || !connected}>
        {loading ? 'Loading…' : 'Refresh'}
      </button>
    </div>
  </div>

  <div class="power-history-chart-wrap">
    {#if error}
      <div class="power-history-empty">{error}</div>
    {:else if !connected && entries.length === 0}
      <div class="power-history-empty">Connect to the device to load the 7-day power history.</div>
    {:else if entries.length === 0}
      <div class="power-history-empty">{loading ? 'Reading history from the device…' : 'The device has no complete hours recorded yet.'}</div>
    {:else}
      <svg class="power-history-chart" viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} role="img" aria-label={`Power history plot showing ${selectedMetric.label}`}>
        <rect x={MARGIN.left} y={MARGIN.top} width={plotWidth} height={plotHeight} class="power-history-plot-bg" />

        {#each yTicks as tick}
          <line x1={MARGIN.left} y1={tick.y} x2={MARGIN.left + plotWidth} y2={tick.y} class="power-history-grid-line" />
          <text x={MARGIN.left - 12} y={tick.y + 4} class="power-history-axis-label power-history-axis-label--y">{tick.label}</text>
        {/each}

        {#each xTicks as tick}
          <line x1={tick.x} y1={MARGIN.top} x2={tick.x} y2={MARGIN.top + plotHeight} class="power-history-grid-line power-history-grid-line--major" />
          <text x={tick.x} y={MARGIN.top + plotHeight + 28} class="power-history-axis-label power-history-axis-label--x">{tick.label}</text>
        {/each}

        {#each segments as segment}
          <polyline points={segment} class="power-history-connecting-line" />
        {/each}

        {#each plotPoints as point}
          <circle cx={MARGIN.left + point.x} cy={MARGIN.top + point.y} r="4.5" class="power-history-dot">
            <title>{point.title}</title>
          </circle>
        {/each}

        <text x={MARGIN.left} y={20} class="power-history-axis-title">{selectedMetric.label} ({selectedMetric.unit})</text>
      </svg>
    {/if}
  </div>
</section>
