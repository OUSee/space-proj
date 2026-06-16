<script
    setup
    lang="ts"
>
import { computed, toRefs } from 'vue';
const props = defineProps<{
    diag: any;
    covTraceHistory: number[];
    velMagHistory: number[];
    biasGyroHistory: number[];
}>();

function renderSparkline(values: number[], width = 360, height = 120): string {
    if (!values || !values.length) return '';
    const minVal = Math.min(...values);
    const maxVal = Math.max(...values);
    const step = width / Math.max(values.length - 1, 1);
    if (Math.abs(maxVal - minVal) < 1e-8) {
        const y = (height / 2).toFixed(1);
        return `M0,${y} L${width.toFixed(1)},${y}`;
    }
    const range = maxVal - minVal;
    return values
        .map((value, index) => {
            const x = index * step;
            const y = height - ((value - minVal) / range) * (height - 12) - 6;
            return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');
}

const latestTrace = computed(() => props.covTraceHistory?.[props.covTraceHistory.length - 1] ?? 0);
const latestVel = computed(() => props.velMagHistory?.[props.velMagHistory.length - 1] ?? 0);
const latestBias = computed(() => props.biasGyroHistory?.[props.biasGyroHistory.length - 1] ?? 0);
</script>

<template>
    <div style="display:grid; gap:12px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
            <div>
                <div style="font-weight:600">AEKF Live Overview</div>
                <div style="font-size:0.9rem; color:#b8d8ff">Last event: {{ diag.lastEvent || '—' }} | Predicts: {{
                    diag.predictCount || 0 }} | Updates: {{ diag.updateCount || 0 }}</div>
            </div>
            <div style="text-align:right">
                <div style="font-size:0.85rem; color:#9fbfdc">Trace</div>
                <div style="font-size:1.2rem; color:#7fffd4">{{ latestTrace.toFixed(1) }}</div>
            </div>
        </div>

        <svg
            width="100%"
            height="140"
            viewBox="0 0 360 140"
            style="background:#02060b; border-radius:8px"
        >
            <rect
                x="0"
                y="0"
                width="360"
                height="140"
                fill="#02060b"
            />
            <path
                :d="renderSparkline(covTraceHistory, 360, 100)"
                fill="none"
                stroke="#7fffd4"
                stroke-width="2"
            />
            <path
                :d="renderSparkline(velMagHistory, 360, 100)"
                fill="none"
                stroke="#ffb800"
                stroke-width="2"
                opacity="0.9"
            />
            <path
                :d="renderSparkline(biasGyroHistory, 360, 100)"
                fill="none"
                stroke="#ff6b6b"
                stroke-width="2"
                opacity="0.8"
            />
        </svg>

        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(180px,1fr)); gap:10px;">
            <div style="padding:10px; background:#07101a; border-radius:8px; border:1px solid #173a56;">
                <div style="font-weight:600">System state</div>
                <div style="font-size:0.9rem; color:#b8d8ff; margin-top:8px">pos: {{diag.statePos ? diag.statePos.map(n
                    => n.toFixed(2)).join(', ') : '–' }}</div>
                <div style="font-size:0.9rem; color:#b8d8ff;">vel: {{diag.stateVel ? diag.stateVel.map(n =>
                    n.toFixed(3)).join(', ') : '–' }}</div>
                <div style="font-size:0.9rem; color:#b8d8ff;">last nis: {{ diag.lastNis ? diag.lastNis.toFixed(2) : '–'
                    }}</div>
            </div>

            <div style="padding:10px; background:#07101a; border-radius:8px; border:1px solid #173a56;">
                <div style="font-weight:600">Matrices (diag)</div>
                <div style="font-size:0.9rem; color:#b8d8ff; margin-top:8px">P diag: {{diag.Pdiag ?
                    diag.Pdiag.slice(0, 6).map(x => x.toFixed(2)).join(', ') : '–' }}</div>
                <div style="font-size:0.9rem; color:#b8d8ff;">Q scale: {{ diag.procNoiseScale?.toFixed ?
                    diag.procNoiseScale.toFixed(2) : '–' }}</div>
            </div>
        </div>
    </div>
</template>

<style scoped>
div {
    color: #dff3ff
}
</style>
