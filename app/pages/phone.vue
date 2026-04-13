<script
    setup
    lang="ts"
>
import { onMounted, ref } from 'vue';

const peerId = ref('sensor-phone-' + Math.random().toString(36).substr(2, 9));
const status = ref('Waiting PC...');
const latestIMU = ref({ accel: [0, 0, 0], gyro: [0, 0, 0], ts: 0 });
const latestGPS = ref({ pos: [0, 0, 0], ts: 0 });
const pendingConnection = ref<any>(null);
const connectedPcId = ref('');
const gyroGranted = ref(false);
const geoGranted = ref(false);

onMounted(async () => {
    if (typeof window === 'undefined') return;

    const PeerModule = await import('peerjs');
    const Peer = PeerModule.default;
    const peer = new Peer(peerId.value, {
        host: '192.168.0.46',  // ← Тот же PC IP!
        port: 9000,
        path: '/',
        debug: 2,
        secure: true, // ← HTTP, НЕ wss!
        config: {
            iceServers: [
                // ← Обязательно для local!
                { urls: 'stun:stun.l.google.com:19302' },
            ],
        },
    });

    peer.on('open', (id: string) => {
        status.value = 'Ready for connection';
        console.log('Phone Peer initialized:', id);
    });

    peer.on('error', (err: any) => {
        console.error('Phone Peer error:', err);
        status.value = 'Peer Error: ' + err.type;
    });

    window.addEventListener('devicemotion', (event) => {
        if (event.acceleration && event.rotationRate) {
            latestIMU.value = {
                accel: [event.acceleration.x || 0, event.acceleration.y || 0, event.acceleration.z || 0],
                gyro: [event.rotationRate.alpha || 0, event.rotationRate.beta || 0, event.rotationRate.gamma || 0],
                ts: performance.now(),
            };
        }
    });

    // Note: Geolocation is now requested via button to avoid permission denials

    peer.on('connection', (conn: any) => {
        console.log('Incoming connection from PC:', conn.peer);
        pendingConnection.value = conn;
        status.value = 'PC Requesting connection...';

        conn.on('close', () => {
            console.log('Connection closed');
            connectedPcId.value = '';
            status.value = 'Ready for connection';
        });

        conn.on('error', (err: any) => {
            console.error('Connection error:', err);
            status.value = 'Connection Error';
        });
    });
});

const authorize = () => {
    if (pendingConnection.value) {
        pendingConnection.value.on('open', () => {
            status.value = 'Connected to PC';
            connectedPcId.value = pendingConnection.value.peer;

            const loop = () => {
                const motion = {
                    accel: latestIMU.value.accel,
                    gyro: latestIMU.value.gyro,
                    ts: latestIMU.value.ts,
                };

                if (pendingConnection.value?.open) {
                    pendingConnection.value.send(motion);
                }
                requestAnimationFrame(loop);
            };

            loop();
        });
        pendingConnection.value = null;
    }
};

const reject = () => {
    if (pendingConnection.value) {
        pendingConnection.value.close();
        pendingConnection.value = null;
        status.value = 'Connection rejected';
    }
};

const copyId = () => {
    navigator.clipboard.writeText(peerId.value);
    status.value = 'ID copied!';
    setTimeout(() => {
        status.value = 'Ready for connection';
    }, 2000);
};

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

                // WiFi fallback watch (быстрые обновления)
                navigator.geolocation.watchPosition(
                    (pos) => {
                        latestGPS.value = {
                            pos: [pos.coords.latitude, pos.coords.longitude, pos.coords.altitude || 0],
                            ts: performance.now(),
                        };
                    },
                    (err) => console.log('Watch timeout OK (normal indoor)'),
                    {
                        enableHighAccuracy: false,  // WiFi/Network fallback
                        timeout: 30000,             // 30s
                        maximumAge: 10000           // Кэш 10s
                    }
                );
            },
            (error) => {
                console.error('GPS error:', error.code, error.message);
                // Fallback: Network location (WiFi)
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
                        enableHighAccuracy: false,  // WiFi + cell towers
                        timeout: 30000,
                        maximumAge: 60000
                    }
                );
            },
            {
                enableHighAccuracy: true,
                timeout: 45000,          // 45 сек на GPS fix
                maximumAge: 30000        // Кэш 30 сек
            }
        );
    } catch (error) {
        status.value = '✗ GPS failed';
    }
};
onMounted(() => {
    requestGyroPermission();
    requestGeoPermission();
})
</script>


<template>
    <ClientOnly>
        <div
            id="phone-container"
            style="font-family: monospace; padding: 20px; background: #222; color: #0f0; min-height: 100vh;"
        >
            <h2>📱 Sensor Phone</h2>
            <div style="margin: 20px 0; padding: 10px; background: #111; border: 1px solid #0f0;">
                <strong>Your ID:</strong><br>
                <code>{{ peerId }}</code>
                <button
                    @click="copyId"
                    style="margin-left: 10px; padding: 5px 10px; background: #0f0; color: #000; border: none; cursor: pointer;"
                >
                    Copy
                </button>
            </div>

            <div style="margin: 20px 0; padding: 10px; background: #111; border: 1px solid #0f0;">
                <strong>Status:</strong> {{ status }}
            </div>

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

            <div
                v-if="pendingConnection"
                style="margin: 20px 0; padding: 15px; background: #1a1a1a; border: 2px solid #ff0;"
            >
                <strong>⚠️ PC is requesting a connection!</strong>
                <div style="margin-top: 10px;">
                    <button
                        @click="authorize"
                        style="margin-right: 10px; padding: 8px 16px; background: #0f0; color: #000; border: none; cursor: pointer; font-weight: bold;"
                    >
                        ✓ Authorize
                    </button>
                    <button
                        @click="reject"
                        style="padding: 8px 16px; background: #f00; color: #fff; border: none; cursor: pointer; font-weight: bold;"
                    >
                        ✗ Reject
                    </button>
                </div>
            </div>

            <div
                v-if="connectedPcId"
                style="margin: 20px 0; padding: 10px; background: #001a00; border: 1px solid #0f0;"
            >
                <strong>Connected to PC:</strong> {{ connectedPcId }}<br>
                📡 Streaming sensor data...
            </div>

            <div style="margin-top: 40px; padding: 10px; background: #111; font-size: 12px;">
                <strong>📊 Sensor Data:</strong><br><br>
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
        </div>
    </ClientOnly>
</template>

<style scoped>
button:hover {
    opacity: 0.8;
}
</style>