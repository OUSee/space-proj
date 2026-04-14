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
const gyroGranted = ref(false);
const geoGranted = ref(false);
const show3D = ref(false);
const isCalibrating = ref(false);
const calibrationData = ref<{ accelMean: number[]; gyroMean: number[] } | null>(null);

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
            if (e.acceleration) {
                accelSamples.push([e.acceleration.x || 0, e.acceleration.y || 0, e.acceleration.z || 0]);
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

function handleDeviceMotion(event: DeviceMotionEvent) {
    if (!filterInstance || !gyroGranted.value || isCalibrating.value) return;

    const now = performance.now();
    const dt = lastTimestamp ? Math.min(0.1, (now - lastTimestamp) / 1000) : 0.01;
    lastTimestamp = now;

    // Raw readings
    let accel: [number, number, number] = [
        event.acceleration?.x ?? 0,
        event.acceleration?.y ?? 0,
        event.acceleration?.z ?? 0
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

// ----------------------------- Permissions -----------------------------
async function requestGyroPermission() {
    try {
        if (typeof (DeviceMotionEvent as any).requestPermission === 'function') {
            const permission = await (DeviceMotionEvent as any).requestPermission();
            if (permission === 'granted') {
                gyroGranted.value = true;
                status.value = 'Gyro access granted';
                window.addEventListener('devicemotion', handleDeviceMotion);
            } else {
                status.value = 'Gyro access denied';
            }
        } else {
            gyroGranted.value = true;
            status.value = 'Gyro access active (no permission needed)';
            window.addEventListener('devicemotion', handleDeviceMotion);
        }
    } catch (error) {
        console.error(error);
        status.value = 'Gyro permission error';
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
    initThreeScene(THREE);
};

const close3D = () => {
    show3D.value = false;
    const container = document.getElementById('three-container');
    if (container) {
        const canvas = container.querySelector('canvas');
        if (canvas) container.removeChild(canvas);
    }
};

// ----------------------------- Three.js Scene -----------------------------
const initThreeScene = (THREEModule: any) => {
    const container = document.getElementById('three-container');
    if (!container) return;

    const THREE = THREEModule.default || THREEModule;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111122);
    scene.fog = new THREE.FogExp2(0x111122, 0.008);

    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);

    // Lights
    const ambientLight = new THREE.AmbientLight(0x404060);
    scene.add(ambientLight);
    const mainLight = new THREE.DirectionalLight(0xffffff, 1);
    mainLight.position.set(2, 5, 3);
    mainLight.castShadow = true;
    scene.add(mainLight);
    const fillLight = new THREE.PointLight(0x4466cc, 0.3);
    fillLight.position.set(-1, 2, 2);
    scene.add(fillLight);

    // Ground grid
    const gridHelper = new THREE.GridHelper(30, 20, 0x88aaff, 0x335588);
    gridHelper.position.y = -0.01;
    scene.add(gridHelper);

    // Axes helper (optional)
    const axesHelper = new THREE.AxesHelper(5);
    scene.add(axesHelper);

    // Phone model (0.075 x 0.155 x 0.008 m)
    const geometry = new THREE.BoxGeometry(0.075, 0.155, 0.008);
    const material = new THREE.MeshStandardMaterial({ color: 0x3a86ff, metalness: 0.7, roughness: 0.3 });
    const phone = new THREE.Mesh(geometry, material);
    phone.castShadow = true;
    scene.add(phone);

    // White edges
    const edgesGeo = new THREE.EdgesGeometry(geometry);
    const edgesMat = new THREE.LineBasicMaterial({ color: 0xffffff });
    const wireframe = new THREE.LineSegments(edgesGeo, edgesMat);
    phone.add(wireframe);

    // Trajectory line and particles
    const trailPoints: any[] = [];
    const trailLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x00ff99 }));
    scene.add(trailLine);
    const particleGeo = new THREE.BufferGeometry();
    const particleMat = new THREE.PointsMaterial({ color: 0x00ff99, size: 0.03 });
    const particles = new THREE.Points(particleGeo, particleMat);
    scene.add(particles);

    let lastPos = new THREE.Vector3();

    const animate = () => {
        requestAnimationFrame(animate);

        const pos = xest.value.pos;
        const att = xest.value.att;
        phone.position.set(pos[0], pos[1], pos[2]);
        phone.rotation.set(att[0], att[1], att[2], 'XYZ');

        // Update trail
        const currentPos = new THREE.Vector3(pos[0], pos[1], pos[2]);
        if (trailPoints.length === 0 || currentPos.distanceTo(lastPos) > 0.02) {
            trailPoints.push(currentPos.clone());
            if (trailPoints.length > 200) trailPoints.shift();
            const positions = trailPoints.flatMap(p => [p.x, p.y, p.z]);
            trailLine.geometry.dispose();
            trailLine.geometry = new THREE.BufferGeometry();
            trailLine.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));

            particleGeo.dispose();
            const particlePositions = trailPoints.flatMap(p => [p.x, p.y, p.z]);
            particleGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(particlePositions), 3));
            lastPos.copy(currentPos);
        }

        // Camera follow (third-person relative to phone orientation)
        const offset = new THREE.Vector3(-0.5, 0.3, 0.8);
        offset.applyQuaternion(phone.quaternion);
        camera.position.copy(phone.position.clone().add(offset));
        camera.lookAt(phone.position);

        renderer.render(scene, camera);
    };
    animate();

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });
};

// ----------------------------- Lifecycle -----------------------------
onMounted(() => {
    requestGyroPermission();
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
                <button
                    v-if="!show3D"
                    @click="start3DDemo"
                    style="padding: 12px 30px; background: rgb(0 255 0); color: #000; border: none; cursor: pointer; font-weight: bold; font-size: 16px; border-radius: 5px;"
                >
                    Start 3D Demonstration
                </button>
                <button
                    v-else
                    @click="close3D"
                    style="padding: 12px 30px; background: #ff6600; color: #000; border: none; cursor: pointer; font-weight: bold; font-size: 16px; border-radius: 5px;"
                >
                    ✕ Close 3D View
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
                  position: fixed; bottom: 20px; right: 20px;
                  z-index: 110;
                  font-family: monospace;
                  font-size: 10px;
                  color: #0f0;
                  background: #000a;
                  padding: 10px;
                  border-radius: 4px;
                  border: 1px solid white;
                  white-space: pre;
                  pointer-events: none;
                  display: flex;
                  flex-direction: column;
                  gap: 4px;
                "
            >
                <p style="font-size: 12px;">EKF State Data</p>
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
                </p>
            </div>

            <div style="margin: 20px 0; padding: 15px; background: #1a1a1a; border: 1px solid #ff6600;">
                <strong>Sensor Permissions:</strong>
                <div style="margin-top: 10px;">
                    <div style="width: 100%; display: flex; margin-bottom: 10px;">
                        <strong>Accelerometer & Gyroscope:</strong>&nbsp;<span
                            :style="{ color: gyroGranted ? '#0f0' : '#f00' }"
                        >{{ gyroGranted ? '-- ACTIVE --' : '-X- INACTIVE -X-' }}</span>
                        <button
                            @click="requestGyroPermission"
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
                            @click="requestGyroPermission"
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
                    Accel: {{latestIMU.accel.map(x => x.toFixed(2)).join(', ')}} m/s²<br>
                    Gyro: {{latestIMU.gyro.map(x => x.toFixed(2)).join(', ')}} rad/s
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
