<script
    setup
    lang="ts"
>
import { onMounted, ref, computed } from 'vue';
import { AEKFFilter } from '~/core/aekf';
import type { IMUData, StateVector } from '~/types';

// Refs for UI
const status = ref('Initializing...');
const gyroGranted = ref(false);
const geoGranted = ref(false);
const show3D = ref(false);

// Sensor data
const latestIMU = ref<IMUData>({ accel: [0, 0, 0], gyro: [0, 0, 0], ts: 0 });
const latestGPS = ref({ pos: [0, 0, 0], ts: 0 });

// Filter & calculations
const filter = ref<AEKFFilter | null>(null);
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
        if (pos && pos[0] !== undefined && pos[1] !== undefined && pos[2] !== undefined) {
            sum += pos[0] * pos[0] + pos[1] * pos[1] + pos[2] * pos[2];
        }
    }
    return Math.sqrt(sum / trajectory.value.length).toFixed(3);
});

onMounted(async () => {
    if (typeof window === 'undefined') return;

    // Initialize EKF filter
    const Q = Array.from({ length: 15 }, () => Array(15).fill(0.01));
    const R = Array.from({ length: 3 }, () => Array(3).fill(0.1));
    filter.value = new AEKFFilter(0.01, Q, R);

    status.value = 'Ready - processing locally';

    // Capture IMU data
    window.addEventListener('devicemotion', (event) => {
        if (event.acceleration && event.rotationRate) {
            latestIMU.value = {
                accel: [event.acceleration.x || 0, event.acceleration.y || 0, event.acceleration.z || 0],
                gyro: [event.rotationRate.alpha || 0, event.rotationRate.beta || 0, event.rotationRate.gamma || 0],
                ts: performance.now(),
            };

            // Process through filter
            if (filter.value && gyroGranted.value) {
                const result = filter.value.predict(latestIMU.value);
                xest.value.pos = result.xpred.slice(0, 3) as [number, number, number];
                xest.value.vel = result.xpred.slice(3, 6) as [number, number, number];
                xest.value.att = result.xpred.slice(6, 9) as [number, number, number];
                xest.value.biasAcc = result.xpred.slice(9, 12) as [number, number, number];
                xest.value.biasGyro = result.xpred.slice(12, 15) as [number, number, number];

                trajectory.value.push([...xest.value.pos]);
                if (trajectory.value.length > 2000) trajectory.value.shift();

                frameCount.value++;
                lastFrameTime.value = performance.now();
            }
        }
    });

    requestGyroPermission();
    requestGeoPermission();
});

const requestGyroPermission = async () => {
    try {
        if (typeof window === 'undefined') return;

        // iOS 13+
        if (typeof (DeviceMotionEvent as any)?.requestPermission === 'function') {
            const permission = await (DeviceMotionEvent as any).requestPermission();
            if (permission === 'granted') {
                gyroGranted.value = true;
                status.value = '✓ Gyro access granted!';
            } else {
                status.value = '✗ Gyro access denied';
            }
        } else {
            // Android/others - already have permission if devicemotion fires
            gyroGranted.value = true;
            status.value = '✓ Gyro access active';
        }
    } catch (error) {
        console.error('Gyro permission error:', error);
        status.value = '✗ Gyro permission failed';
    }
};

const requestGeoPermission = async () => {
    try {
        if (!navigator.geolocation) {
            status.value = '✗ Geolocation not available';
            return;
        }

        status.value = '🔄 Getting GPS/WiFi fix... (15-60s)';

        navigator.geolocation.getCurrentPosition(
            (position) => {
                geoGranted.value = true;
                latestGPS.value = {
                    pos: [position.coords.latitude, position.coords.longitude, position.coords.altitude || 0],
                    ts: performance.now(),
                };
                status.value = `✓ GPS OK: ${position.coords.latitude.toFixed(5)}, ${position.coords.longitude.toFixed(5)} | accuracy: ${position.coords.accuracy}m`;

                // WiFi fallback watch
                navigator.geolocation.watchPosition(
                    (pos) => {
                        latestGPS.value = {
                            pos: [pos.coords.latitude, pos.coords.longitude, pos.coords.altitude || 0],
                            ts: performance.now(),
                        };
                    },
                    (err) => console.log('Watch timeout OK (normal indoor)'),
                    {
                        enableHighAccuracy: false,
                        timeout: 30000,
                        maximumAge: 10000
                    }
                );
            },
            (error) => {
                console.error('GPS error:', error.code, error.message);
                status.value = '📶 Using WiFi location...';
                navigator.geolocation.getCurrentPosition(
                    (pos) => {
                        geoGranted.value = true;
                        latestGPS.value.pos = [pos.coords.latitude, pos.coords.longitude, pos.coords.altitude || 0];
                        status.value = `✓ WiFi OK: ${pos.coords.accuracy < 100 ? 'Good' : 'Rough'} (${pos.coords.accuracy}m)`;
                    },
                    () => {
                        status.value = '⚠️ No GPS/WiFi - outdoors recommended';
                    },
                    {
                        enableHighAccuracy: false,
                        timeout: 30000,
                        maximumAge: 60000
                    }
                );
            },
            {
                enableHighAccuracy: true,
                timeout: 45000,
                maximumAge: 30000
            }
        );
    } catch (error) {
        status.value = '✗ GPS failed';
    }
};

