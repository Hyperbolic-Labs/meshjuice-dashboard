<script>
  import { onDestroy, onMount } from 'svelte';
  import { DfuDevice, describeUsbError, webUsbSupported } from '../lib/dfu.js';
  import { FLASH_BASE, formatAddress, loadFirmwareFile, toPageBlocks } from '../lib/firmwareImage.js';

  export let connected = false;
  export let actionBusy = '';
  /** Sends `dfu` over the serial link (App.svelte runs it as a top-bar action). */
  export let onEnterDfu = async () => {};
  /** Reopens the serial port once the new firmware is running. */
  export let onReconnect = async () => {};

  const usbSupported = webUsbSupported();

  let image = null;
  let imageError = '';
  let fileInput;

  let dfu = null;
  let dfuError = '';
  let opening = false;

  let verify = true;
  let startAfter = true;
  let flashing = false;
  let phase = '';
  let done = 0;
  let total = 0;
  let result = '';
  let resultKind = 'info';      // info | ok | error

  $: percent = total ? Math.round((done / total) * 100) : 0;
  $: canFlash = Boolean(image && dfu && !flashing);

  /* ------------------------------------------------------------ step 1 */

  async function enterDfu() {
    await onEnterDfu();
    // Pick up the bootloader without a click if this page was allowed to use it before
    setTimeout(openGranted, 1500);
  }

  /* ------------------------------------------------------------ step 2 */

  function chooseFile() {
    fileInput.value = '';
    fileInput.click();
  }

  async function fileChosen(event) {
    const file = event.currentTarget.files?.[0];
    if (!file) {
      return;
    }
    imageError = '';
    result = '';
    try {
      image = await loadFirmwareFile(file);
    } catch (error) {
      image = null;
      imageError = error instanceof Error ? error.message : String(error);
    }
  }

  /* ------------------------------------------------------------ step 3 */

  async function selectDevice() {
    dfuError = '';
    opening = true;
    try {
      await dfu?.close();
      dfu = await DfuDevice.request();
    } catch (error) {
      if (error?.name !== 'NotFoundError') {     // picker cancelled
        dfuError = describeUsbError(error);
      }
    } finally {
      opening = false;
    }
  }

  async function openGranted() {
    if (dfu || opening || flashing) {
      return;
    }
    const [usb] = await DfuDevice.granted();
    if (!usb) {
      return;
    }
    opening = true;
    dfuError = '';
    try {
      const device = new DfuDevice(usb);
      await device.open();
      dfu = device;
    } catch (error) {
      dfuError = describeUsbError(error);
    } finally {
      opening = false;
    }
  }

  async function flash() {
    if (!canFlash) {
      return;
    }
    if (!confirm(`Flash ${image.name} to the device?\n\nThe current firmware is erased first. Don't unplug the board until it finishes.`)) {
      return;
    }
    flashing = true;
    result = '';
    try {
      const segment = dfu.segmentFor(FLASH_BASE);
      if (!segment) {
        throw new Error(`The DFU device has no memory at ${formatAddress(FLASH_BASE)}. Is it the MeshJuice's STM32?`);
      }
      const blocks = toPageBlocks(image.segments, segment.pageSize);
      await dfu.flash(blocks, {
        verify,
        onProgress: (progress) => {
          ({ phase, done, total } = progress);
        }
      });

      if (startAfter) {
        phase = 'Starting';
        await dfu.leave(FLASH_BASE);
        dfu = null;
        result = `${image.name} flashed${verify ? ' and verified' : ''}. The new firmware is starting.`;
        resultKind = 'ok';
        await onReconnect();
      } else {
        result = `${image.name} flashed${verify ? ' and verified' : ''}. Reset the board to start it.`;
        resultKind = 'ok';
      }
    } catch (error) {
      result = `Update failed: ${error instanceof Error ? error.message : String(error)} The bootloader is in ROM, so the board can always be put back into DFU mode and flashed again.`;
      resultKind = 'error';
    } finally {
      flashing = false;
      phase = '';
    }
  }

  async function startFirmware() {
    if (!dfu || flashing) {
      return;
    }
    try {
      await dfu.leave(FLASH_BASE);
      dfu = null;
      result = 'Left DFU mode. The firmware is starting.';
      resultKind = 'ok';
      await onReconnect();
    } catch (error) {
      result = error instanceof Error ? error.message : String(error);
      resultKind = 'error';
    }
  }

  /* ------------------------------------------------------------ lifecycle */

  function usbDisconnected(event) {
    if (dfu && event.device === dfu.usb) {
      dfu = null;
      if (flashing) {
        dfuError = 'The DFU device disconnected.';
      }
    }
  }

  function usbConnected() {
    setTimeout(openGranted, 300);
  }

  function beforeUnload(event) {
    if (flashing) {
      event.preventDefault();
      event.returnValue = '';
    }
  }

  onMount(() => {
    if (usbSupported) {
      navigator.usb.addEventListener('disconnect', usbDisconnected);
      navigator.usb.addEventListener('connect', usbConnected);
      openGranted();
    }
    window.addEventListener('beforeunload', beforeUnload);
  });

  onDestroy(() => {
    if (usbSupported) {
      navigator.usb.removeEventListener('disconnect', usbDisconnected);
      navigator.usb.removeEventListener('connect', usbConnected);
    }
    window.removeEventListener('beforeunload', beforeUnload);
    if (!flashing) {
      dfu?.close();
    }
  });

  const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
