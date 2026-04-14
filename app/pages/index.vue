<script
    setup
    lang="ts"
>
import { onMounted, ref, computed } from 'vue';
import { AEKFFilter } from '~/core/aekf';
import { useGeolocation } from '@vueuse/core'
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

// GPS через useGeolocation (всё, что нужно)
const { coords, locatedAt, error } = useGeolocation({
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 5000,
})

watch(
    error,
    (err) => {
        if (err) {
            geoGranted.value = false
            status.value = `⚠️ GPS error: ${err.message}`
        }
    }
)

// Обновление latestGPS по geo
watch(
    () => coords.value,
    (c) => {
        if (!c) return

        latestGPS.value = {
            pos: [c.latitude, c.longitude, c.altitude ?? 0],
            ts: performance.now(),
        }

        geoGranted.value = true
        if (!status.value.includes('GPS OK')) {
            status.value = `GPS OK: ${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)} | ${Math.floor(c.accuracy)}m`
        }
    },
    { immediate: true }
)


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

            const now = performance.now()
            if (latestGPS.value.ts - now > -1000) {
                const gps = geoGranted.value ? latestGPS.value : { pos: [0, 0, 0], ts: 0 }
                // Здесь можно делать дополнительную привязку к xest или отдельный geo‑фильтр
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
                status.value = 'Gyro access granted!';
            } else {
                status.value = 'X Gyro access denied';
            }
        } else {
            // Android/others - already have permission if devicemotion fires
            gyroGranted.value = true;
            status.value = 'Gyro access active';
        }
    } catch (error) {
        console.error('Gyro permission error:', error);
        status.value = 'X Gyro permission failed';
    }
};

const requestGeoPermission = async () => {
    try {
        if (!navigator.geolocation) {
            status.value = 'X Geolocation not available';
            return;
        }

        status.value = 'Getting GPS/WiFi fix... (15-60s)';

        const options = {
            enableHighAccuracy: true,
            timeout: 5000,        // 5s на поиск GPS‑сигнала
            maximumAge: 500,     // 1s — готов брать свежие данные
        }

        navigator.geolocation.getCurrentPosition(
            (position) => {
                geoGranted.value = true;
                latestGPS.value = {
                    pos: [position.coords.latitude, position.coords.longitude, position.coords.altitude || 0],
                    ts: performance.now(),
                };
                status.value = `GPS OK: ${position.coords.latitude.toFixed(5)}, ${position.coords.longitude.toFixed(5)} | accuracy: ${position.coords.accuracy}m`;

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
                status.value = 'Using WiFi location...';
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
        status.value = 'X GPS failed';
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

    const THREE = THREEModule.default || THREEModule;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111111);
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(renderer.domElement);

    camera.position.set(1, 1, 1);
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

    // 75mm x 155mm x 8mm phone (в метрах: 0.075 x 0.155 x 0.008)
    const phoneWidth = 0.075;   // X
    const phoneHeight = 0.155;  // Y
    const phoneDepth = 0.008;   // Z

    const cubeGeometry = new THREE.BoxGeometry(phoneWidth, phoneHeight, phoneDepth);
    const cubeMaterial = new THREE.MeshBasicMaterial({ color: 0x00aaff, opacity: 0.7, transparent: true });
    const phoneCube = new THREE.Mesh(cubeGeometry, cubeMaterial);
    scene.add(phoneCube);

    // Wireframe wrapper (EdgesGeometry)
    const edgesGeometry = new THREE.EdgesGeometry(cubeGeometry, 5); // 5° — угол для граней
    const wireMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 2 });
    const wireframe = new THREE.LineSegments(edgesGeometry, wireMaterial);
    phoneCube.add(wireframe); // wireframe «привязан» к кубу, вращается вместе

    // Animation loop
    const animate = () => {
        requestAnimationFrame(animate);

        const positions = trajectory.value.map(p => [p[0] || 0, p[1] || 0, p[2] || 0]).flat();
        trajectoryGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));

        const pos = xest.value.pos;
        const att = xest.value.att;

        phoneCube.position.set(pos[0], pos[1], pos[2]);

        // Устанавливаем ориентацию куба по att (roll, pitch, yaw)
        const rotation = new THREE.Euler(att[0], att[1], att[2], 'XYZ');
        phoneCube.quaternion.setFromEuler(rotation);

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
                  font-size: 12px;
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
                <p>🧭 EKF State (phone cube)</p>
                <p>Pos: [{{ xest.pos[0].toFixed(2) }}, {{ xest.pos[1].toFixed(2) }}, {{ xest.pos[2].toFixed(2) }}]</p>
                <p>Vel: [{{ xest.vel[0].toFixed(2) }}, {{ xest.vel[1].toFixed(2) }}, {{ xest.vel[2].toFixed(2) }}]</p>
                <p>Att: [{{ xest.att[0].toFixed(2) }}, {{ xest.att[1].toFixed(2) }}, {{ xest.att[2].toFixed(2) }}]</p>
                <p>
                    Bias Acc: [{{ xest.biasAcc[0].toFixed(2) }}, {{ xest.biasAcc[1].toFixed(2) }}, {{
                        xest.biasAcc[2].toFixed(2) }}]
                </p>
                <p>
                    Bias Gyro: [{{ xest.biasGyro[0].toFixed(2) }}, {{ xest.biasGyro[1].toFixed(2) }}, {{
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
