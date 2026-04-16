<script
    setup
    lang="ts"
>
import { onMounted, ref, computed, watch } from 'vue';
import { AEKFFilter } from '~/core/aekf';
import { MatrixUtils } from '~/core/matrix';
import { useGeolocation } from '@vueuse/core';
import type { IMUData, StateVector } from '~/types';

// ----------------------------- Reactive state -----------------------------
const status = ref('Initializing...');
const orientationGranted = ref(false);
const gyroGranted = ref(false);
const geoGranted = ref(false);
const show3D = ref(false);
const isCalibrating = ref(false);
const calibrationData = ref<{ accelMean: number[]; gyroMean: number[] } | null>(null);
const info_phone = ref<any>(null)
const info_waccel = ref<any>(null)
const info_laccel = ref<any>(null)
const info_gbody = ref<any>(null)
const info_abody = ref<any>(null)


let filterInstance: AEKFFilter | null = null;

const latestIMU = ref<IMUData>({ accel: [0, 0, 0], gyro: [0, 0, 0], ts: 0 });
const latestGPS = ref({ pos: [0, 0, 0], ts: 0 });
const xest = ref<StateVector>({
    pos: [0, 0, 0],
    vel: [0, 0, 0],
    att: [0, 0, 0],
    biasAcc: [0, 0, 0],
    biasGyro: [0, 0, 0],
});
const trajectory = ref<number[][]>([]);
const frameCount = ref(0);
const lastFrameTime = ref(performance.now());

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
let refLat = 0, refLon = 0, refAlt = 0;
let refSet = false;

function geodeticToEnu(lat: number, lon: number, alt: number): [number, number, number] {
    const R = 6378137; // Earth radius (m)
    const radLat = lat * Math.PI / 180;
    const radLon = lon * Math.PI / 180;
    const radRefLat = refLat * Math.PI / 180;
    const radRefLon = refLon * Math.PI / 180;
    const sinLat = Math.sin(radLat), cosLat = Math.cos(radLat);
    const sinLon = Math.sin(radLon), cosLon = Math.cos(radLon);
    const sinRefLat = Math.sin(radRefLat), cosRefLat = Math.cos(radRefLat);
    const sinRefLon = Math.sin(radRefLon), cosRefLon = Math.cos(radRefLon);

    const dx = (R + alt) * cosLat * cosLon - (R + refAlt) * cosRefLat * cosRefLon;
    const dy = (R + alt) * cosLat * sinLon - (R + refAlt) * cosRefLat * sinRefLon;
    const dz = (R + alt) * sinLat - (R + refAlt) * sinRefLat;

    const east = -sinRefLon * dx + cosRefLon * dy;
    const north = -sinRefLat * cosRefLon * dx - sinRefLat * sinRefLon * dy + cosRefLat * dz;
    const up = cosRefLat * cosRefLon * dx + cosRefLat * sinRefLon * dy + sinRefLat * dz;
    return [east, north, up];
}

watch(() => coords.value, (c) => {
    if (!c || !filterInstance) return;
    if (!refSet && c.latitude && c.longitude) {
        refLat = c.latitude;
        refLon = c.longitude;
        refAlt = c.altitude ?? 0;
        refSet = true;
        status.value = `Reference set: ${refLat.toFixed(5)}, ${refLon.toFixed(5)}`;
    }
    const enu = geodeticToEnu(c.latitude, c.longitude, c.altitude ?? 0);
    const accHor = Math.max(c.accuracy, 5.0);
    const R_pos = [
        [accHor ** 2, 0, 0],
        [0, accHor ** 2, 0],
        [0, 0, 10.0]  // vertical accuracy worse
    ];
    filterInstance.updatePosition(enu, R_pos);
    geoGranted.value = true;
    status.value = `GPS update: ${enu[0].toFixed(1)}m E, ${enu[1].toFixed(1)}m N`;
});

