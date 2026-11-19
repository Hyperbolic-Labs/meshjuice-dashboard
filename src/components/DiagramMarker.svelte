<script>
  import { DIAGRAM_VIEWBOX } from '../lib/diagram.js';

  /** Current position { x, y } in diagram units, or null to hide */
  export let point = null;
  /** Earlier positions, oldest first */
  export let trail = [];
  /** Text next to the marker */
  export let label = '';

  $: trailPoints = trail.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  // Keep the label inside the drawing
  $: labelLeft = point && point.x > DIAGRAM_VIEWBOX.width - 260;
  $: labelAbove = point && point.y > 200;
</script>

<svg class="diagram-marker-layer" viewBox={`0 0 ${DIAGRAM_VIEWBOX.width} ${DIAGRAM_VIEWBOX.height}`} aria-hidden={!point}>
  {#if trail.length > 1}
    <polyline class="diagram-trail" points={trailPoints} />
  {/if}
  {#if point}
    <g role="img" aria-label={`Battery now: ${label}`}>
      <circle class="diagram-marker-halo" cx={point.x} cy={point.y} r="14" />
      <circle class="diagram-marker" cx={point.x} cy={point.y} r="7" />
      <text
        class="diagram-marker-label"
        x={point.x + (labelLeft ? -16 : 16)}
        y={point.y + (labelAbove ? -14 : 24)}
        text-anchor={labelLeft ? 'end' : 'start'}
      >
        {label}
      </text>
    </g>
  {/if}
</svg>
