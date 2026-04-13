<script
    setup
    lang="ts"
>
import * as THREE from 'three';
import { OrbitControls } from 'three-stdlib';
import { ref, computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useNavStore } from '~/composables/useNavStore';

const canvas = ref<HTMLCanvasElement>();
const store = useNavStore();
let scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGLRenderer,
    controls: any,
    phone: THREE.Group,
    trajectoryLine: THREE.Line;

const { rmse, fps } = storeToRefs(store);
const pos = computed(() => store.xest.pos[0] || 0);

onMounted(async () => {
    // init scene, camera, phone model (box 0.15x0.3), trajectory line, OrbitControls, animate loop 60 FPS
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    renderer = new THREE.WebGLRenderer({ canvas: canvas.value });
    renderer.setSize(window.innerWidth, window.innerHeight);
    controls = new OrbitControls(camera, renderer.domElement);
    // Add phone model
    phone = new THREE.Group();
    const phoneGeo = new THREE.BoxGeometry(1.55, 0.75, 0.08);
    const phoneMat = new THREE.MeshLambertMaterial({ color: 0x333333 });
    const phoneMesh = new THREE.Mesh(phoneGeo, phoneMat);

    // 2. Отдельный wireframe overlay
    const edges = new THREE.EdgesGeometry(phoneGeo);  // Или WireframeGeometry
    const lineMat = new THREE.LineBasicMaterial({ color: 0x00ff88, linewidth: 2 });
    const wireframe = new THREE.LineSegments(edges, lineMat);
    phoneMesh.add(wireframe);  // Прикрепи к mesh (синхронно позиция/ротация
    phone.add(phoneMesh);
    scene.add(phone);
    // Trajectory line
    const trajGeometry = new THREE.BufferGeometry();
    trajectoryLine = new THREE.Line(trajGeometry, new THREE.LineBasicMaterial({ color: 0xff0000 }));
    scene.add(trajectoryLine);
    camera.position.z = 5;
    // Animation loop
    let lastTime = 0;
    const animate = (time: number) => {
        requestAnimationFrame(animate);
        const delta = time - lastTime;
        fps.value = 1000 / delta;
        lastTime = time;
        controls.update();
        renderer.render(scene, camera);
    };
    animate(0);
});

watch(() => store.xest, (newState) => {
    if (phone && newState) {
        // update phone.position from pos ENU->Three.js, trajectory buffer
        phone.position.set(newState.pos[0], newState.pos[1], newState.pos[2]);
        // Update trajectory
        store.trajectory.push([...newState.pos]);
        if (store.trajectory.length > 1000) store.trajectory.shift();
        // Update line geometry
        const positions = new Float32Array(store.trajectory.flat());
        trajectoryLine.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        if (trajectoryLine.geometry.attributes.position) {
            trajectoryLine.geometry.attributes.position.needsUpdate = true;
        }
    }
});
</script>

<template>
    <div class="visualizer">
        <canvas
            ref="canvas"
            class="three-canvas"
        />
        <div class="hud">
            <div>Pos: {{ pos.toFixed(2) }} m</div>
            <div>RMSE: {{ rmse.toFixed(3) }} m</div>
            <div>FPS: {{ fps.toFixed(2) }}</div>
        </div>
    </div>
</template>

<style>
.three-canvas {
    width: 100%;
    height: 500px;
}

.hud {
    width: 200px;
    position: absolute;
    right: 10px;
    bottom: 10px;
    color: white;
    background: rgba(0, 0, 0, 0.7);
    padding: 15px;
    border: 1px solid white;
    border-radius: 10px;
}
</style>

<style
    scoped
    lang='scss'
></style>