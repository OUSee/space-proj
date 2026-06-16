<script
    setup
    lang="ts"
>
import { onMounted, ref, computed, watch, nextTick } from 'vue';
import { AEKFFilter } from '~/core/aekf';
import { MatrixUtils } from '~/core/matrix';
import { useGeolocation } from '@vueuse/core';
import { enuToGeodetic, geodeticToEnu, haversineDistance } from '~/core/geo';
import type { IMUData, StateVector } from '~/types';
import type { LatLngExpression, Map as LeafletMap, Marker, Polyline } from 'leaflet';

// ----------------------------- Reactive state -----------------------------
const status = ref('Initializing...');
const orientationGranted = ref(false);
const gyroGranted = ref(false);
const geoGranted = ref(false);
const show3D = ref(false);
const isCalibrating = ref(false);
const calibrationCompleted = ref(false);
const calibrationData = ref<{ accelMean: number[]; gyroMean: number[] } | null>(null);
const info_phone = ref<any>(null);
const info_waccel = ref<any>(null);
const info_laccel = ref<any>(null);
const info_gbody = ref<any>(null);
const info_abody = ref<any>(null);

let filterInstance: AEKFFilter | null = null;

const latestIMU = ref<IMUData>({ accel: [0, 0, 0], gyro: [0, 0, 0], ts: 0 });
const latestGPS = ref<{ lat: number; lon: number; alt: number; accuracy: number; ts: number } | null>(null);
const currentRawEnu = ref<[number, number, number] | null>(null);
const currentFilteredLatLng = ref<{ lat: number; lon: number; alt: number } | null>(null);
const showFiltered = ref(true);
const mapFollowMode = ref<'filtered' | 'raw' | 'both'>('both');
const recording = ref(false);
const trackPoints = ref<Array<{ lat: number; lon: number; ts: number }>>([]);
const rawTrackPoints = ref<Array<{ lat: number; lon: number; ts: number }>>([]);
const xest = ref<StateVector>({
    pos: [0, 0, 0],
    vel: [0, 0, 0],
    att: [0, 0, 0],
    biasAcc: [0, 0, 0],
    biasGyro: [0, 0, 0],
});
const diagnostics = ref<{
    covTrace: number | null;
    velMag: number;
    isStationary: boolean;
    biasAccMag: number;
    biasGyroMag: number;
} | null>(null);
const trajectory = ref<number[][]>([]);
const covTraceHistory = ref<number[]>([]);
const velMagHistory = ref<number[]>([]);
const biasGyroHistory = ref<number[]>([]);
const viewTab = ref<'metrics' | 'aekf'>('metrics');
const frameCount = ref(0);
const lastFrameTime = ref(performance.now());
const mapEl = ref<HTMLDivElement | null>(null);
const mapReady = ref(false);
const filterHasGpsFix = ref(false);
let map: LeafletMap | null = null;
let rawMarker: Marker | null = null;
let filteredMarker: Marker | null = null;
let rawLine: Polyline | null = null;
let filteredLine: Polyline | null = null;
let mapInitialized = false;

const fps = computed(() => {
    const now = performance.now();
    const delta = now - lastFrameTime.value;
    return delta > 0 ? (1000 / delta).toFixed(1) : '0';
});

const rmse = computed(() => {
    if (trajectory.value.length < 2) return 0;
    let sum = 0;
    for (const pos of trajectory.value) {
        if (pos && pos.length >= 3 && pos[0] !== undefined && pos[1] !== undefined && pos[2] !== undefined) {
            sum += pos[0] * pos[0] + pos[1] * pos[1] + pos[2] * pos[2];
        }
    }
    return Math.sqrt(sum / trajectory.value.length).toFixed(3);
});

const filteredDistance = computed(() => {
    let total = 0;
    for (let i = 1; i < trackPoints.value.length; i++) {
        const prev = trackPoints.value[i - 1];
        const next = trackPoints.value[i];
        total += haversineDistance(prev.lat, prev.lon, next.lat, next.lon);
    }
    return total;
});

const currentSpeed = computed(() => {
    const [x, y, z] = xest.value.vel;
    return Math.sqrt(x * x + y * y + z * z);
});

const activePosition = computed(() => {
    if (showFiltered.value && currentFilteredLatLng.value) {
        return currentFilteredLatLng.value;
    }
    return latestGPS.value;
});

const positionLabel = computed(() => {
    if (!activePosition.value) return 'No fix';
    return `${activePosition.value.lat.toFixed(5)}, ${activePosition.value.lon.toFixed(5)}`;
});

const recordingLabel = computed(() => (recording.value ? 'Stop Recording' : 'Start Recording'));

// ----------------------------- GPS (VueUse) -----------------------------
const { coords, error } = useGeolocation({
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 5000,
});

watch(error, (err) => {
    if (err) {
        geoGranted.value = false;
        status.value = `⚠️ GPS error: ${err.message}`;
    }
});

// GPS to ENU conversion (reference point set on first fix)
let refLat = 0,
    refLon = 0,
    refAlt = 0;
let refSet = false;

function setGpsReference(lat: number, lon: number, alt: number) {
    refLat = lat;
    refLon = lon;
    refAlt = alt;
    refSet = true;
    status.value = `Reference set: ${refLat.toFixed(5)}, ${refLon.toFixed(5)}`;
}