// ----------------------------- Calibration -----------------------------
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
                const accelMean = accelSamples.reduce(
                    (a, b) => {
                        if (a.length >= 3 && b.length >= 3 && a[0] !== undefined && a[1] !== undefined && a[2] !== undefined && b[0] !== undefined && b[1] !== undefined && b[2] !== undefined) {
                            return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
                        }
                        return a;
                    },
                    [0, 0, 0]
                ).map(v => v / accelSamples.length);
                const gyroMean = gyroSamples.reduce(
                    (a, b) => {
                        if (a.length >= 3 && b.length >= 3 && a[0] !== undefined && a[1] !== undefined && a[2] !== undefined && b[0] !== undefined && b[1] !== undefined && b[2] !== undefined) {
                            return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
                        }
                        return a;
                    },
                    [0, 0, 0]
                ).map(v => v / gyroSamples.length);
                calibrationData.value = { accelMean, gyroMean };
                status.value = '✅ Calibration done. Starting filter...';
                initFilter();
                resolve();
                return;
            }
            if (e.accelerationIncludingGravity) {
                accelSamples.push([
                    e.accelerationIncludingGravity.x || 0,
                    e.accelerationIncludingGravity.y || 0,
                    e.accelerationIncludingGravity.z || 0
                ]);
            } else if (e.acceleration) {
                accelSamples.push([
                    e.acceleration.x || 0,
                    e.acceleration.y || 0,
                    e.acceleration.z || 0
                ]);
            }
            if (e.rotationRate) {
                const gyroRad = [
                    (e.rotationRate.alpha || 0) * Math.PI / 180,
                    (e.rotationRate.beta || 0) * Math.PI / 180,
                    (e.rotationRate.gamma || 0) * Math.PI / 180
                ];
                gyroSamples.push(gyroRad);
            }
        };
        window.addEventListener('devicemotion', handler);
    });
}

function initFilter() {
    const initialX = new Array(15).fill(0);
    if (calibrationData.value) {
        // Static bias from calibration
        initialX[9] = calibrationData.value.accelMean[0]!;
        initialX[10] = calibrationData.value.accelMean[1]!;
        initialX[11] = calibrationData.value.accelMean[2]! - 9.81; // remove gravity from Z
        initialX[12] = calibrationData.value.gyroMean[0]!;
        initialX[13] = calibrationData.value.gyroMean[1]!;
        initialX[14] = calibrationData.value.gyroMean[2]!;
    }
    const initialP = MatrixUtils.eye(15).map(row => row.map(() => 1.0));
    const Q = MatrixUtils.eye(15).map(row => row.map(() => 0.01));
    const R = MatrixUtils.eye(3).map(row => row.map(() => 5.0));
    filterInstance = new AEKFFilter(initialX, initialP, Q, R);
    status.value = 'Filter ready – listening to IMU';
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
    alpha: number | null,     // Yaw (компас)
    beta: number | null,       // Pitch
    gamma: number | null,     // Roll
    absolute: boolean | null  // Магнитометр включён?
});


function handleDeviceMotion(event: DeviceMotionEvent) {
    debugData.value = {
        acceleration: event.acceleration,
        accelerationIncludingGravity: event.accelerationIncludingGravity,
        rotationRate: event.rotationRate,
        interval: event.interval,
        timestamp: performance.now()
    };

    if (!filterInstance || !gyroGranted.value || isCalibrating.value) return;

    const now = performance.now();
    const dt = lastTimestamp ? Math.min(0.1, (now - lastTimestamp) / 1000) : 0.01;
    lastTimestamp = now;

    // Raw readings - use accelerationIncludingGravity for total accel (includes gravity)
    let accel: [number, number, number] = [
        (event.accelerationIncludingGravity?.x ?? event.acceleration?.x ?? 0),
        (event.accelerationIncludingGravity?.y ?? event.acceleration?.y ?? 0),
        (event.accelerationIncludingGravity?.z ?? event.acceleration?.z ?? 0)
    ];
    let gyro: [number, number, number] = [
        (event.rotationRate?.alpha ?? 0) * Math.PI / 180,
        (event.rotationRate?.beta ?? 0) * Math.PI / 180,
        (event.rotationRate?.gamma ?? 0) * Math.PI / 180
    ];

    // Remove static calibration biases
    if (calibrationData.value) {
        accel = [
            accel[0] - calibrationData.value.accelMean[0]!,
            accel[1] - calibrationData.value.accelMean[1]!,
            accel[2] - calibrationData.value.accelMean[2]!
        ];
        gyro = [
            gyro[0] - calibrationData.value.gyroMean[0]!,
            gyro[1] - calibrationData.value.gyroMean[1]!,
            gyro[2] - calibrationData.value.gyroMean[2]!
        ];
    }

    // Predict step
    filterInstance.predict(accel, gyro, dt);

    // Update reactive state
    xest.value = {
        pos: filterInstance.getPosition(),
        vel: filterInstance.getVelocity(),
        att: filterInstance.getAttitude(),
        biasAcc: filterInstance.getBiasAcc(),
        biasGyro: filterInstance.getBiasGyro()
    };

    trajectory.value.push([...xest.value.pos]);
    if (trajectory.value.length > 2000) trajectory.value.shift();

    frameCount.value++;
    lastFrameTime.value = now;
}

