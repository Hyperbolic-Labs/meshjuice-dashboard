<script>
  import { onDestroy, onMount, tick } from 'svelte';
  import chargeProfileReference from '../figma_charge_profile_page.svg';
  import tempManagementReference from '../figma_temp_management_page.svg';
  import EditDialog from './components/EditDialog.svelte';
  import TimeDialog from './components/TimeDialog.svelte';
  import PowerHistoryChart from './components/PowerHistoryChart.svelte';
  import DiagramMarker from './components/DiagramMarker.svelte';
  import FirmwareUpdate from './components/FirmwareUpdate.svelte';
  import { chargeProfilePoint, tempManagementPoint } from './lib/diagram.js';
  import { SerialLink, SerialTimeoutError } from './lib/serial.js';
  import { Device } from './lib/device.js';
  import {
    visibleRows,
    CONFIG_KEYS,
    STATUS_KEYS,
    batteryTotals,
    chargeProfileFields,
    configCards,
    tempManagementExtra,
    tempManagementFields,
    telemetryBattery,
    telemetryInput,
    telemetryOutput,
    telemetrySystem
  } from './lib/layout.js';
  import { EVENTS, decodeFaultFlags, describeEvent, isErrorEvent } from './lib/events.js';
  import { formatValue, roundValue, signClass } from './lib/format.js';
  import { toCsv } from './lib/powerHistory.js';

  const tabs = ['Telemetry', 'Config', 'Charge Profile', 'Temp Management', 'Power History', 'Diagnostic', 'Terminal', 'Firmware'];
  const POLL_MS = 2000;
  const TERMINAL_LIMIT = 200_000;

  let activeTab = 'Telemetry';

  /* ------------------------------------------------------------ connection */

  let connected = false;
  let linkBusy = false;
  let statusMessage = SerialLink.supported ? 'Click Connect and choose the MeshJuice serial port.' : 'Web Serial is not available. Use Chrome or Edge on a desktop computer.';
  let statusKind = 'info';      // info | ok | error
  let actionBusy = '';          // label of the top-bar action in progress
  let autoRefresh = true;
  let lastUpdated = null;
  let pollTimer = null;
  let polling = false;

  /** Every value read from the device, by property name (strings exactly as the firmware prints them) */
  let values = {};
  let rtcTime = '';
  let unsavedChanges = false;

  /* Recent battery readings, drawn as a trail behind the live marker on the diagrams */
  const TRAIL_LENGTH = 150;     // ~5 minutes at the 2 s poll rate
  let batteryTrail = [];

  const link = new SerialLink({
    onRx: (text, owner) => {
      if (owner === 'terminal' || owner === null || showTraffic) {
        appendTerminal(text);
      }
    },
    onConnectionChange: (isConnected) => {
      connected = isConnected;
      if (!isConnected && !actionBusy) {
        setStatus('The device disconnected.', 'error');
        appendTerminal('\n[disconnected]\n');
      }
    },
    onBusyChange: () => {
      linkBusy = link.busy;
    }
  });
  const device = new Device(link);

  function setStatus(message, kind = 'info') {
    statusMessage = message;
    statusKind = kind;
  }

  function errorText(error) {
    if (error instanceof SerialTimeoutError) {
      return 'The device did not answer. A long-running terminal command may be active (press Stop on the Terminal tab).';
    }
    return error instanceof Error ? error.message : String(error);
  }

  async function connect() {
    try {
      await link.connect();
      appendTerminal('[connected]\n');
      setStatus('Connected. Reading settings…');
      await device.resync();
      await refreshAll();
      setStatus('Connected.', 'ok');
    } catch (error) {
      if (error?.name !== 'NotFoundError') {
        setStatus(errorText(error), 'error');
      }
    }
  }

  async function disconnect() {
    await link.disconnect();
    setStatus('Disconnected.');
  }

  /* ------------------------------------------------------------ reading values */

  async function refreshStatus() {
    const [status, time] = await Promise.all([device.getMany(STATUS_KEYS), device.time()]);
    values = { ...values, ...status };
    rtcTime = time;
    lastUpdated = new Date();
    batteryTrail = [...batteryTrail, { vbat: status.vbat, ibat: status.ibat, bat_temp: status.bat_temp }].slice(-TRAIL_LENGTH);
  }

  async function refreshConfig() {
    values = { ...values, ...(await device.getMany(CONFIG_KEYS)) };
  }

  async function refreshAll() {
    await refreshConfig();
    await refreshStatus();
  }

  async function manualRefresh() {
    try {
      await refreshAll();
      setStatus('Values refreshed from the device.', 'ok');
    } catch (error) {
      setStatus(errorText(error), 'error');
    }
  }

  async function poll() {
    if (polling || !connected || !autoRefresh || link.busy || editingField || editingTime || actionBusy || document.hidden) {
      return;
    }
    polling = true;
    try {
      await refreshStatus();
      if (statusKind === 'error' && statusMessage.startsWith('The device did not answer')) {
        setStatus('Connected.', 'ok');
      }
    } catch (error) {
      if (connected) {
        setStatus(errorText(error), 'error');
      }
    } finally {
      polling = false;
    }
  }

  onMount(() => {
    pollTimer = setInterval(poll, POLL_MS);
  });

  onDestroy(() => {
    clearInterval(pollTimer);
    link.disconnect();
  });

  /* ------------------------------------------------------------ editing */

  let editingField = null;
  let editingTime = false;

  function openEditor(entry) {
    if (!connected) {
      setStatus('Connect to the device to change settings.', 'error');
      return;
    }
    if (entry.kind === 'time') {
      editingTime = true;
    } else {
      editingField = entry;
    }
  }

  async function onApplied(key, value) {
    unsavedChanges = true;
    setStatus(`${key} set to ${value}. Click Save Changes to keep it after a reboot.`, 'ok');
    try {
      // Some settings change others (e.g. battery chemistry sets the thresholds), so re-read them all
      await refreshAll();
    } catch (error) {
      setStatus(errorText(error), 'error');
    }
  }

  function onTimeApplied(time) {
    setStatus(`Device clock set to ${time}.`, 'ok');
    refreshStatus().catch(() => {});
  }

  /* ------------------------------------------------------------ top bar actions */

  async function runAction(label, fn) {
    if (actionBusy) {
      return;
    }
    actionBusy = label;
    try {
      await fn();
    } catch (error) {
      setStatus(errorText(error), 'error');
    } finally {
      actionBusy = '';
    }
  }

  function saveChanges() {
    return runAction('Saving', async () => {
      setStatus('Saving configuration to EEPROM…');
      await device.save();
      unsavedChanges = false;
      await refreshStatus();
      setStatus('Configuration saved.', 'ok');
    });
  }

  function reboot() {
    if (!confirm('Reboot the device? Unsaved changes will be lost.')) {
      return;
    }
    return runAction('Rebooting', async () => {
      setStatus('Rebooting…');
      appendTerminal('\n[reboot]\n');
      await device.reboot();
      unsavedChanges = false;
      await refreshAll();
      setStatus('Device rebooted and reconnected.', 'ok');
    });
  }

  function factoryReset() {
    if (!confirm('Factory reset erases the saved configuration, the power history and the event log, then reboots with default settings.\n\nContinue?')) {
      return;
    }
    return runAction('Resetting', async () => {
      setStatus('Erasing EEPROM and rebooting…');
      appendTerminal('\n[erase]\n');
      await device.erase();
      unsavedChanges = false;
      events = [];
      historyEntries = [];
      await refreshAll();
      setStatus('Factory reset complete.', 'ok');
    });
  }

  /* ------------------------------------------------------------ firmware update */

  function enterDfu() {
    if (!confirm('Restart the device into its USB DFU bootloader?\n\nUnsaved changes will be lost, and charging and output control stop until the firmware starts again.')) {
      return;
    }
    return runAction('Entering DFU', async () => {
      setStatus('Restarting into the DFU bootloader…');
      appendTerminal('\n[dfu]\n');
      await device.enterDfu();
      unsavedChanges = false;
      setStatus('The device is in DFU mode. Select the DFU device, then flash the firmware.', 'ok');
    });
  }

  function reconnectAfterUpdate() {
    return runAction('Reconnecting', async () => {
      setStatus('Waiting for the new firmware to start…');
      const back = await link.reconnectAfterReset({ dropWaitMs: 0, timeoutMs: 15000 });
      if (!back) {
        setStatus('Firmware updated. Click Connect to reconnect to the device.', 'ok');
        return;
      }
      appendTerminal('[connected]\n');
      await device.resync();
      unsavedChanges = false;
      await refreshAll();
      setStatus('Firmware updated and reconnected.', 'ok');
    });
  }

  function exportConfig() {
    return runAction('Exporting', async () => {
      const config = await device.getMany(CONFIG_KEYS);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      download(`meshjuice-config-${stamp}.json`, `${JSON.stringify(config, null, 2)}\n`, 'application/json');
      setStatus(`Exported ${Object.keys(config).length} settings.`, 'ok');
    });
  }

  let importInput;

  function chooseImportFile() {
    importInput.value = '';
    importInput.click();
  }

  async function importConfig(event) {
    const file = event.currentTarget.files?.[0];
    if (!file) {
      return;
    }
    await runAction('Importing', async () => {
      let parsed;
      try {
        parsed = JSON.parse(await file.text());
      } catch (error) {
        throw new Error(`${file.name} is not valid JSON.`);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${file.name} must contain a JSON object of "setting": "value" pairs.`);
      }

      let pending = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
      const total = Object.keys(pending).length;

      // Some settings are validated against others (threshold ordering, current limits), so a
      // value can be rejected only because its neighbour hasn't been written yet. Retry the
      // rejected ones while each pass makes progress.
      for (let pass = 0; pass < 4 && Object.keys(pending).length; pass += 1) {
        const { rejected } = await device.assign(pending);
        if (rejected.length === Object.keys(pending).length) {
          break;
        }
        pending = Object.fromEntries(rejected.map((key) => [key, pending[key]]));
      }

      unsavedChanges = true;
      await refreshAll();
      const rejectedKeys = Object.keys(pending);
      if (rejectedKeys.length) {
        setStatus(`Imported ${total - rejectedKeys.length} of ${total} settings. Rejected by the device: ${rejectedKeys.join(', ')}. Click Save Changes to keep the rest.`, 'error');
      } else {
        setStatus(`Imported ${total} settings. Click Save Changes to keep them after a reboot.`, 'ok');
      }
    });
  }

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ------------------------------------------------------------ telemetry controls */

  let controlBusy = '';

  async function runControl(label, fn, done) {
    controlBusy = label;
    try {
      const result = await fn();
      setStatus(done(result), 'ok');
      await refreshStatus();
    } catch (error) {
      setStatus(errorText(error), 'error');
    } finally {
      controlBusy = '';
    }
  }

  function setCharging(allow) {
    return runControl(allow ? 'chg-on' : 'chg-off', () => device.setCharging(allow), () => (allow ? 'Charging allowed.' : 'Charging inhibited.'));
  }

  function setOutput(on) {
    if (on && !confirm('Turn VOUT on manually? This is the `on` bench-test command and bypasses output protection.')) {
      return;
    }
    return runControl(on ? 'out-on' : 'out-off', () => device.setOutput(on), (report) => (on ? `Output on. ${report.split('\n').slice(1).join(' ').trim()}` : 'Output off.'));
  }

  /* ------------------------------------------------------------ diagnostic */

  let events = [];
  let eventCount = 200;
  let eventsLoading = false;
  let eventsLoaded = false;
  let eventsError = '';
  let selectedEvent = null;

  async function loadEvents() {
    eventsLoading = true;
    eventsError = '';
    try {
      events = (await device.eventLog(eventCount)).reverse();     // newest first
      selectedEvent = events[0] ?? null;
      setStatus(`Loaded ${events.length} events.`, 'ok');
    } catch (error) {
      eventsError = errorText(error);
    } finally {
      eventsLoading = false;
      eventsLoaded = true;
    }
  }

  let eventsErasing = false;

  async function eraseEvents() {
    if (!confirm('Erase the event log on the device? This cannot be undone.')) {
      return;
    }
    eventsErasing = true;
    try {
      setStatus('Erasing the event log…');
      await device.clearEventLog();
      events = [];
      selectedEvent = null;
      eventsError = '';
      setStatus('Event log erased.', 'ok');
    } catch (error) {
      setStatus(errorText(error), 'error');
    } finally {
      eventsErasing = false;
    }
  }

  $: faultNames = decodeFaultFlags(values.fault_flags);

  /* ------------------------------------------------------------ power history */

  let historyEntries = [];
  let historyMetric = 'vin';
  let historyLoading = false;
  let historyLoaded = false;
  let historyError = '';

  async function loadHistory() {
    historyLoading = true;
    historyError = '';
    try {
      historyEntries = await device.powerHistory(168);
      setStatus(`Loaded ${historyEntries.length} hours of power history.`, 'ok');
    } catch (error) {
      historyError = errorText(error);
    } finally {
      historyLoading = false;
      historyLoaded = true;
    }
  }

  let historyErasing = false;

  async function eraseHistory() {
    if (!confirm('Erase the 7-day power history on the device? This cannot be undone.\n\nExport CSV first if you want to keep it.')) {
      return;
    }
    historyErasing = true;
    try {
      setStatus('Erasing the power history…');
      await device.clearPowerHistory();
      historyEntries = [];
      historyError = '';
      setStatus('Power history erased.', 'ok');
    } catch (error) {
      setStatus(errorText(error), 'error');
    } finally {
      historyErasing = false;
    }
  }

  function exportHistory() {
    download('meshjuice-power-history.csv', toCsv(historyEntries), 'text/csv');
  }

  // Load logs the first time their tab is opened while connected (once per connection, so an
  // empty log isn't re-read in a loop)
  $: if (!connected) {
    eventsLoaded = false;
    historyLoaded = false;
  }
  $: if (connected && activeTab === 'Diagnostic' && !eventsLoaded && !eventsLoading && !eventsError) {
    loadEvents();
  }
  $: if (connected && activeTab === 'Power History' && !historyLoaded && !historyLoading && !historyError) {
    loadHistory();
  }

  /* ------------------------------------------------------------ terminal */

  let terminalText = '';
  let terminalInput = '';
  let terminalHistory = [];
  let terminalHistoryIndex = -1;
  let terminalElement;
  let showTraffic = false;

  async function appendTerminal(text) {
    terminalText = (terminalText + text.replace(/\r/g, '')).slice(-TERMINAL_LIMIT);
    await tick();
    if (terminalElement) {
      terminalElement.scrollTop = terminalElement.scrollHeight;
    }
  }

  async function sendTerminal() {
    const line = terminalInput.trim();
    if (!line || !connected) {
      return;
    }
    terminalHistory = [line, ...terminalHistory.filter((entry) => entry !== line)].slice(0, 50);
    terminalHistoryIndex = -1;
    terminalInput = '';
    try {
      await device.terminal(line);
    } catch (error) {
      appendTerminal(`\n[${errorText(error)}]\n`);
    }
  }

  function terminalKeydown(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      sendTerminal();
    } else if (event.key === 'ArrowUp' && terminalHistory.length) {
      event.preventDefault();
      terminalHistoryIndex = Math.min(terminalHistoryIndex + 1, terminalHistory.length - 1);
      terminalInput = terminalHistory[terminalHistoryIndex];
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      terminalHistoryIndex = Math.max(terminalHistoryIndex - 1, -1);
      terminalInput = terminalHistoryIndex < 0 ? '' : terminalHistory[terminalHistoryIndex];
    } else if (event.key === 'c' && event.ctrlKey && !window.getSelection()?.toString()) {
      event.preventDefault();
      stopTerminal();
    }
  }

  /** Ctrl-C: the firmware aborts the running command (cycletest, watch, log, ...) */
  async function stopTerminal() {
    try {
      await link.writeRaw('\x03');
    } catch (error) {
      appendTerminal(`\n[${errorText(error)}]\n`);
    }
  }

  /* ------------------------------------------------------------ display helpers */

  $: display = (entry) => formatValue(values[entry.key], entry.unit, entry.decimals);

  // Live battery position on the diagrams (thresholds come from the device's config values)
  $: chargePoint = connected ? chargeProfilePoint(values, values) : null;
  $: chargeTrail = batteryTrail.map((reading) => chargeProfilePoint(values, reading)).filter(Boolean);
  $: chargeLabel = `${formatValue(values.vbat, 'V')} · ${formatValue(values.ibat, 'mA')}${values.chg_sts && values.chg_sts !== '---' ? ` · ${values.chg_sts}` : ''}`;
  $: tempPoint = connected ? tempManagementPoint(values, values) : null;
  $: tempTrail = batteryTrail.map((reading) => tempManagementPoint(values, reading)).filter(Boolean);
  $: tempLabel = `${formatValue(values.bat_temp, '°C')} · ${formatValue(values.ibat, 'mA')}`;
  $: chargingInhibited = values.chg_inh_src === 'USER_INH';
</script>

<svelte:head>
  <title>MeshJuice Dashboard</title>
</svelte:head>

<div class="shell">
  <header class="topbar">
    <div class="brand">meshjuice 10</div>
    <div class="actions">
      {#if connected}
        <button type="button" class="secondary" on:click={disconnect} disabled={Boolean(actionBusy)}>Disconnect</button>
      {:else}
        <button type="button" class="primary" on:click={connect} disabled={!SerialLink.supported || Boolean(actionBusy)}>Connect</button>
      {/if}
      <button type="button" on:click={manualRefresh} disabled={!connected || Boolean(actionBusy)}>Refresh</button>
      <label class="toggle" title="Poll telemetry every {POLL_MS / 1000} s">
        <input type="checkbox" bind:checked={autoRefresh} />
        <span>Auto-refresh</span>
      </label>
      <button type="button" on:click={chooseImportFile} disabled={!connected || Boolean(actionBusy)}>Import Config</button>
      <button type="button" on:click={exportConfig} disabled={!connected || Boolean(actionBusy)}>Export Config</button>
      <button type="button" class:attention={unsavedChanges} on:click={saveChanges} disabled={!connected || Boolean(actionBusy)}>
        {actionBusy === 'Saving' ? 'Saving…' : 'Save Changes'}
      </button>
      <button type="button" on:click={reboot} disabled={!connected || Boolean(actionBusy)}>{actionBusy === 'Rebooting' ? 'Rebooting…' : 'Reboot'}</button>
      <button type="button" class="danger" on:click={factoryReset} disabled={!connected || Boolean(actionBusy)}>
        {actionBusy === 'Resetting' ? 'Resetting…' : 'Factory Reset'}
      </button>
      <input class="visually-hidden" type="file" accept="application/json,.json" bind:this={importInput} on:change={importConfig} />
    </div>
  </header>

  <nav class="tab-row" aria-label="Dashboard tabs">
    {#each tabs as tab}
      <button type="button" class:active={tab === activeTab} on:click={() => (activeTab = tab)}>{tab}</button>
    {/each}
  </nav>

  <section class="panel panel--status">
    <div>
      <h1>{activeTab}</h1>
      <p class:status-error={statusKind === 'error'} class:status-ok={statusKind === 'ok'}>{statusMessage}</p>
    </div>
    <div class="status-chips">
      {#if unsavedChanges}<span class="chip chip--warn" title="Applied changes have not been saved to EEPROM">Unsaved</span>{/if}
      {#if connected && lastUpdated}<span class="chip chip--muted">Updated {lastUpdated.toLocaleTimeString()}</span>{/if}
      <span class="chip" class:connected class:busy={connected && (linkBusy || actionBusy)}>
        {connected ? (actionBusy || (linkBusy ? 'Busy' : 'Live')) : 'Offline'}
      </span>
    </div>
  </section>

  {#if activeTab === 'Telemetry'}
    <main class="dashboard-grid">
      <div class="cards-stack">
        {#each [telemetryInput, telemetryOutput] as card}
          <article class="card">
            <div class="card-title">{card.title}</div>
            <div class="card-main" data-field={card.main.key}>{display(card.main)}</div>
            <div class="card-grid">
              {#each card.rows as row}
                <div class="metric-row">
                  <span class="metric-label">{row.label}</span>
                  <span class="metric-value" data-field={row.key}>{display(row)}</span>
                </div>
              {/each}
            </div>
            {#if card === telemetryOutput}
              <div class="card-controls">
                <button type="button" on:click={() => setOutput(true)} disabled={!connected || Boolean(controlBusy)}>
                  {controlBusy === 'out-on' ? 'Switching…' : 'Output On'}
                </button>
                <button type="button" on:click={() => setOutput(false)} disabled={!connected || Boolean(controlBusy)}>
                  {controlBusy === 'out-off' ? 'Switching…' : 'Output Off'}
                </button>
              </div>
            {/if}
          </article>
        {/each}
      </div>

      <article class="card card--battery">
        <div class="card-title">{telemetryBattery.title}</div>
        <div class="card-main-row">
          <div class="card-main" data-field={telemetryBattery.main.key}>{display(telemetryBattery.main)}</div>
          <div class="card-main card-main--secondary {signClass(roundValue(values.ibat, telemetryBattery.secondary.decimals))}" data-field={telemetryBattery.secondary.key}>
            {display(telemetryBattery.secondary)}
          </div>
        </div>
        <div class="card-grid">
          {#each telemetryBattery.rows as row}
            <div class="metric-row">
              <span class="metric-label">{row.label}</span>
              <span class="metric-value" data-field={row.key}>{display(row)}</span>
            </div>
          {/each}
        </div>

        <table class="totals-table">
          <thead>
            <tr>
              <th></th>
              <th colspan="2">Capacity</th>
              <th colspan="2">Energy</th>
            </tr>
            <tr>
              <th></th>
              {#each batteryTotals.columns as column}<th>{column}</th>{/each}
            </tr>
          </thead>
          <tbody>
            {#each batteryTotals.groups as group}
              <tr>
                <th scope="row">{group.label}</th>
                {#each group.keys as entry}<td data-field={entry.key}>{display(entry)}</td>{/each}
              </tr>
            {/each}
          </tbody>
        </table>

        <div class="card-controls">
          <button type="button" class:active={connected && !chargingInhibited} title="chg on: allow charging and restart the charge cycle" on:click={() => setCharging(true)} disabled={!connected || Boolean(controlBusy)}>
            {controlBusy === 'chg-on' ? 'Switching…' : 'Allow Charging'}
          </button>
          <button type="button" class:active={chargingInhibited} title="chg off: hold off charging and run from the battery" on:click={() => setCharging(false)} disabled={!connected || Boolean(controlBusy)}>
            {controlBusy === 'chg-off' ? 'Switching…' : 'Inhibit Charging'}
          </button>
        </div>
      </article>

      <aside class="summary-panel" aria-label="System status">
        <div class="summary-header">
          <span>System</span>
          <span></span>
        </div>
        <div class="summary-row">
          <span class="summary-label">RTC</span>
          <span class="summary-value">{rtcTime || '—'}</span>
        </div>
        {#each telemetrySystem as item}
          <div class="summary-row">
            <span class="summary-label">{item.label}</span>
            <span class="summary-value" data-field={item.key}>{display(item)}</span>
          </div>
        {/each}
        {#if faultNames.length}
          <div class="fault-list" role="status">
            <span class="summary-label">Active faults</span>
            {#each faultNames as name}
              <span class="fault-chip" title={describeEvent(name)}>{name}</span>
            {/each}
          </div>
        {/if}
      </aside>
    </main>
  {:else if activeTab === 'Config'}
    <section class="config-grid" aria-label="Configuration">
      {#each configCards as card}
        <article class="card config-card">
          <div class="card-title">{card.title}</div>
          <div class="config-fields">
            {#each visibleRows(card.rows, values) as row}
              <button class="config-field" type="button" disabled={!connected} on:click={() => openEditor(row)}>
                <span class="config-label">{row.label}</span>
                <span class="config-value" data-field={row.key}>{row.kind === 'time' ? rtcTime || '—' : display(row)}</span>
              </button>
            {/each}
          </div>
        </article>
      {/each}
    </section>
  {:else if activeTab === 'Charge Profile'}
    <section class="diagram-panel" aria-label="Charge profile">
      <div class="diagram-stage">
        <img class="diagram-reference" src={chargeProfileReference} alt="Charge current versus battery voltage" />
        <DiagramMarker point={chargePoint} trail={chargeTrail} label={chargeLabel} />
        <div class="diagram-overlay">
          {#each chargeProfileFields as entry}
            <button class="config-field diagram-field" type="button" style={`left: ${entry.left}; top: ${entry.top};`} disabled={!connected} on:click={() => openEditor(entry)}>
              <span class="config-label">{entry.label}</span>
              <span class="config-value" data-field={entry.key}>{display(entry)}</span>
            </button>
          {/each}
        </div>
      </div>
      <p class="diagram-note">
        <span class="diagram-legend-dot"></span> Battery now (VBAT, IBAT), with its path over the last few minutes.
        The diagram isn't to scale: positions are relative to the thresholds above.
      </p>
    </section>
  {:else if activeTab === 'Temp Management'}
    <section class="diagram-panel" aria-label="Temperature management">
      <div class="diagram-stage">
        <img class="diagram-reference" src={tempManagementReference} alt="Charge current versus battery temperature" />
        <DiagramMarker point={tempPoint} trail={tempTrail} label={tempLabel} />
        <div class="diagram-overlay">
          {#each tempManagementFields as entry}
            <button class="config-field diagram-field" type="button" style={`left: ${entry.left}; top: ${entry.top};`} disabled={!connected} on:click={() => openEditor(entry)}>
              <span class="config-label">{entry.label}</span>
              <span class="config-value" data-field={entry.key}>{display(entry)}</span>
            </button>
          {/each}
        </div>
      </div>
      <p class="diagram-note">
        <span class="diagram-legend-dot"></span> Battery now (battery temperature, IBAT), with its path over the last few minutes.
        {#if values.temp_mgmt === 'Disabled'}Temperature management is disabled, so the firmware doesn't derate on temperature.{/if}
      </p>
      <div class="diagram-extra">
        {#each tempManagementExtra as entry}
          <button class="config-field" type="button" disabled={!connected} on:click={() => openEditor(entry)}>
            <span class="config-label">{entry.label}</span>
            <span class="config-value" data-field={entry.key}>{display(entry)}</span>
          </button>
        {/each}
      </div>
    </section>
  {:else if activeTab === 'Power History'}
    <PowerHistoryChart
      entries={historyEntries}
      bind:selectedMetricKey={historyMetric}
      loading={historyLoading}
      {connected}
      error={historyError}
      onRefresh={loadHistory}
      onExport={exportHistory}
      onErase={eraseHistory}
      erasing={historyErasing}
    />
  {:else if activeTab === 'Diagnostic'}
    <section class="diagnostic-panel" aria-label="Event log">
      <div class="diagnostic-toolbar">
        <div>
          <h2>Event Log</h2>
          <p>Events recorded by the device, newest first.</p>
        </div>
        <div class="toolbar-group">
          <label class="power-history-label" for="event-count">Show</label>
          <select id="event-count" class="power-history-select power-history-select--small" bind:value={eventCount}>
            <option value={50}>50 events</option>
            <option value={200}>200 events</option>
            <option value={1023}>All (1023)</option>
          </select>
          <button class="diagnostic-refresh diagnostic-refresh--danger" type="button" on:click={eraseEvents} disabled={eventsLoading || eventsErasing || !connected}>
            {eventsErasing ? 'Erasing…' : 'Erase Log'}
          </button>
          <button class="diagnostic-refresh" type="button" on:click={loadEvents} disabled={eventsLoading || eventsErasing || !connected}>
            {eventsLoading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div class="diagnostic-content">
        <div class="diagnostic-log" role="log">
          <div class="diagnostic-log-header">{events.length} event{events.length === 1 ? '' : 's'}</div>
          <div class="diagnostic-log-list">
            {#if eventsError}
              <p class="diagnostic-empty status-error">{eventsError}</p>
            {:else if !connected && !events.length}
              <p class="diagnostic-empty">Connect to the device to read its event log.</p>
            {:else if !events.length}
              <p class="diagnostic-empty">{eventsLoading ? 'Reading the event log…' : 'No events recorded.'}</p>
            {/if}
            {#each events as entry}
              <button class="diagnostic-entry" class:selected={selectedEvent === entry} type="button" on:click={() => (selectedEvent = entry)}>
                <span class="diagnostic-timestamp">{entry.stamp}</span>
                <span class="diagnostic-message" class:error={isErrorEvent(entry.name)}>{entry.name}</span>
              </button>
            {/each}
          </div>
        </div>

        <div class="diagnostic-notes">
          {#if selectedEvent}
            <div class="diagnostic-detail">
              <span class="diagnostic-notes-label">{selectedEvent.name}</span>
              <span class="diagnostic-detail-time">{selectedEvent.date ? selectedEvent.date.toLocaleString() : selectedEvent.stamp}</span>
              <p>{describeEvent(selectedEvent.name)}</p>
            </div>
          {/if}
          <span class="diagnostic-notes-label">Event types</span>
          <div class="event-reference">
            {#each EVENTS as event}
              <div class="event-reference-row" class:highlight={selectedEvent?.name === event.name}>
                <span class="event-reference-name" class:error={isErrorEvent(event.name)}>{event.name}</span>
                <span>{event.text}</span>
              </div>
            {/each}
          </div>
        </div>
      </div>
    </section>
  {:else if activeTab === 'Terminal'}
    <section class="terminal-panel" aria-label="Serial terminal">
      <div class="terminal-toolbar">
        <div>
          <h2>Serial Terminal</h2>
          <p>Type CLI commands (get, assign, valid, min, max, json, log, history, time, cycletest…). Stop sends Ctrl-C.</p>
        </div>
        <div class="toolbar-group">
          <label class="toggle toggle--light" title="Also show the commands the dashboard sends">
            <input type="checkbox" bind:checked={showTraffic} />
            <span>Show dashboard traffic</span>
          </label>
          <button class="terminal-clear" type="button" on:click={stopTerminal} disabled={!connected}>Stop</button>
          <button class="terminal-clear" type="button" on:click={() => (terminalText = '')}>Clear</button>
        </div>
      </div>

      <pre class="terminal-output" role="log" aria-live="polite" bind:this={terminalElement}>{terminalText || (connected ? '' : 'Connect to the device to use the terminal.')}</pre>

      <div class="terminal-input-row">
        <input
          class="terminal-input"
          type="text"
          spellcheck="false"
          autocomplete="off"
          bind:value={terminalInput}
          placeholder={connected ? 'Type a command and press Enter' : 'Connect to the device first'}
          disabled={!connected}
          on:keydown={terminalKeydown}
        />
        <button class="terminal-send" type="button" on:click={sendTerminal} disabled={!connected || !terminalInput.trim()}>Send</button>
      </div>
    </section>
  {:else if activeTab === 'Firmware'}
    <FirmwareUpdate {connected} {actionBusy} onEnterDfu={enterDfu} onReconnect={reconnectAfterUpdate} />
  {/if}

  {#if editingField}
    <EditDialog {device} field={editingField} onClose={() => (editingField = null)} {onApplied} />
  {/if}
  {#if editingTime}
    <TimeDialog {device} onClose={() => (editingTime = false)} onApplied={onTimeApplied} />
  {/if}
</div>