async function initMap() {
    if (mapInitialized || !mapEl.value) return;
    const L = await import('leaflet');
    await import('leaflet/dist/leaflet.css');

    map = L.map(mapEl.value, {
        zoomControl: true,
        minZoom: 3,
        maxZoom: 19,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);

    rawLine = L.polyline([], { color: '#33d9ff', weight: 3, opacity: 0.7 }).addTo(map);
    filteredLine = L.polyline([], { color: '#a0ff4d', weight: 4, opacity: 0.9 }).addTo(map);
    rawMarker = L.circleMarker([0, 0], {
        radius: 6,
        color: '#33d9ff',
        fillColor: '#33d9ff',
        fillOpacity: 0.8,
    }).addTo(map);
    filteredMarker = L.circleMarker([0, 0], {
        radius: 8,
        color: '#a0ff4d',
        fillColor: '#a0ff4d',
        fillOpacity: 0.8,
    }).addTo(map);

    mapInitialized = true;
    mapReady.value = true;

    // Critical: force Leaflet to recalculate container size (very common cause of blank maps)
    setTimeout(() => {
        if (map) {
            map.invalidateSize();
            // Optional: set a default view if we have no GPS yet
            if (latestGPS.value) {
                map.setView([latestGPS.value.lat, latestGPS.value.lon], 16);
            } else {
                map.setView([51.65172, 39.17852], 12); // fallback (e.g. your city)
            }
        }
    }, 120);
}

watch(showFiltered, (value) => {
    if (filteredMarker) {
        filteredMarker.setStyle({ opacity: value ? 0.9 : 0, fillOpacity: value ? 0.8 : 0 });
    }
    if (filteredLine) {
        filteredLine.setStyle({ opacity: value ? 0.9 : 0 });
    }
});

function updateMapView(rawLat: number, rawLon: number, filtered?: { lat: number; lon: number }) {
    if (!map) return;
    if (rawMarker) rawMarker.setLatLng([rawLat, rawLon]);
    if (filtered && filteredMarker) filteredMarker.setLatLng([filtered.lat, filtered.lon]);

    // Choose how the map follows position based on user preference
    if (mapFollowMode.value === 'filtered' && filtered) {
        if (!recording.value) map.setView([filtered.lat, filtered.lon], 17, { animate: false });
        else map.panTo([filtered.lat, filtered.lon], { animate: false });
        return;
    }

    if (mapFollowMode.value === 'raw') {
        if (!recording.value) map.setView([rawLat, rawLon], 17, { animate: false });
        else map.panTo([rawLat, rawLon], { animate: false });
        return;
    }

    // both: try to fit bounds of raw+filtered if available, otherwise fallback to filtered/raw
    if (mapFollowMode.value === 'both' && filtered) {
        // fit bounds to show both raw and filtered positions
        try {
            map.fitBounds([
                [rawLat, rawLon],
                [filtered.lat, filtered.lon],
            ], { animate: false, padding: [30, 30] });
        } catch (e) {
            if (!recording.value) map.setView([filtered.lat, filtered.lon], 17, { animate: false });
            else map.panTo([filtered.lat, filtered.lon], { animate: false });
        }
        return;
    }

    // fallback
    if (filtered) {
        if (!recording.value) map.setView([filtered.lat, filtered.lon], 17, { animate: false });
        else map.panTo([filtered.lat, filtered.lon], { animate: false });
    } else {
        if (!recording.value) map.setView([rawLat, rawLon], 17, { animate: false });
        else map.panTo([rawLat, rawLon], { animate: false });
    }
}

function appendTrackPoint(point: { lat: number; lon: number }) {
    if (!recording.value) return;
    const last = trackPoints.value[trackPoints.value.length - 1];
    if (last && haversineDistance(last.lat, last.lon, point.lat, point.lon) < 1) return;
    trackPoints.value.push({ ...point, ts: Date.now() });
    if (trackPoints.value.length > 5000) trackPoints.value.shift();
    filteredLine?.addLatLng([point.lat, point.lon]);
}

function appendRawPoint(lat: number, lon: number) {
    rawTrackPoints.value.push({ lat, lon, ts: Date.now() });
    if (rawTrackPoints.value.length > 5000) rawTrackPoints.value.shift();
    rawLine?.addLatLng([lat, lon]);
}

function startRecording() {
    // Ensure map is ready before starting recording
    if (!mapReady.value) {
        status.value = '⏳ Waiting for map to load...';
        const unwatch = watch(mapReady, (v) => {
            if (v) {
                unwatch();
                recording.value = true;
                status.value = '🟢 Recording route';
            }
        });
        return;
    }
    recording.value = true;
    status.value = '🟢 Recording route';
}

function stopRecording() {
    recording.value = false;
    status.value = '🟡 Recording paused';
}

function clearTrack() {
    trackPoints.value = [];
    if (filteredLine) filteredLine.setLatLngs([]);
    status.value = '🧹 Track cleared';
}

function toggleRecording() {
    if (recording.value) stopRecording();
    else startRecording();
}

watch(
    () => coords.value,
    (c) => {
        if (!c) return;

        if (!refSet && c.latitude !== undefined && c.longitude !== undefined) {
            setGpsReference(c.latitude, c.longitude, c.altitude ?? 0);
        }

        if (c.latitude === undefined || c.longitude === undefined) {
            return;
        }

        const enu = geodeticToEnu(c.latitude, c.longitude, c.altitude ?? 0, refLat, refLon, refAlt);
        currentRawEnu.value = enu;
        latestGPS.value = {
            lat: c.latitude,
            lon: c.longitude,
            alt: c.altitude ?? 0,
            accuracy: c.accuracy ?? 30,
            ts: Date.now(),
        };

        appendRawPoint(c.latitude, c.longitude);

        const accHor = Math.max(c.accuracy ?? 5.0, 5.0);
        const R_pos = [
            [accHor ** 2, 0, 0],
            [0, accHor ** 2, 0],
            [0, 0, 10.0],
        ];

        if (!filterInstance && calibrationCompleted.value && latestGPS.value && refSet) {
            initFilter();
        }

        if (filterInstance) {
            filterInstance.updatePosition(enu, R_pos);
            filterHasGpsFix.value = true;
            if (refSet) {
                const filteredGeo = enuToGeodetic(
                    filterInstance.getPosition()[0],
                    filterInstance.getPosition()[1],
                    filterInstance.getPosition()[2],
                    refLat,
                    refLon,
                    refAlt,
                );
                currentFilteredLatLng.value = filteredGeo;
                if (recording.value) appendTrackPoint(filteredGeo);
                updateMapView(c.latitude, c.longitude, filteredGeo);
                // Diagnostics: refresh UI metrics after every GPS position update too.
                const vel = filterInstance.getVelocity();
                diagnostics.value = {
                    covTrace: filterInstance.getCovarianceTrace(),
                    velMag: Math.sqrt(vel[0] ** 2 + vel[1] ** 2 + vel[2] ** 2),
                    isStationary: false,
                    biasAccMag: Math.sqrt(
                        filterInstance.getBiasAcc()[0] ** 2 +
                        filterInstance.getBiasAcc()[1] ** 2 +
                        filterInstance.getBiasAcc()[2] ** 2,
                    ),
                    biasGyroMag: Math.sqrt(
                        filterInstance.getBiasGyro()[0] ** 2 +
                        filterInstance.getBiasGyro()[1] ** 2 +
                        filterInstance.getBiasGyro()[2] ** 2,
                    ),
                };
                // Diagnostics: log GPS vs filtered occasionally
                console.log('GPS update', { raw: { lat: c.latitude, lon: c.longitude, acc: c.accuracy }, filtered: filteredGeo });
            }
        } else {
            // Show raw GPS location even before the filter is initialized
            updateMapView(c.latitude, c.longitude);
        }

        geoGranted.value = true;
        status.value = `GPS update: ${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)} | acc ${(
            c.accuracy ?? 0
        ).toFixed(1)} m`;
    },
);

async function calibrateSensors(): Promise<void> {
    isCalibrating.value = true;
    status.value = '📱 Calibrating – keep phone still on a flat surface...';
    const accelSamples: number[][] = [];
    const gyroSamples: number[][] = [];

    return new Promise((resolve) => {
        const startTime = performance.now();
        const handler = (e: DeviceMotionEvent) => {
            const now = performance.now();
            if (now - startTime > 2000) {
                window.removeEventListener('devicemotion', handler);
                const accelMean = accelSamples.length
                    ? accelSamples.reduce((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]])
                        .map((v) => v / accelSamples.length)
                    : [0, 0, 0];
                const gyroMean = gyroSamples.length
                    ? gyroSamples.reduce((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]])
                        .map((v) => v / gyroSamples.length)
                    : [0, 0, 0];
                calibrationData.value = { accelMean, gyroMean };
                // mark calibration finished and clear the calibrating flag so IMU processing resumes
                calibrationCompleted.value = true;
                isCalibrating.value = false;
                if (latestGPS.value && refSet) {
                    status.value = '✅ Calibration done. Starting filter with GPS fix...';
                    initFilter();
                } else {
                    status.value = '✅ Calibration done. Waiting for GPS fix before starting filter...';
                }
                resolve();
                return;
            }
            if (e.accelerationIncludingGravity) {
                accelSamples.push([
                    e.accelerationIncludingGravity.x || 0,
                    e.accelerationIncludingGravity.y || 0,
                    e.accelerationIncludingGravity.z || 0,
                ]);
            } else if (e.acceleration) {
                accelSamples.push([
                    e.acceleration.x || 0,
                    e.acceleration.y || 0,
                    e.acceleration.z || 0,
                ]);
            }
            if (e.rotationRate) {
                gyroSamples.push([
                    (e.rotationRate.alpha || 0) * Math.PI / 180,
                    (e.rotationRate.beta || 0) * Math.PI / 180,
                    (e.rotationRate.gamma || 0) * Math.PI / 180,
                ]);
            }
        };
        window.addEventListener('devicemotion', handler);
    });
}

