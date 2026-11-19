<script>
  import { onDestroy, onMount, tick } from 'svelte';
  import { transportProblem } from '../lib/device.js';
  import { editUnit, formatDuration } from '../lib/format.js';

  /** @type {import('../lib/device.js').Device} */
  export let device;
  /** { key, label, unit } */
  export let field;
  export let onClose = () => {};
  /** Called after the firmware accepted a new value. */
  export let onApplied = (_key, _value) => {};

  let info = null;              // { current, default, min, max, step, options }
  let loadError = '';
  let draft = '';
  let inputElement;

  // Validity of `draft` according to the firmware
  let validity = 'pending';     // pending | checking | valid | invalid | unchecked
  let validityMessage = '';
  let checkTimer = null;
  let checkSeq = 0;

  let applying = false;
  let applyError = '';

  $: unit = editUnit(field.unit);
  $: isOptions = Boolean(info?.options?.length);
  $: canStep = Boolean(info && !isOptions && info.step && info.min !== '' && info.max !== '');
  $: canApply = Boolean(info) && !applying && (validity === 'valid' || validity === 'unchecked');

  onMount(async () => {
    try {
      info = await device.fieldInfo(field.key);
      setDraft(info.current);
      await tick();
      inputElement?.focus();
      inputElement?.select();
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    }
  });

  onDestroy(() => clearTimeout(checkTimer));

  function setDraft(value) {
    draft = String(value ?? '');
    applyError = '';
    scheduleCheck(0);
  }

  function onInput() {
    applyError = '';
    scheduleCheck(250);
  }

  function scheduleCheck(delay) {
    clearTimeout(checkTimer);
    validity = 'checking';
    validityMessage = '';
    checkTimer = setTimeout(checkDraft, delay);
  }

  async function checkDraft() {
    const value = draft.trim();
    const seq = ++checkSeq;

    const problem = transportProblem(value);
    if (problem) {
      validity = 'invalid';
      validityMessage = problem;
      return;
    }

    try {
      const result = await device.valid(field.key, value);
      if (seq !== checkSeq) {
        return;     // superseded by a newer edit
      }
      if (result === null) {
        validity = 'unchecked';
        validityMessage = 'The device checks values containing spaces when you apply.';
      } else if (result) {
        validity = 'valid';
        validityMessage = 'Accepted by the device.';
      } else {
        validity = 'invalid';
        validityMessage = value === '' ? 'Enter a value.' : 'Rejected by the device: out of range, not a multiple of the step, or conflicts with a related setting.';
      }
    } catch (error) {
      if (seq === checkSeq) {
        validity = 'invalid';
        validityMessage = error instanceof Error ? error.message : String(error);
      }
    }
  }

  /** Decimal places in a value string such as "0.050" */
  function decimals(text) {
    const match = /\.(\d+)/.exec(String(text ?? ''));
    return match ? match[1].length : 0;
  }

  /** Move by one firmware step, snapped to the firmware's min + n*step grid and kept within min..max. */
  function stepBy(direction) {
    if (!canStep) {
      return;
    }
    const places = Math.max(decimals(info.step), decimals(info.min), decimals(info.max));
    const scale = 10 ** places;
    const toInt = (text) => Math.round(Number(text) * scale);

    const min = toInt(info.min);
    const max = toInt(info.max);
    const step = toInt(info.step);
    const parsed = Number(draft);
    const current = Number.isFinite(parsed) && draft.trim() !== '' ? toInt(draft) : toInt(info.current);

    // On the grid: move one step. Off the grid: move to the next grid value in that direction.
    const exact = (current - min) / step;
    const index = Number.isInteger(exact) ? exact + direction : direction > 0 ? Math.ceil(exact) : Math.floor(exact);
    let next = min + index * step;
    next = Math.min(max, Math.max(min, next));

    setDraft((next / scale).toFixed(places));
  }

  async function apply() {
    if (!canApply) {
      return;
    }
    applying = true;
    applyError = '';
    const value = draft.trim();
    try {
      const result = await device.assign({ [field.key]: value });
      if (result.ok) {
        onApplied(field.key, value);
        onClose();
        return;
      }
      validity = 'invalid';
      applyError = 'The device rejected this value. Adjust it or cancel.';
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
    } else if (event.key === 'Enter' && event.target === inputElement) {
      event.preventDefault();
      apply();
    } else if (event.key === 'ArrowUp' && canStep) {
      event.preventDefault();
      stepBy(1);
    } else if (event.key === 'ArrowDown' && canStep) {
      event.preventDefault();
      stepBy(-1);
    }
  }

  const metaItems = [
    { key: 'current', label: 'Current' },
    { key: 'default', label: 'Default' },
    { key: 'min', label: 'Min' },
    { key: 'max', label: 'Max' }
  ];

  // Enum (option) fields have no numeric range: their choices are the option buttons
  $: visibleMetaItems = isOptions ? metaItems.filter((item) => item.key === 'current' || item.key === 'default') : metaItems;

  function metaText(key) {
    const value = info?.[key];
    if (value === undefined || value === '') {
      return '—';
    }
    return unit ? `${value} ${unit}` : value;
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="editor-overlay" role="presentation" on:click={onClose}>
  <div class="editor-dialog" role="dialog" aria-modal="true" aria-labelledby="editor-title" tabindex="-1" on:click|stopPropagation on:keydown|stopPropagation={onKeydown}>
    <div class="editor-title" id="editor-title">EDIT {field.label.toUpperCase()}</div>
    <div class="editor-key">{field.key}</div>

    {#if loadError}
      <p class="editor-validation-message">{loadError}</p>
      <div class="editor-actions">
        <button class="editor-action editor-action--secondary" type="button" on:click={onClose}>Close</button>
      </div>
    {:else if !info}
      <p class="editor-loading">Reading limits from the device…</p>
    {:else}
      {#if isOptions}
        <div class="editor-options" role="radiogroup" aria-label="Choices reported by the device">
          {#each info.options as option}
            <button
              type="button"
              role="radio"
              aria-checked={draft === option}
              class="editor-option"
              class:selected={draft === option}
              on:click={() => setDraft(option)}
            >
              {unit ? `${option} ${unit}` : option}
            </button>
          {/each}
        </div>
      {:else}
        <div class="editor-stepper" aria-label="Adjust value">
          <button class="editor-stepper-button" type="button" on:click={() => stepBy(-1)} disabled={!canStep} aria-label="Decrease">−</button>
          <div class="editor-value-box" class:invalid={validity === 'invalid'} class:valid={validity === 'valid'}>
            <input
              class="editor-input"
              type="text"
              spellcheck="false"
              autocomplete="off"
              bind:this={inputElement}
              bind:value={draft}
              on:input={onInput}
            />
            {#if unit}<span class="editor-unit">{unit}</span>{/if}
          </div>
          <button class="editor-stepper-button" type="button" on:click={() => stepBy(1)} disabled={!canStep} aria-label="Increase">+</button>
        </div>
        {#if field.unit === 'duration' && draft.trim() !== '' && Number.isFinite(Number(draft))}
          <p class="editor-hint">{formatDuration(draft)}</p>
        {/if}
        {#if info.step}
          <p class="editor-hint">Step {info.step}{unit ? ` ${unit}` : ''}</p>
        {/if}
      {/if}

      <div class="editor-meta">
        {#each visibleMetaItems as item}
          <div class="editor-meta-item">
            <span>{item.label}</span>
            <button
              class="editor-meta-value"
              type="button"
              title={info[item.key] ? `Use ${item.label.toLowerCase()} value` : ''}
              disabled={!info[item.key]}
              on:click={() => setDraft(info[item.key])}
            >
              {metaText(item.key)}
            </button>
          </div>
        {/each}
      </div>

      <p
        class="editor-validation-message"
        class:ok={validity === 'valid'}
        class:neutral={validity === 'checking' || validity === 'unchecked'}
        aria-live="polite"
      >
        {#if applyError}
          {applyError}
        {:else if validity === 'checking'}
          Checking with the device…
        {:else}
          {validityMessage}
        {/if}
      </p>

      <div class="editor-actions">
        <button class="editor-action editor-action--secondary" type="button" on:click={onClose}>Cancel</button>
        <button
          class="editor-action editor-action--ghost"
          type="button"
          on:click={() => setDraft(info.default)}
          disabled={info.default === ''}
          title="Set the draft to the firmware default"
        >
          Default
        </button>
        <button class="editor-action editor-action--primary" type="button" on:click={apply} disabled={!canApply}>
          {applying ? 'Applying…' : 'Apply'}
        </button>
      </div>
    {/if}
  </div>
</div>
