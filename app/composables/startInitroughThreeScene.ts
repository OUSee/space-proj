// ----------------------------- Rough 3D Demo (RAW DATA ONLY) -----------------------------
// --
// X three.js = East,
//
// Z three.js = North (или наоборот, но фиксируй),
//
// Y three.js = Up.
// --
const roughDemoPhonePos = ref({ x: 0, y: 0, z: 0 });
const roughDemoPhoneRot = ref({ x: 0, y: 0, z: 0 });

export const initRoughThreeScene = (
	THREEModule: any,
	DVMData: any,
	DVODAta: any,
	calibrationData: any,
	info_phone: any,
	info_waccel: any,
	info_laccel: any,
	info_abody: any,
	info_gbody: any,
) => {
	const container = document.getElementById('three-container');
	if (!container) return null;

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

	// Axes helper
	const axesHelper = new THREE.AxesHelper(5);
	scene.add(axesHelper);

	// Phone model (0.075 x 0.155 x 0.008 m)
	const geometry = new THREE.BoxGeometry(0.075, 0.008, 0.155); // X, Y, Z — как экран вверх
	const material = new THREE.MeshStandardMaterial({
		color: 0x3a86ff,
		metalness: 0.7,
		roughness: 0.3,
	});
	const phone = new THREE.Mesh(geometry, material);
	phone.castShadow = true;

	// НАЧАЛЬНОЕ ПОЛОЖЕНИЕ: лежит на столе, экран вверх
	phone.rotation.set(0, 0, 0); // x y z
	scene.add(phone);

	// White edges
	const edgesGeo = new THREE.EdgesGeometry(geometry);
	const edgesMat = new THREE.LineBasicMaterial({ color: 0xffffff });
	const wireframe = new THREE.LineSegments(edgesGeo, edgesMat);
	phone.add(wireframe);

	// Trail for raw‑demo only (optional)
	const trailPoints: any[] = [];
	const trailLine = new THREE.Line(
		new THREE.BufferGeometry(),
		new THREE.LineBasicMaterial({ color: 0xffff00 }),
	);
	scene.add(trailLine);
	const particleGeo = new THREE.BufferGeometry();
	const particleMat = new THREE.PointsMaterial({
		color: 0xffff00,
		size: 0.03,
	});
	const particles = new THREE.Points(particleGeo, particleMat);
	scene.add(particles);

	let lastPos = new THREE.Vector3();

	// Вращение и подъём в ящике 20 см
	const MAX_HEIGHT = 2;
	const boxMin = -MAX_HEIGHT / 2;
	const boxMax = MAX_HEIGHT / 2;

	const deviceOrientationQuat = new THREE.Quaternion();
	deviceOrientationQuat.set(0, 0, 0, 1);

	const gWorld = new THREE.Vector3(0, 0, -9.7);
	const tmpQuat = new THREE.Quaternion();
	const correctedQuat = new THREE.Quaternion();
	const yawQuat = new THREE.Quaternion();

	let velocity = new THREE.Vector3();
	let position = new THREE.Vector3();
	let lastTs = 0;

	const animate = (ts = performance.now()) => {
		requestAnimationFrame(animate);

		const accel = DVMData.value?.acceleration;
		const gyro = DVMData.value?.rotationRate;
		const motion = DVMData.value;
		const mag = motion?.magneticField; // Магнитное поле
		const grav = motion?.gravity; // Гравитация

		const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016;
		lastTs = ts;

		velocity.multiplyScalar(0.98); // Простое затухание

		if (dt > 0) {
			// correct do not touch
			if (gyro) {
				const alpha = ((gyro.alpha || 0) * Math.PI) / 180; // yaw
				const beta = ((gyro.beta || 0) * Math.PI) / 180; // pitch
				const gamma = ((gyro.gamma || 0) * Math.PI) / 180; // roll

				// Вращательная скорость (угловая скорость) в радианах/сек
				const omega = new THREE.Vector3(alpha, gamma, -beta);
				const angle = omega.length();

				if (angle > 1e-6) {
					const axis = omega.clone().normalize();
					tmpQuat.setFromAxisAngle(axis, angle * dt);
					deviceOrientationQuat.multiply(tmpQuat);
					phone.quaternion.copy(deviceOrientationQuat);
				}
			}

			// 2. DVMData КОРРЕКЦИЯ ОРИЕНТАЦИИ (магнитный компас + гравитация)
			if (motion && grav && mag) {
				// Нормализуем гравитацию (должна быть ~9.8)
				const gravNorm = grav.clone().normalize();
				const gravLength = grav.length();

				// Магнитное поле для yaw коррекции (компас)
				const magNorm = mag.clone().normalize();

				// Создаём quaternion из gravity (pitch/roll) + magnetic (yaw)
				correctedQuat.setFromUnitVectors(
					new THREE.Vector3(0, 1, 0), // up vector
					gravNorm,
				);

				// Применяем yaw из магнитного поля
				yawQuat.setFromAxisAngle(
					new THREE.Vector3(0, 1, 0),
					Math.atan2(magNorm.x, magNorm.z),
				);
				correctedQuat.multiply(yawQuat);

				// Плавная интерполяция с гироскопом (0.1 = коэффициент сглаживания)
				deviceOrientationQuat.slerp(correctedQuat, 0.1 * dt);
			}

			if (DVODAta.value) {
				const { alpha, beta, gamma } = DVODAta.value;
				if (alpha != null && beta != null && gamma != null) {
					const alphaRad = (alpha * Math.PI) / 180;
					const betaRad = (beta * Math.PI) / 180;
					const gammaRad = (gamma * Math.PI) / 180;

					const euler = new THREE.Euler(
						betaRad,
						alphaRad,
						-gammaRad,
						'YXZ',
					);
					const dvoQuat = new THREE.Quaternion().setFromEuler(euler);

					// Slerp correction: 0.02–0.05 is usually enough, adjust to taste
					const DVO_CORRECTION = 0.03;
					deviceOrientationQuat.slerp(dvoQuat, DVO_CORRECTION * dt);

					phone.quaternion.copy(deviceOrientationQuat);
				}
			}

			if (accel) {
				const aBody = new THREE.Vector3(
					(accel.x ?? 0) * 1.5,
					(accel.z ?? 0) * 1.5,
					(accel.y ?? 0) * -1.5,
				);

				info_abody.value = aBody.clone();

				const linBody = aBody.clone(); // используйте acceleration, если доступно
				info_laccel.value = linBody.clone();

				const linWorld = linBody.applyQuaternion(deviceOrientationQuat);
				info_waccel.value = linWorld.clone();

				velocity.addScaledVector(linWorld, dt); // Интеграция: velocity += accel * dt

				if (velocity.length() < 0.0005) velocity.set(0, 0, 0); // Низкий порог

				position.addScaledVector(velocity, dt);

				position.y = Math.max(0, position.y);
				position.x = position.x;
				position.z = position.z;

				phone.position.copy(position);
				phone.updateMatrix();
				phone.updateMatrixWorld(true); // true = force
			}
		}

		// 3. Камера
		const offset = new THREE.Vector3(-0.5, 0.3, 0.8);
		// offset.applyQuaternion(phone.quaternion);
		camera.position.copy(phone.position.clone().add(offset));
		camera.lookAt(phone.position);

		trailPoints.push(phone.position.clone());
		if (trailPoints.length > 100) trailPoints.shift();

		trailLine.geometry.setFromPoints(trailPoints);
		particles.geometry.setFromPoints(trailPoints.slice(-20));

		info_phone.value = phone;

		renderer.render(scene, camera);
	};
	animate();

	const dispose = () => {
		window.cancelAnimationFrame(animate as any);
		if (container.children[0]) {
			container.removeChild(renderer.domElement);
		}
	};

	return { animate, dispose };
};