function initFilter() {
    const initialX = new Array(16).fill(0);
    initialX[6] = 1.0; // identity quaternion
    if (calibrationData.value) {
        initialX[10] = calibrationData.value.accelMean[0]!;
        initialX[11] = calibrationData.value.accelMean[1]!;
        initialX[12] = calibrationData.value.accelMean[2]! - 9.81;
        initialX[13] = calibrationData.value.gyroMean[0]!;
        initialX[14] = calibrationData.value.gyroMean[1]!;
        initialX[15] = calibrationData.value.gyroMean[2]!;
        console.log('Calibration data:', {
            accelMean: calibrationData.value.accelMean,
            gyroMean: calibrationData.value.gyroMean,
            initialBiasAcc: [initialX[10], initialX[11], initialX[12]],
            initialBiasGyro: [initialX[13], initialX[14], initialX[15]],
        });
    }
    if (latestGPS.value && refSet) {
        const initialPos = geodeticToEnu(
            latestGPS.value.lat,
            latestGPS.value.lon,
            latestGPS.value.alt,
            refLat,
            refLon,
            refAlt,
        );
        initialX[0] = initialPos[0];
        initialX[1] = initialPos[1];
        initialX[2] = initialPos[2];
        currentFilteredLatLng.value = latestGPS.value;
        filterHasGpsFix.value = true;
        console.log('Initial filter position set from GPS:', initialPos, latestGPS.value);
    }
    const initialP = MatrixUtils.eye(16).map((row) => row.map(() => 1.0));
    // Increased Q to reduce trust in IMU integration (prevent bias blowup)
    // Q ~ 0.5 means we expect significant process noise in position/velocity/attitude
    const Q = MatrixUtils.eye(16).map((row) => row.map(() => 0.5));
    const R = MatrixUtils.eye(3).map((row) => row.map(() => 5.0));
    filterInstance = new AEKFFilter(initialX, initialP, Q, R);
    status.value = 'Filter ready – listening to IMU';

    // Initialize UI diagnostics immediately when the filter is created.
    xest.value = {
        pos: filterInstance.getPosition(),
        vel: filterInstance.getVelocity(),
        att: filterInstance.getAttitude(),
        biasAcc: filterInstance.getBiasAcc(),
        biasGyro: filterInstance.getBiasGyro(),
    };
    const vel = xest.value.vel;
    const biasAccMag = Math.sqrt(
        xest.value.biasAcc[0] ** 2 + xest.value.biasAcc[1] ** 2 + xest.value.biasAcc[2] ** 2,
    );
    const biasGyroMag = Math.sqrt(
        xest.value.biasGyro[0] ** 2 + xest.value.biasGyro[1] ** 2 + xest.value.biasGyro[2] ** 2,
    );
    diagnostics.value = {
        covTrace: filterInstance.getCovarianceTrace(),
        velMag: Math.sqrt(vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2]),
        isStationary: false,
        biasAccMag,
        biasGyroMag,
    };
}

