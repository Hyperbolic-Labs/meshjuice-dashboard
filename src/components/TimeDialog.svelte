<script>
  import { onDestroy, onMount } from 'svelte';
  import { transportProblem } from '../lib/device.js';
  import { deviceTimeString } from '../lib/format.js';

  /** @type {import('../lib/device.js').Device} */
  export let device;
  export let onClose = () => {};
  export let onApplied = (_time) => {};

  let deviceTime = '';
  let draft = '';
  let loadError = '';
  let applying = false;
  let applyError = '';
  let pollTimer = null;
  let pcTime = deviceTimeString();
  let pcTimer = null;

  onMount(async () => {
    try {
      deviceTime = await device.time();
      draft = deviceTime;
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
      return;
    }
    pollTimer = setInterval(async () => {
      if (device.link.busy) {
        return;
      }
      try {
        deviceTime = await device.time();
      } catch (error) {
        // keep the last reading
      }
    }, 1000);
    pcTimer = setInterval(() => (pcTime = deviceTimeString()), 500);
  });

  onDestroy(() => {
    clearInterval(pollTimer);
    clearInterval(pcTimer);
  });

  $: problem = transportProblem(draft.trim());
  $: canApply = !applying && draft.trim() !== '' && !problem;

  async function apply() {
    // Checked directly (not via `canApply`) because Sync to PC sets the draft and applies in one step
    if (applying || draft.trim() === '' || transportProblem(draft.trim())) {
      return;
    }
    applying = true;
    applyError = '';
    try {
      if (await device.setTime(draft)) {
        onApplied(draft.trim());
        onClose();
        return;
      }
      applyError = 'Rejected by the device. Use YYYY-MM-DD HH:MM:SS (24 hour).';
    } catch (error) {
      applyError = error instanceof Error ? error.message : String(error);
    } finally {
      applying = false;
    }
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      apply();
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="editor-overlay" role="presentation" on:click={onClose}>
  <div class="editor-dialog" role="dialog" aria-modal="true" aria-labelledby="time-title" tabindex="-1" on:click|stopPropagation on:keydown|stopPropagation={onKeydown}>
    <div class="editor-title" id="time-title">EDIT RTC DATE/TIME</div>
    <div class="editor-key">time</div>

    {#if loadError}
      <p class="editor-validation-message">{loadError}</p>
      <div class="editor-actions">
        <button class="editor-action editor-action--secondary" type="button" on:click={onClose}>Close</button>
      </div>
    {:else if !deviceTime}
      <p class="editor-loading">Reading the clock…</p>
    {:else}
      <div class="editor-stepper">
        <div class="editor-value-box editor-value-box--wide">
          <input class="editor-input" type="text" spellcheck="false" autocomplete="off" bind:value={draft} on:input={() => (applyError = '')} />
        </div>
      </div>
      <p class="editor-hint">YYYY-MM-DD HH:MM:SS, 24 hour</p>

      <div class="editor-meta">
        <div class="editor-meta-item">
          <span>Device</span>
          <button class="editor-meta-value" type="button" on:click={() => (draft = deviceTime)}>{deviceTime}</button>
        </div>
        <div class="editor-meta-item">
          <span>This computer</span>
          <button class="editor-meta-value" type="button" on:click={() => (draft = deviceTimeString())}>{pcTime}</button>
        </div>
      </div>

      <p class="editor-validation-message" aria-live="polite">{applyError || problem || ''}</p>

      <div class="editor-actions">
        <button class="editor-action editor-action--secondary" type="button" on:click={onClose}>Cancel</button>
        <button
          class="editor-action editor-action--ghost"
          type="button"
          disabled={applying}
          title="Set the device clock to this computer's time now"
          on:click={() => {
            draft = deviceTimeString();
            apply();
          }}
        >
          Sync to PC
        </button>
        <button class="editor-action editor-action--primary" type="button" on:click={apply} disabled={!canApply}>
          {applying ? 'Applying…' : 'Apply'}
        </button>
      </div>
    {/if}
  </div>
</div>
