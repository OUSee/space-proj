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

const history = computed(() => (props.diag && props.diag.history) ? props.diag.history : []);
const latest = computed(() => history.value.length ? history.value[history.value.length - 1] : {});

function sliceMatrix(mat: number[][], maxN = 8) {
    if (!mat || !mat.length) return [];
    const n = Math.min(maxN, mat.length);
    const out: number[][] = [];
    for (let i = 0; i < n; i++) {
        out.push(mat[i]!.slice(0, n));
    }
    return out;
}

function matrixStats(mat: number[][]) {
    let min = Infinity, max = -Infinity;
    for (const row of mat) for (const v of row) { if (v < min) min = v; if (v > max) max = v; }
    if (min === Infinity) { min = 0; max = 0; }
    return { min, max };
}

function heatColor(norm: number) {
    // norm in [0..1] -> blue->green->red
    const r = Math.round(Math.min(255, Math.max(0, 255 * norm)));
    const g = Math.round(Math.min(200, Math.max(0, 200 * (1 - Math.abs(norm - 0.5) * 2))));
    const b = Math.round(Math.min(200, Math.max(0, 200 * (1 - norm))));
    return `rgb(${r},${g},${b})`;
}

const Pmatrix = computed(() => sliceMatrix(latest.value.P || [], 8));
const Qmatrix = computed(() => sliceMatrix(latest.value.Q || [], 8));

const Pstats = computed(() => matrixStats(Pmatrix.value));
const Qstats = computed(() => matrixStats(Qmatrix.value));

const timeline = computed(() => {
    const recent = history.value.slice(-120);
    return recent.map((d: any) => ({ event: d.event || 'tick', t: d.t || 0 }));
});
const tl = computed(() => timeline.value.slice(-120));

const nisVals = computed(() => history.value.map((d: any) => d.nis).filter((v: any) => typeof v === 'number'));
</script>

<template>
    <div style="display:grid; gap:12px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
            <div>
                <div style="font-weight:600">AEKF Live Overview</div>
                <div style="font-size:0.9rem; color:#b8d8ff">Last event: {{ diag?.lastEvent || '—' }} | Predicts: {{
                    diag?.predictCount || 0 }} | Updates: {{ diag?.updateCount || 0 }}</div>
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
                <div style="font-weight:600">P matrix (8x8)</div>
                <div style="margin-top:8px;">
                    <svg
                        width="180"
                        height="180"
                        viewBox="0 0 80 80"
                    >
                        <rect
                            x="0"
                            y="0"
                            width="80"
                            height="80"
                            fill="#07101a"
                        />
                        <g>
                            <template
                                v-for="(row, rIndex) in Pmatrix"
                                :key="'prow' + rIndex"
                            >
                                <template
                                    v-for="(val, cIndex) in row"
                                    :key="'pcell' + rIndex + '-' + cIndex"
                                >
                                    <rect
                                        :x="cIndex * 9"
                                        :y="rIndex * 9"
                                        width="9"
                                        height="9"
                                        :fill="(Pstats.max > Pstats.min) ? heatColor((val - Pstats.min) / (Pstats.max - Pstats.min)) : '#123'"
                                        stroke="#0b2b3a"
                                        stroke-width="0.3"
                                    />
                                </template>
                            </template>
                        </g>
                    </svg>
                </div>
            </div>

            <div style="padding:10px; background:#07101a; border-radius:8px; border:1px solid #173a56;">
                <div style="font-weight:600">Q matrix (8x8)</div>
                <div style="margin-top:8px;">
                    <svg
                        width="180"
                        height="180"
                        viewBox="0 0 80 80"
                    >
                        <rect
                            x="0"
                            y="0"
                            width="80"
                            height="80"
                            fill="#07101a"
                        />
                        <g>
                            <template
                                v-for="(row, rIndex) in Qmatrix"
                                :key="'qrow' + rIndex"
                            >
                                <template
                                    v-for="(val, cIndex) in row"
                                    :key="'qcell' + rIndex + '-' + cIndex"
                                >
                                    <rect
                                        :x="cIndex * 9"
                                        :y="rIndex * 9"
                                        width="9"
                                        height="9"
                                        :fill="(Qstats.max > Qstats.min) ? heatColor((val - Qstats.min) / (Qstats.max - Qstats.min)) : '#123'"
                                        stroke="#0b2b3a"
                                        stroke-width="0.3"
                                    />
                                </template>
                            </template>
                        </g>
                    </svg>
                </div>
            </div>

            <div style="padding:10px; background:#07101a; border-radius:8px; border:1px solid #173a56;">
                <div style="font-weight:600">Event timeline & NIS</div>
                <div style="margin-top:8px">
                    <svg
                        width="360"
                        height="28"
                        viewBox="0 0 360 28"
                    >
                        <rect
                            x="0"
                            y="0"
                            width="360"
                            height="28"
                            fill="#07101a"
                        />
                        <g>
                            <template
                                v-for="(t, idx) in tl"
                                :key="'tl' + idx"
                            >
                                <rect
                                    :x="(idx * (360 / Math.max(1, tl.length)))"
                                    y="0"
                                    :width="Math.max(1, 360 / Math.max(1, tl.length))"
                                    height="28"
                                    :fill="t.event === 'predict' ? '#2ecc71' : (t.event === 'updatePosition' ? '#3498db' : (t.event === 'updateVelocity' ? '#f39c12' : '#555'))"
                                    opacity="0.9"
                                />
                            </template>
                        </g>
                    </svg>
                    <div style="height:8px"></div>
                    <svg
                        width="360"
                        height="60"
                        viewBox="0 0 360 60"
                        style="background:#02060b; border-radius:6px"
                    >
                        <rect
                            x="0"
                            y="0"
                            width="360"
                            height="60"
                            fill="#02060b"
                        />
                        <g>
                            <template
                                v-for="(v, i) in nisVals.slice(-40)"
                                :key="'nis' + i"
                            >
                                <rect
                                    :x="i * (360 / 40)"
                                    :y="60 - (Math.min(1, v / 50) * 50)"
                                    :width="(360 / 40) - 2"
                                    :height="Math.min(60, (Math.min(1, v / 50) * 50))"
                                    :fill="v > 16 ? '#ff6b6b' : '#7fffd4'"
                                    opacity="0.9"
                                />
                            </template>
                        </g>
                    </svg>
                </div>
            </div>

            <div style="padding:10px; background:#07101a; border-radius:8px; border:1px solid #173a56;">
                <div style="font-weight:600">System state</div>
                <div style="font-size:0.9rem; color:#b8d8ff; margin-top:8px">pos:
                    {{diag?.statePos ?
                        diag.statePos.map(n => n.toFixed(2)).join(', ')
                        : '–'}}
                </div>
                <div style="font-size:0.9rem; color:#b8d8ff;">vel:
                    {{diag?.stateVel ?
                        diag.stateVel.map(n => n.toFixed(3)).join(', ')
                        : '–'}}
                </div>
                <div style="font-size:0.9rem; color:#b8d8ff;">last nis:
                    {{ diag?.lastNis ? diag.lastNis.toFixed(2) : '–' }}
                </div>
            </div>

            <div style="padding:10px; background:#07101a; border-radius:8px; border:1px solid #173a56;">
                <div style="font-weight:600">Matrices (diag)</div>
                <div style="font-size:0.9rem; color:#b8d8ff; margin-top:8px">P diag: {{diag.Pdiag ?
                    diag.Pdiag.slice(0, 6).map(x => x.toFixed(2)).join(', ') : '–'}}</div>
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
