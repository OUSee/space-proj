// ----------------------------- Three.js Scene -----------------------------

export const initThreeScene = (THREEModule: any, debugData: any, xest: any) => {
	const container = document.getElementById('three-container');
	if (!container) return;

	const THREE = THREEModule.default || THREEModule;
	const scene = new THREE.Scene();
	scene.background = new THREE.Color(0x111122);
	scene.fog = new THREE.FogExp2(0x111122, 0.008);

	const camera = new THREE.PerspectiveCamera(
		60,
		window.innerWidth / window.innerHeight,
		0.1,
		1000,
	);
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
	const geometry = new THREE.BoxGeometry(0.075, 0.008, 0.155);
	const material = new THREE.MeshStandardMaterial({
		color: 0x3a86ff,
		metalness: 0.7,
		roughness: 0.3,
	});
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
	const trailLine = new THREE.Line(
		new THREE.BufferGeometry(),
		new THREE.LineBasicMaterial({ color: 0x00ff99 }),
	);
	scene.add(trailLine);
	const particleGeo = new THREE.BufferGeometry();
	const particleMat = new THREE.PointsMaterial({
		color: 0x00ff99,
		size: 0.03,
	});
	const particles = new THREE.Points(particleGeo, particleMat);
	scene.add(particles);

	let lastPos = new THREE.Vector3();

	const animate = () => {
		requestAnimationFrame(animate);

		// const pos = xest.value.pos;
		// const att = xest.value.att;
		// phone.position.set(pos[0], pos[1], pos[2]);
		// phone.rotation.set(att[0], att[1], att[2], 'XYZ');

		// // Update trail
		// const currentPos = new THREE.Vector3(pos[0], pos[1], pos[2]);
		// if (trailPoints.length === 0 || currentPos.distanceTo(lastPos) > 0.005) {
		//     trailPoints.push(currentPos.clone());
		//     if (trailPoints.length > 200) trailPoints.shift();
		//     const positions = trailPoints.flatMap(p => [p.x, p.y, p.z]);
		//     trailLine.geometry.dispose();
		//     trailLine.geometry = new THREE.BufferGeometry();
		//     trailLine.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));

		//     particleGeo.dispose();
		//     const particlePositions = trailPoints.flatMap(p => [p.x, p.y, p.z]);
		//     particleGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(particlePositions), 3));
		//     lastPos.copy(currentPos);
		// }

		// // Camera follow (third-person relative to phone orientation)
		// const offset = new THREE.Vector3(-0.5, 0.3, 0.8);
		// offset.applyQuaternion(phone.quaternion);
		// camera.position.copy(phone.position.clone().add(offset));
		// camera.lookAt(phone.position);

		// renderer.render(scene, camera);

		const accel = debugData.value?.accelerationIncludingGravity;
		if (accel) {
			const [ax, ay, az] = [accel.x ?? 0, accel.y ?? 0, accel.z ?? 0];

			// 9.81 – гравитация; если ты поднимаешь телефон, az < 9.81
			const lift = (9.81 - az) * 0.01; // 0.01 – коэффициент для демки

			const MAX_HEIGHT = 0.2; // 20 см
			const boxMin = -MAX_HEIGHT / 2;
			const boxMax = MAX_HEIGHT / 2;

			let z = phone.position.z;
			z += lift;
			z = Math.max(boxMin, Math.min(boxMax, z)); // ограничение в 20 см
			phone.position.z = z;
		}

		// Поворот берём из EKF
		// const att = xest.value.att;
		// phone.rotation.set(att[0], att[1], att[2], 'XYZ');

		// 1. Визуализация вращения телефона напрямую по gyro
		const gyro = debugData.value?.rotationRate;
		if (gyro) {
			const dr = [
				((gyro.alpha || 0) * Math.PI) / 180,
				((gyro.beta || 0) * Math.PI) / 180,
				((gyro.gamma || 0) * Math.PI) / 180,
			];

			phone.rotation.x += dr[0]! * 0.01; // 0.1 — коэффициент чувствительности
			phone.rotation.y += dr[1]! * 0.01;
			phone.rotation.z += dr[2]! * 0.01;
		}

		// 2. Твоя трасса (trail), но с минимальным порогом
		const pos = xest.value.pos;
		const att = xest.value.att;

		phone.position.set(pos[0], pos[1], pos[2]);
		// phone.rotation.set(att[0], att[1], att[2], 'XYZ'); // пока можно закомментировать

		const currentPos = new THREE.Vector3(pos[0], pos[1], pos[2]);
		if (
			trailPoints.length === 0 ||
			currentPos.distanceTo(lastPos) > 0.005
		) {
			trailPoints.push(currentPos.clone());
			if (trailPoints.length > 200) trailPoints.shift();
			const positions = trailPoints.flatMap((p) => [p.x, p.y, p.z]);
			trailLine.geometry.dispose();
			trailLine.geometry = new THREE.BufferGeometry();
			trailLine.geometry.setAttribute(
				'position',
				new THREE.BufferAttribute(new Float32Array(positions), 3),
			);
			particleGeo.dispose();
			const particlePositions = trailPoints.flatMap((p) => [
				p.x,
				p.y,
				p.z,
			]);
			particleGeo.setAttribute(
				'position',
				new THREE.BufferAttribute(
					new Float32Array(particlePositions),
					3,
				),
			);
			lastPos.copy(currentPos);
		}

		const offset = new THREE.Vector3(-0.3, 0.2, 0.6);
		// offset.applyQuaternion(phone.quaternion);
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