const start3DDemo = async () => {
    show3D.value = true;
    // Dynamic import of Three.js for 3D visualization
    const THREE = await import('three');
    initThreeScene(THREE);
};

const initThreeScene = (THREEModule: any) => {
    const container = document.getElementById('three-container');
    if (!container) return;

    // THREE is the default export or named export from the three module
    const THREE = THREEModule.default || THREEModule;

    // Scene setup
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111111);
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(renderer.domElement);

    camera.position.set(5, 5, 5);
    camera.lookAt(0, 0, 0);

    // Grid
    const gridHelper = new THREE.GridHelper(20, 20);
    scene.add(gridHelper);

    // Axes
    const axesHelper = new THREE.AxesHelper(5);
    scene.add(axesHelper);

    // Trajectory line
    const trajectoryGeometry = new THREE.BufferGeometry();
    const trajectoryMaterial = new THREE.LineBasicMaterial({ color: 0x00ff00 });
    const trajectoryLine = new THREE.Line(trajectoryGeometry, trajectoryMaterial);
    scene.add(trajectoryLine);

    // Current position sphere
    const sphereGeometry = new THREE.SphereGeometry(0.2, 8, 8);
    const sphereMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const currentPositionSphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
    scene.add(currentPositionSphere);

    // Animation loop
    const animate = () => {
        requestAnimationFrame(animate);

        // Update trajectory
        const positions = trajectory.value.map(p => [p[0] || 0, p[1] || 0, p[2] || 0]).flat();
        trajectoryGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));

        // Update current position
        currentPositionSphere.position.set(xest.value.pos[0], xest.value.pos[1], xest.value.pos[2]);

        renderer.render(scene, camera);
    };

    animate();

    // Handle window resize
    const onWindowResize = () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', onWindowResize);
};

const close3D = () => {
    show3D.value = false;
    const container = document.getElementById('three-container');
    if (container) {
        const canvas = container.querySelector('canvas');
        if (canvas) container.removeChild(canvas);
    }
};
</script>

<template>
    <ClientOnly>
        <div
            id="index-container"
            style="font-family: monospace; padding: 20px; background: #222; color: #0f0; min-height: 100vh; overflow-y: auto;"
        >
            <h2>🚀 Navigation Dashboard</h2>

            <div style="margin: 20px 0; padding: 10px; background: #111; border: 1px solid #0f0;">
                <strong>Status:</strong> {{ status }}
            </div>

            <!-- 3D Demo Button -->
            <div
                style="margin: 20px 0; padding: 15px; background: #1a1a1a; border: 2px solid #ffff00; text-align: center;">
                <button
                    v-if="!show3D"
                    @click="start3DDemo"
                    style="padding: 12px 30px; background: #ffff00; color: #000; border: none; cursor: pointer; font-weight: bold; font-size: 16px; border-radius: 5px;"
                >
                    🎮 Start 3D Demonstration
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

            <div style="margin: 20px 0; padding: 15px; background: #1a1a1a; border: 1px solid #ff6600;">
                <strong>📍 Sensor Permissions:</strong>
                <div style="margin-top: 10px;">
                    <div style="margin-bottom: 10px;">
                        <strong>Accelerometer & Gyroscope:</strong> <span
                            :style="{ color: gyroGranted ? '#0f0' : '#f00' }"
                        >{{ gyroGranted ? '✓ ACTIVE' : '✗ INACTIVE' }}</span>
                        <button
                            @click="requestGyroPermission"
                            style="margin-left: 10px; padding: 5px 10px; background: #ff6600; color: #000; border: none; cursor: pointer; font-weight: bold;"
                        >
                            Enable Gyro
                        </button>
                    </div>
                    <div>
                        <strong>GPS:</strong>
                        <span :style="{ color: geoGranted ? '#0f0' : '#f00' }">
                            {{ geoGranted ? '✓ ACTIVE' : '✗ INACTIVE' }}
                        </span>
                        <button
                            @click="requestGeoPermission"
                            style="margin-left: 10px; padding: 5px 10px; background: #ff6600; color: #000; border: none; cursor: pointer; font-weight: bold;"
                        >
                            Enable GPS
                        </button>
                    </div>
                </div>
            </div>

            <!-- Metrics HUD -->
            <div style="margin: 20px 0; padding: 15px; background: #0a2a0a; border: 2px solid #0f0;">
                <strong>📊 Live Metrics:</strong>
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
                <strong>📊 Raw Sensor Data:</strong><br><br>
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
