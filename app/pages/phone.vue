<script
    setup
    lang="ts"
>
import Peer from 'peerjs';

const peerId = ref('sensor-phone-' + Math.random().toString(36).substr(2, 9));
const peer = new Peer(peerId.value);
const status = ref('Waiting PC...');
const latestIMU = ref({ accel: [0, 0, 0], gyro: [0, 0, 0], ts: 0 });
const latestGPS = ref({ pos: [0, 0, 0], ts: 0 });

peer.on('open', (id) => {
    status.value = 'ID: ' + id + '\nSend IMU/GPS';
});

// Device motion for IMU
window.addEventListener('devicemotion', (event) => {
    if (event.acceleration && event.rotationRate) {
        latestIMU.value = {
            accel: [event.acceleration.x || 0, event.acceleration.y || 0, event.acceleration.z || 0],
            gyro: [event.rotationRate.alpha || 0, event.rotationRate.beta || 0, event.rotationRate.gamma || 0],
            ts: performance.now()
        };
    }
});

// Geolocation for GPS
if (navigator.geolocation) {
    navigator.geolocation.watchPosition((position) => {
        latestGPS.value = {
            pos: [position.coords.latitude, position.coords.longitude, position.coords.altitude || 0],
            ts: performance.now()
        };
    }, (error) => {
        console.error('GPS error', error);
    }, { enableHighAccuracy: true, maximumAge: 100, timeout: 5000 });
}

peer.on('connection', (conn) => {
    status.value += '\nPC Connected!';

    const loop = () => {
        const motion = {
            accel: latestIMU.value.accel,
            gyro: latestIMU.value.gyro,
            ts: latestIMU.value.ts
        };

        if (conn.open) conn.send(motion);

        requestAnimationFrame(loop);
    };

    loop();
});
</script>


<template>
    <div id="status">ID: {{ peerId }}<br>Status: {{ status }}</div>
</template>

<style>
body {
    font-family: monospace;
    padding: 20px;
    background: #222;
    color: #0f0;
}
</style>