// ----------------------------- IMU Event Handler -----------------------------
let lastTimestamp = 0;

const debugData = ref(null as null | {
    acceleration: DeviceMotionEventAcceleration | null;
    accelerationIncludingGravity: DeviceMotionEventAcceleration | null;
    rotationRate: DeviceMotionEventRotationRate | null;
    interval: number | null;
    timestamp: number;
});

const DVOData = ref(null as null | {
    alpha: number | null;
    beta: number | null;
    gamma: number | null;
    absolute: boolean | null;
});

function handleDeviceMotion(event: DeviceMotionEvent) {
    debugData.value = {
        acceleration: event.acceleration,
        accelerationIncludingGravity: event.accelerationIncludingGravity,
        rotationRate: event.rotationRate,
        interval: event.interval,
        timestamp: performance.now(),
    };

    if (!filterInstance || !gyroGranted.value || isCalibrating.value || !calibrationCompleted.value) return;

    const now = performance.now();
    const dt = lastTimestamp ? Math.min(0.1, (now - lastTimestamp) / 1000) : 0.01;
    lastTimestamp = now;

    let accel: [number, number, number] = [
        (event.accelerationIncludingGravity?.x ?? event.acceleration?.x ?? 0),
        (event.accelerationIncludingGravity?.y ?? event.acceleration?.y ?? 0),
        (event.accelerationIncludingGravity?.z ?? event.acceleration?.z ?? 0),
    ];
    let gyro: [number, number, number] = [
        (event.rotationRate?.alpha ?? 0) * Math.PI / 180,
        (event.rotationRate?.beta ?? 0) * Math.PI / 180,
        (event.rotationRate?.gamma ?? 0) * Math.PI / 180,
    ];

    // Note: do NOT subtract calibration means here. The filter's bias state
    // already holds static sensor biases (initialized in initFilter). Passing
    // raw `accelerationIncludingGravity` to the filter and letting it remove
    // biases during predict prevents double-correction and growing velocity.

    // Heuristic: if device is essentially stationary (accel magnitude ~= g and gyro tiny),
    // treat accel as gravity-only to avoid integrating noise into velocity.
    const gyroMag = Math.sqrt(gyro[0] * gyro[0] + gyro[1] * gyro[1] + gyro[2] * gyro[2]);
    const accelMag = Math.sqrt(accel[0] * accel[0] + accel[1] * accel[1] + accel[2] * accel[2]);
    const isStationary = Math.abs(accelMag - 9.81) < 0.35 && gyroMag < 0.02;

    if (isStationary) {
        accel = [0, 0, 9.81];
    }

    filterInstance.predict(accel, gyro, dt);

    // Zero-velocity update: when stationary, strongly constrain velocity to zero
    if (isStationary) {
        const R_vel = [
            [0.01, 0, 0],
            [0, 0.01, 0],
            [0, 0, 0.01],
        ];
        filterInstance.updateVelocity(R_vel);
    }

    xest.value = {
        pos: filterInstance.getPosition(),
        vel: filterInstance.getVelocity(),
        att: filterInstance.getAttitude(),
        biasAcc: filterInstance.getBiasAcc(),
        biasGyro: filterInstance.getBiasGyro(),
    };

    trajectory.value.push([...xest.value.pos]);
    if (trajectory.value.length > 2000) trajectory.value.shift();

    if (refSet && filterHasGpsFix.value) {
        const filteredGeo = enuToGeodetic(
            xest.value.pos[0],
            xest.value.pos[1],
            xest.value.pos[2],
            refLat,
            refLon,
            refAlt,
        );
        currentFilteredLatLng.value = filteredGeo;
        updateMapView(latestGPS.value?.lat ?? filteredGeo.lat, latestGPS.value?.lon ?? filteredGeo.lon, filteredGeo);
        if (recording.value) appendTrackPoint(filteredGeo);
    }

    // Diagnostics: update UI panel every 10 frames
    const vel = xest.value.vel;
    const pos = xest.value.pos;
    const velMag = Math.sqrt(vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2]);
    const biasAccMag = Math.sqrt(
        xest.value.biasAcc[0] ** 2 + xest.value.biasAcc[1] ** 2 + xest.value.biasAcc[2] ** 2
    );
    const biasGyroMag = Math.sqrt(
        xest.value.biasGyro[0] ** 2 + xest.value.biasGyro[1] ** 2 + xest.value.biasGyro[2] ** 2
    );

    if (frameCount.value % 10 === 0) {
        const trace = filterInstance ? filterInstance.getCovarianceTrace() : null;
        diagnostics.value = {
            covTrace: trace,
            velMag,
            isStationary,
            biasAccMag,
            biasGyroMag,
        };

        covTraceHistory.value.push(trace ?? 0);
        velMagHistory.value.push(velMag);
        biasGyroHistory.value.push(biasGyroMag);
        while (covTraceHistory.value.length > 40) covTraceHistory.value.shift();
        while (velMagHistory.value.length > 40) velMagHistory.value.shift();
        while (biasGyroHistory.value.length > 40) biasGyroHistory.value.shift();
    }

    frameCount.value++;
    lastFrameTime.value = now;
}