function handleDeviceOrientation(event: DeviceOrientationEvent) {
    DVOData.value = {
        alpha: event.alpha,     // Yaw (компас)
        beta: event.beta,       // Pitch
        gamma: event.gamma,     // Roll
        absolute: event.absolute  // Магнитометр включён?
    }
}

// ----------------------------- Permissions -----------------------------
// async function requestGyroPermission() {
//     try {
//         if (typeof (DeviceMotionEvent as any).requestPermission === 'function') {
//             const permission = await (DeviceMotionEvent as any).requestPermission();
//             if (permission === 'granted') {
//                 gyroGranted.value = true;
//                 status.value = 'Gyro access granted - listener added';
//                 window.addEventListener('devicemotion', handleDeviceMotion);
//             } else {
//                 status.value = 'Gyro access denied';
//             }
//         } else {
//             gyroGranted.value = true;
//             status.value = 'Gyro access active (no permission needed) - listener added';
//             window.addEventListener('devicemotion', handleDeviceMotion);
//         }
//     } catch (error) {
//         console.error(error);
//         status.value = 'Gyro permission error';
//     }
// }

async function requestSensorPermissions() {
    try {
        // DeviceMotion (accel + gyro)
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

        // DeviceOrientation (alpha/beta/gamma + absolute)
        if (typeof (DeviceOrientationEvent as any).requestPermission === 'function') {
            const orientPerm = await (DeviceOrientationEvent as any).requestPermission();
            if (orientPerm === 'granted') {
                orientationGranted.value = true;  // Добавь ref для ориентации
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
        // Trigger geolocation permission request
        await navigator.geolocation.getCurrentPosition(
            (position) => {
                geoGranted.value = true;
                status.value = `GPS access granted: ${position.coords.latitude.toFixed(5)}, ${position.coords.longitude.toFixed(5)}`;
            },
            (error) => {
                geoGranted.value = false;
                status.value = `GPS access denied: ${error.message}`;
            },
            { enableHighAccuracy: true, timeout: 10000 }
        );
    } catch (error) {
        console.error(error);
        status.value = 'GPS permission error';
    }
}

// ----------------------------- 3D Demo -----------------------------
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

// ----------------------------- Simulation for Testing -----------------------------
let simulateInterval: number | null = null;

function startSimulation() {
    if (simulateInterval) return;
    status.value = 'Simulation started - fake sensor data';
    gyroGranted.value = true;
    geoGranted.value = true;

    // Fake calibration
    calibrationData.value = { accelMean: [0, 0, 9.81], gyroMean: [0, 0, 0] };
    initFilter();

    let time = 0;
    simulateInterval = setInterval(() => {
        time += 0.1;

        // Fake sensor data
        const fakeAccel = [0, 0, 9.81]; // gravity
        const fakeGyro = [0.1 * Math.sin(time), 0.1 * Math.cos(time), 0]; // slow rotation

        // Set debug data
        debugData.value = {
            acceleration: null,
            accelerationIncludingGravity: { x: fakeAccel[0]!, y: fakeAccel[1]!, z: fakeAccel[2]! },
            rotationRate: { alpha: fakeGyro[0]! * 180 / Math.PI, beta: fakeGyro[1]! * 180 / Math.PI, gamma: fakeGyro[2]! * 180 / Math.PI },
            interval: 100,
            timestamp: performance.now()
        };

        // Process as if event fired
        handleDeviceMotion({
            acceleration: null,
            accelerationIncludingGravity: { x: fakeAccel[0], y: fakeAccel[1], z: fakeAccel[2] },
            rotationRate: { alpha: fakeGyro[0]! * 180 / Math.PI, beta: fakeGyro[1]! * 180 / Math.PI, gamma: fakeGyro[2]! * 180 / Math.PI },
            interval: 100
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


    // Передаём new THREE.Scene() и THREE в функцию
    const inst = initRoughThreeScene(THREE, debugData, DVOData, calibrationData, info_phone, info_laccel, info_waccel, info_abody, info_gbody)
    roughDemoInstance = inst;
};

// ----------------------------- Lifecycle -----------------------------
onMounted(() => {
    requestSensorPermissions();
    // GPS is handled automatically by useGeolocation
});
</script>

<template>
    <ClientOnly>
        <div
            id="index-container"
            style="font-family: monospace; padding: 20px; background: #222; color: #0f0; min-height: 100vh; overflow-y: auto;"
        >
            <h2>Navigation INFO</h2>

            <div style="margin: 20px 0; padding: 10px; background: #111; border: 1px solid #0f0;">
                <strong>Status:</strong> {{ status }}
            </div>

            <!-- 3D Demo Button -->
            <div
                style="margin: 20px 0; padding: 15px; background: #1a1a1a; border: 2px solid #ffff00; text-align: center;">
                <!-- <button
                    v-if="!show3D"
                    @click="start3DDemo"
                    style="padding: 12px 30px; background: rgb(0 255 0); color: #000; border: none; cursor: pointer; font-weight: bold; font-size: 16px; border-radius: 5px;"
                >
                    Start 3D Demonstration
                </button>
                <button
                    v-if="!simulateInterval"
                    @click="startSimulation"
                    style="padding: 12px 30px; background: #00ffff; color: #000; border: none; cursor: pointer; font-weight: bold; font-size: 16px; border-radius: 5px; margin-left: 10px;"
                >
                    Simulate Sensors
                </button>
                НОВАЯ ТРЕТЬЯ КНОПКА — “ROUGH DEMO” -->
                <button
                    v-if="!show3D && !simulateInterval"
                    @click="startRoughDemo"
                    style="padding: 12px 30px; background: #ff9900; color: #000; border: none; cursor: pointer; font-weight: bold; font-size: 16px; border-radius: 5px; margin-left: 10px;"
                >
                    Start 3D Demo (Raw Data)
                </button>
            </div>

            <!-- 3D Container -->
            <div
                v-if="show3D"
                id="three-container"
                style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 100;"
            ></div>

            <!-- HUD над 3D‑окном -->
            <div
                v-if="show3D"
                class="three-hud"
                style="
                  width: 200px;
                  position: fixed; bottom: 40px; right: 20px;
                  z-index: 110;
                  font-family: monospace;
                  font-size: 10px;
                  color: #0f0;
                  background: #000a;
                  padding: 10px;
                  border-radius: 4px;
                  border: 1px solid white;
                  white-space: pre;
                  display: flex;
                  flex-direction: column;
                  gap: 4px;
                "
            >
                <!-- <p style="font-size: 12px;">EKF State Data</p>
                <p style="margin: 0;">Pos(m): [{{ xest.pos[0].toFixed(2) }}, {{ xest.pos[1].toFixed(2) }}, {{
                    xest.pos[2].toFixed(2) }}]</p>
                <p style="margin: 0;">Vel(m/s): [{{ xest.vel[0].toFixed(2) }}, {{ xest.vel[1].toFixed(2) }}, {{
                    xest.vel[2].toFixed(2) }}]</p>
                <p style="margin: 0;">Att(rad): [{{ xest.att[0].toFixed(2) }}, {{ xest.att[1].toFixed(2) }}, {{
                    xest.att[2].toFixed(2) }}]</p>
                <p style="margin: 0;">Bias Acc(m/s²): [{{ xest.biasAcc[0].toFixed(2) }}, {{ xest.biasAcc[1].toFixed(2)
                    }}, {{
                        xest.biasAcc[2].toFixed(2) }}]
                </p>
                <p style="margin: 0;">Bias Gyro(rad/s): [{{ xest.biasGyro[0].toFixed(2) }}, {{
                    xest.biasGyro[1].toFixed(2) }},
                    {{
                        xest.biasGyro[2].toFixed(2) }}]
                </p> -->

                <strong>Raw Sensor Data:</strong>
                <span :style="{ color: gyroGranted ? '#0f0' : '#888' }">
                    Accel: {{debugData?.acceleration ? [debugData.acceleration.x,
                    debugData.acceleration.y, debugData.acceleration.z].map(x => (x ||
                        0).toFixed(2)).join(', ') : 'null'}} m/s²<br>
                    Gyro: {{debugData?.rotationRate ? [debugData.rotationRate.alpha, debugData.rotationRate.beta,
                    debugData.rotationRate.gamma].map(x => (x || 0).toFixed(2)).join(', ') : 'null'}} deg/s
                    <br>
                    DVO: {{ DVOData }}
                    Position: {{info_phone?.position?.toArray()?.map(x => x.toFixed(2))}}
                </span>
                <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 16px;">
                    <button
                        v-if="show3D"
                        @click="close3D"
                        style="width: 100%; padding: 4px 12px; background: #ff6600; color: #000; border: none; cursor: pointer; font-weight: bold; font-size: 16px; border-radius: 5px;"
                    >
                        ✕ Close 3D View
                    </button>
                    <button
                        v-if="simulateInterval"
                        @click="stopSimulation"
                        style="width: 100%; padding: 12px 30px; background: #ff00ff; color: #000; border: none; cursor: pointer; font-weight: bold; font-size: 16px; border-radius: 5px; margin-left: 10px;"
                    >
                        Stop Simulation
                    </button>
                </div>
            </div>

            <div style="margin: 20px 0; padding: 15px; background: #1a1a1a; border: 1px solid #ff6600;">
                <strong>Sensor Permissions:</strong>
                <div style="margin-top: 10px;">
                    <div style="width: 100%; display: flex; margin-bottom: 10px;">
                        <strong>Accelerometer & Gyroscope:</strong>&nbsp;<span
                            :style="{ color: gyroGranted ? '#0f0' : '#f00' }"
                        >{{ gyroGranted ? '-- ACTIVE --' : '-X- INACTIVE -X-' }}</span>
                        <button
                            @click="requestSensorPermissions"
                            style="margin-left: auto; padding: 5px 10px; background: #ff6600; color: #000; border: none; cursor: pointer; font-weight: bold;"
                        >
                            Enable Gyro
                        </button>
                    </div>
                    <div style="width: 100%; display: flex;">
                        <strong>GPS:</strong>&nbsp;
                        <span :style="{ color: geoGranted ? '#0f0' : '#f00' }">
                            {{ geoGranted ? '-- ACTIVE --' : '-X- INACTIVE -X-' }}
                        </span>
                        <button
                            @click="requestGeoPermission"
                            style="margin-left: auto; padding: 5px 10px; background: #ff6600; color: #000; border: none; cursor: pointer; font-weight: bold;"
                        >
                            Enable GPS
                        </button>
                    </div>
                </div>
            </div>

            <!-- Metrics HUD -->
            <div style="margin: 20px 0; padding: 15px; background: #0a2a0a; border: 2px solid #0f0;">
                <strong>Live Metrics:</strong>
                <div style="margin-top: 10px; font-size: 14px;">
                    <div>FPS: <span style="color: #ffff00;">{{ fps }}</span></div>
                    <div>Trajectory Points: <span style="color: #ffff00;">{{ trajectory.length }}</span></div>
                    <div>RMSE: <span style="color: #ffff00;">{{ rmse }} m</span></div>
                </div>
            </div>

            <!-- State Vector -->
            <div style="margin: 20px 0; padding: 15px; background: #0a0a2a; border: 1px solid #0099ff;">
                <strong>🧭 Estimated State (15-DOF EKF):</strong>
                <div style="margin-top: 10px; font-size: 12px; line-height: 1.8;">
                    <strong style="color: #ffff00;">Position [m]:</strong><br>
                    X: {{ xest.pos[0].toFixed(4) }} | Y: {{ xest.pos[1].toFixed(4) }} | Z: {{ xest.pos[2].toFixed(4)
                    }}<br><br>
                    <strong style="color: #ffff00;">Velocity [m/s]:</strong><br>
                    X: {{ xest.vel[0].toFixed(4) }} | Y: {{ xest.vel[1].toFixed(4) }} | Z: {{ xest.vel[2].toFixed(4)
                    }}<br><br>
                    <strong style="color: #ffff00;">Attitude [rad]:</strong><br>
                    Roll: {{ xest.att[0].toFixed(4) }} | Pitch: {{ xest.att[1].toFixed(4) }} | Yaw: {{
                        xest.att[2].toFixed(4) }}<br><br>
                    <strong style="color: #ffff00;">Accel Bias [m/s²]:</strong><br>
                    X: {{ xest.biasAcc[0].toFixed(4) }} | Y: {{ xest.biasAcc[1].toFixed(4) }} | Z: {{
                        xest.biasAcc[2].toFixed(4) }}<br><br>
                    <strong style="color: #ffff00;">Gyro Bias [rad/s]:</strong><br>
                    X: {{ xest.biasGyro[0].toFixed(4) }} | Y: {{ xest.biasGyro[1].toFixed(4) }} | Z: {{
                        xest.biasGyro[2].toFixed(4) }}
                </div>
            </div>

            <!-- Raw Sensor Data -->
            <div style="margin-top: 40px; padding: 10px; background: #111; font-size: 12px;">
                <strong>Raw Sensor Data:</strong><br><br>
                <strong>IMU (Accel + Gyro):</strong><br>
                <span :style="{ color: gyroGranted ? '#0f0' : '#888' }">
                    Accel: {{debugData?.accelerationIncludingGravity ? [debugData.accelerationIncludingGravity.x,
                    debugData.accelerationIncludingGravity.y, debugData.accelerationIncludingGravity.z].map(x => (x ||
                        0).toFixed(2)).join(', ') : 'null'}} m/s²<br>
                    Gyro: {{debugData?.rotationRate ? [debugData.rotationRate.alpha, debugData.rotationRate.beta,
                    debugData.rotationRate.gamma].map(x => (x || 0).toFixed(2)).join(', ') : 'null'}} deg/s
                </span><br><br>
                <strong>Debug - Raw Sensor Event:</strong><br>
                <span style="font-size: 10px; color: #ffff00;">
                    <div v-if="debugData">
                        Accel: {{debugData.acceleration ? [debugData.acceleration.x, debugData.acceleration.y,
                        debugData.acceleration.z].map(x => x?.toFixed(2) || 'null').join(', ') : 'null'}}<br>
                        Accel+Grav: {{debugData.accelerationIncludingGravity ?
                            [debugData.accelerationIncludingGravity.x, debugData.accelerationIncludingGravity.y,
                            debugData.accelerationIncludingGravity.z].map(x => x?.toFixed(2) || 'null').join(', ') : 'null'
                        }}<br>
                        Gyro: {{debugData.rotationRate ? [debugData.rotationRate.alpha, debugData.rotationRate.beta,
                        debugData.rotationRate.gamma].map(x => x?.toFixed(2) || 'null').join(', ') : 'null'}} deg/s<br>
                        Interval: {{ debugData.interval?.toFixed(2) || 'null' }} ms
                    </div>
                    <div v-else>No sensor events received yet</div>
                </span><br><br>
                <strong>GPS Position:</strong><br>
                <span :style="{ color: geoGranted ? '#0f0' : '#888' }">
                    Lat: {{ latestGPS.pos?.[0]?.toFixed(5) || '0.00000' }}<br>
                    Lon: {{ latestGPS.pos?.[1]?.toFixed(5) || '0.00000' }}<br>
                    Alt: {{ latestGPS.pos?.[2]?.toFixed(2) || '0.00' }} m
                </span>
            </div>

            <!-- Trajectory Preview -->
            <div
                style="margin-top: 30px; padding: 10px; background: #111; font-size: 11px; max-height: 200px; overflow-y: auto;">
                <strong>📍 Trajectory (last 10 points):</strong><br>
                <div
                    v-for="(point, idx) in trajectory.slice(-10)"
                    :key="idx"
                    style="color: #0ff;"
                >
                    {{ (trajectory.length - 10 + idx).toString().padStart(4, ' ') }}:
                    [{{ point && point[0] !== undefined ? point[0].toFixed(3) : '0.000' }}, {{ point && point[1] !==
                        undefined ? point[1].toFixed(3) : '0.000' }}, {{ point && point[2] !== undefined ?
                        point[2].toFixed(3) : '0.000' }}]
                </div>
            </div>
        </div>
    </ClientOnly>
</template>

<style scoped>
button:hover {
    opacity: 0.8;
}
</style>