</script>

<section class="firmware-panel" aria-label="Firmware update">
  <div class="firmware-header">
    <h2>Firmware Update</h2>
    <p>
      Flash new firmware over USB with the STM32's built-in DFU bootloader. Only program flash is
      rewritten; settings, power history and the event log in EEPROM are kept.
    </p>
  </div>

  {#if !usbSupported}
    <p class="firmware-message firmware-message--error">
      WebUSB isn't available in this browser. Use Chrome or Edge on a desktop computer.
    </p>
  {/if}

  <div class="firmware-steps">
    <article class="firmware-step">
      <div class="firmware-step-title"><span class="firmware-step-number">1</span> Enter DFU mode</div>
      <button type="button" class="firmware-button" on:click={enterDfu} disabled={!connected || Boolean(actionBusy) || flashing}>
        {actionBusy === 'Entering DFU' ? 'Restarting…' : 'Enter DFU Mode'}
      </button>
      <p>
        {#if connected}
          Restarts the device into its bootloader. Unsaved changes are lost.
        {:else}
          Connect to the device to do this from here.
        {/if}
      </p>
      <p><strong>Or by hand:</strong> hold <strong>PKEY</strong> while resetting the board, then release it.</p>
      <p class="firmware-muted">
        In DFU mode the firmware isn't running, so charging and output control stop until it restarts.
        The serial port disappears and an <em>STM32 BOOTLOADER</em> USB device appears in its place.
      </p>
    </article>

    <article class="firmware-step">
      <div class="firmware-step-title"><span class="firmware-step-number">2</span> Choose firmware</div>
      <button type="button" class="firmware-button" on:click={chooseFile} disabled={flashing}>Choose File…</button>
      <input class="visually-hidden" type="file" accept=".bin,.hex,.ihex,.ihx" bind:this={fileInput} on:change={fileChosen} />
      {#if image}
        <dl class="firmware-facts">
          <dt>File</dt><dd>{image.name}</dd>
          <dt>Size</dt><dd>{kb(image.size)}</dd>
          <dt>Range</dt><dd>{formatAddress(image.start)} – {formatAddress(image.end - 1)}</dd>
        </dl>
      {:else if imageError}
        <p class="firmware-message firmware-message--error">{imageError}</p>
      {:else}
        <p>A <code>.bin</code> or Intel <code>.hex</code> build of the MeshJuice firmware.</p>
      {/if}
    </article>

    <article class="firmware-step">
      <div class="firmware-step-title"><span class="firmware-step-number">3</span> Flash</div>
      <div class="firmware-row">
        <button type="button" class="firmware-button firmware-button--secondary" on:click={selectDevice} disabled={!usbSupported || flashing || opening}>
          {opening ? 'Opening…' : dfu ? 'Change Device' : 'Select DFU Device'}
        </button>
        <span class="firmware-device" class:ready={dfu}>{dfu ? dfu.name : 'No DFU device'}</span>
      </div>
      {#if dfu}
        <p class="firmware-muted">{dfu.memory.name} · {kb(dfu.memory.segments.reduce((sum, s) => sum + s.end - s.start, 0))} · {dfu.transferSize} B transfers</p>
      {/if}
      {#if dfuError}
        <p class="firmware-message firmware-message--error">{dfuError}</p>
      {/if}

      <label class="firmware-check"><input type="checkbox" bind:checked={verify} disabled={flashing} /> Verify after writing</label>
      <label class="firmware-check"><input type="checkbox" bind:checked={startAfter} disabled={flashing} /> Start the new firmware when done</label>

      <div class="firmware-row">
        <button type="button" class="firmware-button" on:click={flash} disabled={!canFlash}>
          {flashing ? 'Flashing…' : 'Flash Firmware'}
        </button>
        {#if dfu && !flashing}
          <button type="button" class="firmware-button firmware-button--secondary" on:click={startFirmware} title="Leave DFU mode without flashing">
            Exit DFU
          </button>
        {/if}
      </div>

      {#if flashing}
        <div class="firmware-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={percent}>
          <div class="firmware-progress-bar" style={`width: ${percent}%`}></div>
        </div>
        <p class="firmware-muted">{phase}{total ? ` · ${percent}%` : ''}</p>
      {/if}
    </article>
  </div>

  {#if result}
    <p class="firmware-message" class:firmware-message--error={resultKind === 'error'} class:firmware-message--ok={resultKind === 'ok'}>{result}</p>
  {/if}

  <details class="firmware-notes">
    <summary>Troubleshooting</summary>
    <ul>
      <li>
        <strong>Windows:</strong> the browser needs the WinUSB driver for the bootloader. With the board in DFU mode, run
        <a href="https://zadig.akeo.ie/" target="_blank" rel="noreferrer">Zadig</a>, choose <em>STM32 BOOTLOADER</em>
        and install <em>WinUSB</em>. STM32CubeProgrammer's DFU driver blocks WebUSB.
      </li>
      <li><strong>Linux:</strong> add a udev rule giving your user access to USB device <code>0483:df11</code>.</li>
      <li>
        <strong>Without the browser:</strong> <code>dfu-util -a 0 -s 0x08000000:leave -D meshjuice-firmware.bin</code>,
        or STM32CubeProgrammer over USB.
      </li>
      <li>If an update fails part-way, the board won't start, but the bootloader is in ROM: hold PKEY while resetting and flash again.</li>
    </ul>
  </details>
</section>

<style>
  .firmware-panel {
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding: 24px;
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    background: #ffffff;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.04);
  }

  .firmware-header h2 {
    margin: 0 0 4px;
    font-size: 20px;
  }

  .firmware-header p {
    margin: 0;
    color: #828282;
  }

  .firmware-steps {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 20px;
  }

  .firmware-step {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
    padding: 20px 24px;
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    background: #f4f4f4;
  }

  .firmware-step p {
    margin: 0;
    font-size: 14px;
  }

  .firmware-step-title {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 16px;
    font-weight: 600;
    color: #000000;
  }

  .firmware-step-number {
    display: inline-grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: #000000;
    color: #ffffff;
    font-size: 13px;
  }

  .firmware-button {
    border: none;
    border-radius: 8px;
    padding: 10px 16px;
    background: #000000;
    color: #ffffff;
    font-size: 15px;
    font-weight: 600;
  }

  .firmware-button--secondary {
    background: #6b6b6b;
  }

  .firmware-button:disabled {
    opacity: 0.45;
  }

  .firmware-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
  }

  .firmware-device {
    font-size: 14px;
    color: #828282;
  }

  .firmware-device.ready {
    color: #1b7f3b;
    font-weight: 600;
  }

  .firmware-muted {
    color: #828282;
  }

  .firmware-facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 12px;
    margin: 0;
    font-size: 14px;
  }

  .firmware-facts dt {
    color: #828282;
  }

  .firmware-facts dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }

  .firmware-check {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
  }

  .firmware-check input {
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: #000000;
  }

  .firmware-progress {
    width: 100%;
    height: 8px;
    border-radius: 4px;
    background: #e0e0e0;
    overflow: hidden;
  }

  .firmware-progress-bar {
    height: 100%;
    background: #000000;
    transition: width 0.15s linear;
  }

  .firmware-message {
    margin: 0;
    padding: 12px 16px;
    border-radius: 8px;
    background: #f4f4f4;
    font-size: 14px;
  }

  .firmware-message--error {
    background: #fdecea;
    color: #b3261e;
  }

  .firmware-message--ok {
    background: #e7f5ec;
    color: #1b7f3b;
  }

  .firmware-notes {
    font-size: 14px;
    color: #505050;
  }

  .firmware-notes summary {
    cursor: pointer;
    font-weight: 600;
  }

  .firmware-notes li {
    margin: 6px 0;
  }

  code {
    font-size: 13px;
    background: #ececec;
    padding: 1px 4px;
    border-radius: 4px;
  }

  @media (max-width: 1000px) {
    .firmware-steps {
      grid-template-columns: 1fr;
    }
  }
</style>