function renderSparkline(values: number[], width = 360, height = 120): string {
    if (!values.length) return '';
    const minVal = Math.min(...values);
    const maxVal = Math.max(...values);
    const range = maxVal - minVal || 1;
    const step = width / Math.max(values.length - 1, 1);
    return values
        .map((value, index) => {
            const x = index * step;
            const y = height - ((value - minVal) / range) * (height - 12) - 6;
            return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');
}

function handleDeviceOrientation(event: DeviceOrientationEvent) {
    DVOData.value = {
        alpha: event.alpha,
        beta: event.beta,
        gamma: event.gamma,
        absolute: event.absolute,
    };
}

async function requestSensorPermissions() {
    try {
        if (typeof (DeviceMotionEvent as any).requestPermission === 'function') {
            const motionPerm = await (DeviceMotionEvent as any).requestPermission();
            if (motionPerm === 'granted') {
                gyroGranted.value = true;
                window.addEventListener('devicemotion', handleDeviceMotion);
            }
        } else {
            gyroGranted.value = true;
            window.addEventListener('devicemotion', handleDeviceMotion);
        }

        if (typeof (DeviceOrientationEvent as any).requestPermission === 'function') {
            const orientPerm = await (DeviceOrientationEvent as any).requestPermission();
            if (orientPerm === 'granted') {
                orientationGranted.value = true;
                window.addEventListener('deviceorientation', handleDeviceOrientation);
                status.value += ' + Orientation granted';
            } else {
                status.value += ' + Orientation denied';
            }
        } else {
            orientationGranted.value = true;
            window.addEventListener('deviceorientation', handleDeviceOrientation);
            status.value += ' + Orientation active';
        }
    } catch (error) {
        console.error(error);
        status.value = 'Sensor permission error';
    }
}

async function requestGeoPermission() {
    try {
        await navigator.geolocation.getCurrentPosition(
            (position) => {
                geoGranted.value = true;
                status.value = `GPS access granted: ${position.coords.latitude.toFixed(5)}, ${position.coords.longitude.toFixed(5)}`;
            },
            (error) => {
                geoGranted.value = false;
                status.value = `GPS access denied: ${error.message}`;
            },
            { enableHighAccuracy: true, timeout: 10000 },
        );
    } catch (error) {
        console.error(error);
        status.value = 'GPS permission error';
    }
}

const start3DDemo = async () => {
    if (!gyroGranted.value) {
        status.value = 'Please enable gyro first.';
        return;
    }
    if (!calibrationData.value) {
        await calibrateSensors();
    }
    show3D.value = true;
    const THREE = await import('three');
    initThreeScene(THREE, debugData, xest);
};

const close3D = () => {
    show3D.value = false;
    const container = document.getElementById('three-container');
    if (container) {
        const canvas = container.querySelector('canvas');
        if (canvas) container.removeChild(canvas);
    }
};

let simulateInterval: number | null = null;

function startSimulation() {
    if (simulateInterval) return;
    status.value = 'Simulation started - fake sensor data';
    gyroGranted.value = true;
    geoGranted.value = true;
    calibrationData.value = { accelMean: [0, 0, 9.81], gyroMean: [0, 0, 0] };
    initFilter();

    let time = 0;
    simulateInterval = setInterval(() => {
        time += 0.1;
        const fakeAccel = [0, 0, 9.81];
        const fakeGyro = [0.1 * Math.sin(time), 0.1 * Math.cos(time), 0];
        debugData.value = {
            acceleration: null,
            accelerationIncludingGravity: { x: fakeAccel[0]!, y: fakeAccel[1]!, z: fakeAccel[2]! },
            rotationRate: { alpha: fakeGyro[0]! * 180 / Math.PI, beta: fakeGyro[1]! * 180 / Math.PI, gamma: fakeGyro[2]! * 180 / Math.PI },
            interval: 100,
            timestamp: performance.now(),
        };
        handleDeviceMotion({
            acceleration: null,
            accelerationIncludingGravity: { x: fakeAccel[0], y: fakeAccel[1], z: fakeAccel[2] },
            rotationRate: { alpha: fakeGyro[0]! * 180 / Math.PI, beta: fakeGyro[1]! * 180 / Math.PI, gamma: fakeGyro[2]! * 180 / Math.PI },
            interval: 100,
        } as DeviceMotionEvent);
    }, 100);
}

function stopSimulation() {
    if (simulateInterval) {
        clearInterval(simulateInterval);
        simulateInterval = null;
        status.value = 'Simulation stopped';
    }
}

let roughDemoInstance: {
    animate: () => void;
    dispose: () => void;
} | null = null;

const startRoughDemo = async () => {
    if (!gyroGranted.value) {
        status.value = 'Please enable gyro first.';
        return;
    }

    status.value = 'Starting Rough 3D Demo (raw data only)…';
    show3D.value = true;
    const THREE = await import('three');
    const inst = initRoughThreeScene(THREE, debugData, DVOData, calibrationData, info_phone, info_laccel, info_waccel, info_abody, info_gbody);
    roughDemoInstance = inst;
};


onMounted(async () => {
    await nextTick();
    await new Promise((r) => setTimeout(r, 30));
    await initMap();
});
</script>

<template>
    <ClientOnly>
        <div
            id="index-container"
            style="font-family: monospace; padding: 20px; background: #111; color: #f0f5ff; min-height: 100vh; overflow-y: auto;"
        >
            <h2 style="margin-bottom: 0.5rem;">Navigation Demo — Map + EKF Track</h2>

            <div
                style="margin: 16px 0; padding: 14px; background: #0c1118; border: 1px solid #2f9fdf; border-radius: 10px;">
                <strong>Status:</strong> {{ status }}
            </div>

            <div
                style="display: grid; gap: 16px; margin-bottom: 16px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));">
                <div style="padding: 16px; background: #11181f; border: 1px solid #2f9fdf; border-radius: 10px;">
                    <strong>Permissions</strong>
                    <div style="margin-top: 12px; display: grid; gap: 10px;">
                        <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
                            <span>Gyro / Accel</span>
                            <span :style="{ color: gyroGranted ? '#7fffd4' : '#ff6b6b' }">{{ gyroGranted ? 'ACTIVE' :
                                'INACTIVE' }}</span>
                        </div>
                        <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
                            <span>GPS</span>
                            <span :style="{ color: geoGranted ? '#7fffd4' : '#ff6b6b' }">{{ geoGranted ? 'ACTIVE' :
                                'INACTIVE' }}</span>
                        </div>
                        <div style="display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px;">
                            <button
                                @click="requestSensorPermissions"
                                style="flex: 1 1 120px; padding: 10px; background: #2f9fdf; color: #000; border: none; border-radius: 8px; cursor: pointer;"
                            >Enable Sensors</button>
                            <button
                                @click="requestGeoPermission"
                                style="flex: 1 1 120px; padding: 10px; background: #6bcf74; color: #000; border: none; border-radius: 8px; cursor: pointer;"
                            >Enable GPS</button>
                        </div>
                    </div>
                </div>

                <div style="padding: 16px; background: #11181f; border: 1px solid #2f9fdf; border-radius: 10px;">
                    <strong>Calibration</strong>
                    <div style="margin-top: 12px; display: grid; gap: 10px;">
                        <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
                            <span>Status</span>
                            <span
                                :style="{ color: calibrationCompleted ? '#7fffd4' : isCalibrating ? '#ffb800' : '#ff6b6b' }"
                            >
                                {{ isCalibrating ? 'CALIBRATING...' : calibrationCompleted ? 'COMPLETE' : 'REQUIRED' }}
                            </span>
                        </div>
                        <button
                            @click="calibrateSensors"
                            :disabled="isCalibrating || calibrationCompleted"
                            style="padding: 10px; background: #d946a6; color: #000; border: none; border-radius: 8px; cursor: pointer; opacity: 0.9;"
                            :style="{ opacity: isCalibrating || calibrationCompleted ? 0.5 : 0.9, cursor: isCalibrating || calibrationCompleted ? 'not-allowed' : 'pointer' }"
                        >
                            {{ isCalibrating ? 'Calibrating...' : calibrationCompleted ? 'Recalibrate' :
                                'StartCalibration' }}
                        </button>
                    </div>
                </div>

                <div style="padding: 16px; background: #11181f; border: 1px solid #2f9fdf; border-radius: 10px;">
                    <strong>Route Control</strong>
                    <div style="margin-top: 12px; display: grid; gap: 10px;">
                        <button
                            @click="toggleRecording"
                            :disabled="!calibrationCompleted"
                            style="padding: 10px; background: #ffb800; color: #000; border: none; border-radius: 8px; cursor: pointer;"
                            :style="{ opacity: !calibrationCompleted ? 0.5 : 1, cursor: !calibrationCompleted ? 'not-allowed' : 'pointer' }"
                        >{{ recordingLabel }}</button>
                        <button
                            @click="clearTrack"
                            style="padding: 10px; background: #ff4b4b; color: #000; border: none; border-radius: 8px; cursor: pointer;"
                        >Clear Track</button>

                    </div>
                </div>

                <div style="padding: 16px; background: #11181f; border: 1px solid #2f9fdf; border-radius: 10px;">
                    <strong>Quick Metrics</strong>
                    <div style="margin-top: 12px; display: grid; gap: 8px; font-size: 0.95rem;">
                        <div>Current Pos: <strong>{{ positionLabel }}</strong></div>
                        <div>GPS Acc: <strong>{{ latestGPS?.accuracy?.toFixed(1) || '–' }} m</strong></div>
                        <div>Speed: <strong>{{ currentSpeed.toFixed(2) }} m/s</strong></div>
                        <div>Route length: <strong>{{ filteredDistance.toFixed(1) }} m</strong></div>
                        <div>Track points: <strong>{{ trackPoints.length }}</strong></div>
                        <div>Raw fixes: <strong>{{ rawTrackPoints.length }}</strong></div>
                    </div>
                </div>
            </div>

            <div
                style="padding: 16px; background: #11181f; border: 1px solid #2f9fdf; border-radius: 10px; margin-bottom: 24px;">
                <div style="display: grid; gap: 10px;">
                    <div style="font-weight: bold;">Map view</div>
                    <div
                        style="min-height: 420px; border-radius: 12px; overflow: hidden; background: #000; position: relative;">
                        <div
                            v-if="!mapReady"
                            style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #7f9cff; background: rgba(0, 0, 0, 0.65); font-size: 1.05rem; z-index: 10;"
                        >Loading map…</div>
                        <div
                            ref="mapEl"
                            id="map"
                            style="width: 100%; height: 420px;"
                        ></div>
                        <!-- Map legend -->
                    </div>
                    <div
                        style="display: flex; align-items: start; gap: 10px; flex-wrap: wrap; color: #b8d8ff; font-size: 0.95rem;">
                        <div style="font-size: 0.9rem;">
                            <div style="font-weight:600; margin-bottom:6px;">Legend</div>
                            <div style="display:flex; gap:8px; align-items:center;">
                                <span
                                    style="width:12px; height:12px; background: #33d9ff; display:inline-block; border-radius:3px; border: 1px solid rgba(0,0,0,0.2);"
                                ></span>
                                <span>Raw GPS fix</span>
                            </div>
                            <div style="display:flex; gap:8px; align-items:center; margin-top:6px;">
                                <span
                                    style="width:12px; height:12px; background: #a0ff4d; display:inline-block; border-radius:3px; border: 1px solid rgba(0,0,0,0.2);"
                                ></span>
                                <span>Filtered (EKF)</span>
                            </div>
                            <div style="display:flex; gap:8px; align-items:center; margin-top:6px;">
                                <span
                                    style="width:12px; height:12px; background: #ffb800; display:inline-block; border-radius:3px; border: 1px solid rgba(0,0,0,0.2);"
                                ></span>
                                <span>Recording control</span>
                            </div>
                        </div>
                        <span style="display:flex; align-items:center; gap:8px; margin-left: auto;">
                            <label style="font-size:0.95rem;">Map follow:</label>
                            <select
                                v-model="mapFollowMode"
                                style="background:#0c1118; color:#b8d8ff; border:1px solid #2f9fdf; border-radius:6px; padding:6px;"
                            >
                                <option value="filtered">Filtered</option>
                                <option value="raw">Raw</option>
                                <option value="both">Both</option>
                            </select>
                        </span>
                    </div>
                </div>
            </div>

            <div
                style="padding: 16px; background: #11181f; border: 1px solid #2f9fdf; border-radius: 10px; margin-bottom: 24px;">
                <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px;">
                    <div style="font-weight: 700;">EKF dashboard</div>
                    <button
                        @click="viewTab = 'metrics'"
                        :style="{
                            padding: '10px 14px',
                            borderRadius: '8px',
                            border: '1px solid #2f9fdf',
                            background: viewTab === 'metrics' ? '#2f9fdf' : '#0b1220',
                            color: viewTab === 'metrics' ? '#000' : '#b8d8ff',
                            cursor: 'pointer',
                        }"
                    >Metrics</button>
                    <button
                        @click="viewTab = 'aekf'"
                        :style="{
                            padding: '10px 14px',
                            borderRadius: '8px',
                            border: '1px solid #2f9fdf',
                            background: viewTab === 'aekf' ? '#2f9fdf' : '#0b1220',
                            color: viewTab === 'aekf' ? '#000' : '#b8d8ff',
                            cursor: 'pointer',
                        }"
                    >AEKF Graphic</button>
                </div>

                <div
                    v-show="viewTab === 'metrics'"
                    style="display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));"
                >
                    <div style="padding: 16px; background: #0b1220; border: 1px solid #174a83; border-radius: 10px;">
                        <div style="font-weight: 600; margin-bottom: 8px;">Key EKF numbers</div>
                        <div style="display: grid; gap: 8px; font-size: 0.95rem;">
                            <div>Cov trace: <strong>{{ diagnostics?.covTrace?.toFixed(1) || '–' }}</strong></div>
                            <div>Velocity: <strong>{{ diagnostics?.velMag?.toFixed(3) || '–' }} m/s</strong></div>
                            <div>Accel bias: <strong>{{ diagnostics?.biasAccMag?.toFixed(4) || '–' }}</strong></div>
                            <div>Gyro bias: <strong>{{ diagnostics?.biasGyroMag?.toFixed(5) || '–' }}</strong></div>
                            <div>Stationary: <strong
                                    :style="{ color: diagnostics?.isStationary ? '#7fffd4' : '#ff6b6b' }"
                                >{{ diagnostics?.isStationary ? 'YES' : 'NO' }}</strong></div>
                        </div>
                    </div>
                    <div style="padding: 16px; background: #0b1220; border: 1px solid #174a83; border-radius: 10px;">
                        <div style="font-weight: 600; margin-bottom: 8px;">EKF trend</div>
                        <div style="font-size: 0.9rem; color: #b8d8ff; line-height: 1.6;">
                            This tab surfaces the same real-time measurements that drive the filter. It is useful when
                            you want a quick overview of whether the EKF is converging and how busy the filter state is.
                        </div>
                    </div>
                </div>

                <div
                    v-show="viewTab === 'aekf'"
                    style="display: grid; gap: 16px;"
                >
                    <div style="padding: 16px; background: #0b1220; border: 1px solid #174a83; border-radius: 10px;">
                        <div style="font-weight: 600; margin-bottom: 12px;">AEKF confidence timeline</div>
                        <svg
                            width="100%"
                            height="160"
                            viewBox="0 0 360 160"
                            style="background: #03070d; border-radius: 10px; display: block;"
                        >
                            <rect
                                x="0"
                                y="0"
                                width="360"
                                height="160"
                                fill="#03070d"
                            />
                            <path
                                :d="renderSparkline(covTraceHistory, 360, 120)"
                                fill="none"
                                stroke="#7fffd4"
                                stroke-width="2"
                            />
                            <path
                                :d="renderSparkline(velMagHistory, 360, 120)"
                                fill="none"
                                stroke="#ffb800"
                                stroke-width="2"
                                opacity="0.9"
                            />
                            <path
                                :d="renderSparkline(biasGyroHistory, 360, 120)"
                                fill="none"
                                stroke="#ff6b6b"
                                stroke-width="2"
                                opacity="0.8"
                            />
                            <line
                                x1="0"
                                y1="150"
                                x2="360"
                                y2="150"
                                stroke="#2f9fdf"
                                stroke-width="0.5"
                                opacity="0.4"
                            />
                        </svg>
                        <div
                            style="display: flex; justify-content: space-between; align-items: center; font-size: 0.9rem; color: #b8d8ff; margin-top: 10px;">
                            <span>Trace = uncertainty, yellow = speed, red = gyro bias</span>
                            <span :style="{ color: diagnostics?.isStationary ? '#7fffd4' : '#ff6b6b' }">{{
                                diagnostics?.isStationary ? 'Stationary' : 'Moving' }}</span>
                        </div>
                    </div>
                    <div style="display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));">
                        <div
                            style="padding: 16px; background: #0b1220; border: 1px solid #174a83; border-radius: 10px;">
                            <div style="font-size: 0.92rem; font-weight: 600; margin-bottom: 8px;">Latest trace</div>
                            <div style="font-size: 1.5rem; color: #7fffd4;">{{ diagnostics?.covTrace?.toFixed(1) || '–'
                                }}</div>
                        </div>
                        <div
                            style="padding: 16px; background: #0b1220; border: 1px solid #174a83; border-radius: 10px;">
                            <div style="font-size: 0.92rem; font-weight: 600; margin-bottom: 8px;">Current speed</div>
                            <div style="font-size: 1.5rem; color: #ffb800;">{{ diagnostics?.velMag?.toFixed(2) || '–' }}
                                m/s</div>
                        </div>
                        <div
                            style="padding: 16px; background: #0b1220; border: 1px solid #174a83; border-radius: 10px;">
                            <div style="font-size: 0.92rem; font-weight: 600; margin-bottom: 8px;">Gyro bias</div>
                            <div style="font-size: 1.5rem; color: #ff6b6b;">{{ diagnostics?.biasGyroMag?.toFixed(5) ||
                                '–' }}</div>
                        </div>
                    </div>
                </div>
            </div>

            <div
                style="display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); margin-bottom: 24px;">
                <div style="padding: 16px; background: #11181f; border: 1px solid #2f9fdf; border-radius: 10px;">
                    <strong>EKF state</strong>
                    <div style="margin-top: 12px; font-size: 0.95rem; line-height: 1.7;">
                        <div><strong>Position [m]:</strong> {{ xest.pos[0].toFixed(3) }}, {{ xest.pos[1].toFixed(3) }},
                            {{ xest.pos[2].toFixed(3) }}</div>
                        <div><strong>Velocity [m/s]:</strong> {{ xest.vel[0].toFixed(3) }}, {{ xest.vel[1].toFixed(3)
                        }}, {{ xest.vel[2].toFixed(3) }}</div>
                        <div><strong>Attitude [rad]:</strong> {{ xest.att[0].toFixed(3) }}, {{ xest.att[1].toFixed(3)
                        }}, {{ xest.att[2].toFixed(3) }}</div>
                        <div><strong>Accel bias:</strong> {{ xest.biasAcc[0].toFixed(3) }}, {{
                            xest.biasAcc[1].toFixed(3) }}, {{ xest.biasAcc[2].toFixed(3) }}</div>
                        <div><strong>Gyro bias:</strong> {{ xest.biasGyro[0].toFixed(3) }}, {{
                            xest.biasGyro[1].toFixed(3) }}, {{ xest.biasGyro[2].toFixed(3) }}</div>
                    </div>
                </div>
                <div style="padding: 16px; background: #11181f; border: 1px solid #2f9fdf; border-radius: 10px;">
                    <strong>Sensor stream</strong>
                    <div style="margin-top: 12px; font-size: 0.95rem; line-height: 1.7; color: #b8d8ff;">
                        <div>Accel+Grav: {{debugData?.accelerationIncludingGravity ?
                            [debugData.accelerationIncludingGravity.x, debugData.accelerationIncludingGravity.y,
                            debugData.accelerationIncludingGravity.z].map(x => (x || 0).toFixed(2)).join(', ') :
                            'waiting...'}} m/s²</div>
                        <div>Gyro: {{debugData?.rotationRate ? [debugData.rotationRate.alpha,
                        debugData.rotationRate.beta, debugData.rotationRate.gamma].map(x => (x ||
                            0).toFixed(2)).join(', ') : 'waiting...' }} deg/s</div>
                        <div>DVO: {{ DVOData?.alpha?.toFixed(1) || '–' }}, {{ DVOData?.beta?.toFixed(1) || '–' }}, {{
                            DVOData?.gamma?.toFixed(1) || '–' }}</div>
                        <div>Last IMU ts: {{ debugData?.timestamp ? new Date(debugData.timestamp).toLocaleTimeString() :
                            'none' }}</div>
                    </div>
                </div>
                <div style="padding: 16px; background: #11181f; border: 1px solid #2f9fdf; border-radius: 10px;">
                    <strong>Filter Diagnostics</strong>
                    <div style="margin-top: 12px; font-size: 0.95rem; line-height: 1.7;">
                        <div><strong>Calibration Accel:</strong> {{calibrationData?.accelMean ?
                            calibrationData.accelMean.map(x => x.toFixed(2)).join(', ') : 'pending'}}</div>
                        <div><strong>Calibration Gyro:</strong> {{calibrationData?.gyroMean ?
                            calibrationData.gyroMean.map(x => (x * 180 / Math.PI).toFixed(2)).join(', ') : 'pending'}}
                            deg/s</div>
                        <hr style="border: none; border-top: 1px solid #2f9fdf; margin: 8px 0;" />
                        <div><strong>Velocity Mag:</strong> {{ diagnostics?.velMag?.toFixed(3) || '–' }} m/s</div>
                        <div><strong>Bias Accel Mag:</strong> {{ diagnostics?.biasAccMag?.toFixed(4) || '–' }}</div>
                        <div><strong>Bias Gyro Mag:</strong> {{ diagnostics?.biasGyroMag?.toFixed(6) || '–' }}</div>
                        <div><strong>Cov Trace:</strong> {{ diagnostics?.covTrace?.toFixed(1) || '–' }}</div>
                        <div><strong>Stationary:</strong> <span
                                :style="{ color: diagnostics?.isStationary ? '#7fffd4' : '#ff6b6b' }"
                            >{{ diagnostics?.isStationary ? 'YES' : 'NO' }}</span></div>
                    </div>
                </div>
            </div>
        </div>
    </ClientOnly>
</template>

<style scoped>
button:hover {
    opacity: 0.85;
}

#map {
    width: 100%;
    height: 100%;
}
</style>
