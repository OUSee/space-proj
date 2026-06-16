import { MatrixUtils } from './matrix';
import { Quaternion, Euler, Vector3 } from 'three';

export class AEKFFilter {
	private x: number[]; // state vector [pos3, vel3, quat4, biasAcc3, biasGyro3]
	private P: number[][]; // covariance matrix (16x16)
	private Q: number[][]; // process noise (16x16)
	private baseQ: number[][]; // baseline Q for adaptation
	private R: number[][]; // stored base measurement noise (kept for compatibility)
	private baseR: number[][]; // baseline R for adaptation
	private measNoiseScale = 1.0;
	private procNoiseScale = 1.0;
	private nisHistory: number[] = [];
	private g: number = 9.81; // gravity magnitude (m/s²)

	public debugCallback?: (d: Record<string, any>) => void;

	constructor(
		initialX: number[],
		initialP: number[][],
		Q: number[][],
		R: number[][],
	) {
		this.x = [...initialX];
		this.P = MatrixUtils.copy(initialP);
		this.Q = MatrixUtils.copy(Q);
		this.baseQ = MatrixUtils.copy(Q);
		this.R = MatrixUtils.copy(R);
		this.baseR = MatrixUtils.copy(R);
	}

	private now(): number {
		return typeof performance !== 'undefined'
			? performance.now()
			: Date.now();
	}

	private quaternionFromState(): Quaternion {
		return new Quaternion(
			this.x[7] ?? 0,
			this.x[8] ?? 0,
			this.x[9] ?? 0,
			this.x[6] ?? 1,
		);
	}

	private writeQuaternionToState(q: Quaternion): void {
		q.normalize();
		this.x[6] = q.w;
		this.x[7] = q.x;
		this.x[8] = q.y;
		this.x[9] = q.z;
	}

	private normalizeQuaternion(): void {
		const q = this.quaternionFromState();
		q.normalize();
		this.writeQuaternionToState(q);
	}

	/**
	 * Project the quaternion covariance onto the tangent space of the unit sphere.
	 * This prevents the 16D covariance from becoming singular in the quaternion norm direction.
	 */
	private projectQuaternionCovariance(): void {
		const q = this.quaternionFromState();
		const qv = [q.w, q.x, q.y, q.z];

		// Pi = I - q q^T
		const Pi = MatrixUtils.eye(4);
		for (let i = 0; i < 4; i++) {
			for (let j = 0; j < 4; j++) {
				Pi[i][j] -= qv[i] * qv[j];
			}
		}

		// T = diag(I_6, Pi, I_6)
		const T = MatrixUtils.eye(16);
		for (let i = 0; i < 4; i++) {
			for (let j = 0; j < 4; j++) {
				T[6 + i][6 + j] = Pi[i][j];
			}
		}

		// P = T P T^T
		const TP = MatrixUtils.multiply(T, this.P);
		this.P = MatrixUtils.multiply(TP, MatrixUtils.transpose(T));
	}

	private getEulerFromQuaternion(): [number, number, number] {
		const q = this.quaternionFromState();
		const e = new Euler(0, 0, 0, 'ZYX');
		e.setFromQuaternion(q);
		return [e.x, e.y, e.z];
	}

	/**
	 * Prediction step using IMU measurements.
	 * @param accel  Acceleration in m/s² (body frame) – should have static bias removed
	 * @param gyro   Angular velocity in rad/s (body frame) – should have static bias removed
	 * @param dt     Time step in seconds (from last prediction)
	 */
	predict(
		accel: [number, number, number],
		gyro: [number, number, number],
		dt: number,
	): void {
		// Extract state components
		let [px, py, pz] = this.x.slice(0, 3);
		let [vx, vy, vz] = this.x.slice(3, 6);
		let [qw, qx, qy, qz] = this.x.slice(6, 10);
		let [bax, bay, baz] = this.x.slice(10, 13);
		let [bgx, bgy, bgz] = this.x.slice(13, 16);

		// Remove estimated biases from sensor readings
		const ax = accel[0] - bax!;
		const ay = accel[1] - bay!;
		const az = accel[2] - baz!;
		const gx = gyro[0] - bgx!;
		const gy = gyro[1] - bgy!;
		const gz = gyro[2] - bgz!;

		const quat = new Quaternion(qx!, qy!, qz!, qw!);
		const omega = new Quaternion(gx, gy, gz, 0);
		const qDot = quat.clone().multiply(omega);
		qDot.x *= 0.5;
		qDot.y *= 0.5;
		qDot.z *= 0.5;
		qDot.w *= 0.5;
		quat.x += qDot.x * dt;
		quat.y += qDot.y * dt;
		quat.z += qDot.z * dt;
		quat.w += qDot.w * dt;
		quat.normalize();

		const bodyAccel = new Vector3(ax, ay, az);
		const worldAccel = bodyAccel.applyQuaternion(quat);

		const beforeVel = [vx!, vy!, vz!];

		const aw_x = worldAccel.x;
		const aw_y = worldAccel.y;
		const aw_z = worldAccel.z - this.g;

		vx! += aw_x * dt;
		vy! += aw_y * dt;
		vz! += aw_z * dt;
		px! += vx! * dt;
		py! += vy! * dt;
		pz! += vz! * dt;

		// Store updated state
		this.x = [
			px!,
			py!,
			pz!,
			vx!,
			vy!,
			vz!,
			quat.w,
			quat.x,
			quat.y,
			quat.z,
			bax!,
			bay!,
			baz!,
			bgx!,
			bgy!,
			bgz!,
		];

		// Prevent runaway state values (sanity clamp) and keep quaternion unit
		this.sanitizeState();

		// Diagnostics snapshot for this prediction step
		try {
			const Pdiag = this.P.map((row, i) =>
				row && row[i] !== undefined ? row[i] : 0,
			);
			const dbg = {
				event: 'predict',
				t: this.now(),
				rawAccel: accel,
				accelBias: [bax, bay, baz],
				bodyAccelNoBias: [ax, ay, az],
				worldAccel: [aw_x, aw_y, aw_z],
				beforeVel,
				afterVel: [this.x[3], this.x[4], this.x[5]],
				statePos: [this.x[0], this.x[1], this.x[2]],
				stateVel: [this.x[3], this.x[4], this.x[5]],
				stateQuat: [this.x[6], this.x[7], this.x[8], this.x[9]],
				Pdiag,
				diagTrace: this.getCovarianceTrace(),
				P: MatrixUtils.copy(this.P),
				Q: MatrixUtils.copy(this.Q),
			};
			console.debug('AEKF', dbg);
			if (this.debugCallback) this.debugCallback(dbg);
		} catch (e) {
			// ignore diagnostics errors
		}

		// ----- Covariance prediction (linearised) -----
		const F = MatrixUtils.eye(16);

		// Position from velocity
		for (let i = 0; i < 3; i++) F[i]![i + 3] = dt;

		// Velocity from quaternion error
		// δv ≈ dt * (worldAccel × (2 * [δqx, δqy, δqz]))
		// state order: 6=qw, 7=qx, 8=qy, 9=qz
		const aw = worldAccel;
		F[3]![6] = 0;
		F[3]![7] = 0;
		F[3]![8] = -2 * dt * aw.z;
		F[3]![9] = 2 * dt * aw.y;

		F[4]![6] = 0;
		F[4]![7] = 2 * dt * aw.z;
		F[4]![8] = 0;
		F[4]![9] = -2 * dt * aw.x;

		F[5]![6] = 0;
		F[5]![7] = -2 * dt * aw.y;
		F[5]![8] = 2 * dt * aw.x;
		F[5]![9] = 0;

		// Velocity from accelerometer bias
		// δv = -dt * R(q) * δb_acc
		const exWorld = new Vector3(1, 0, 0).applyQuaternion(quat);
		const eyWorld = new Vector3(0, 1, 0).applyQuaternion(quat);
		const ezWorld = new Vector3(0, 0, 1).applyQuaternion(quat);

		F[3]![10] = -dt * exWorld.x;
		F[3]![11] = -dt * eyWorld.x;
		F[3]![12] = -dt * ezWorld.x;
		F[4]![10] = -dt * exWorld.y;
		F[4]![11] = -dt * eyWorld.y;
		F[4]![12] = -dt * ezWorld.y;
		F[5]![10] = -dt * exWorld.z;
		F[5]![11] = -dt * eyWorld.z;
		F[5]![12] = -dt * ezWorld.z;

		// Quaternion attitude propagation linearisation
		const omegaMat = [
			[0, -gx, -gy, -gz],
			[gx, 0, gz, -gy],
			[gy, -gz, 0, gx],
			[gz, gy, -gx, 0],
		];
		for (let r = 0; r < 4; r++) {
			for (let c = 0; c < 4; c++) {
				F[6 + r]![6 + c] += 0.5 * dt * omegaMat[r]![c]!;
			}
		}

		// Quaternion bias coupling from gyro bias states
		const q = quat;
		F[6]![13] = 0.5 * dt * q.x;
		F[7]![13] = -0.5 * dt * q.w;
		F[8]![13] = -0.5 * dt * q.z;
		F[9]![13] = 0.5 * dt * q.y;

		F[6]![14] = 0.5 * dt * q.y;
		F[7]![14] = 0.5 * dt * q.z;
		F[8]![14] = -0.5 * dt * q.w;
		F[9]![14] = -0.5 * dt * q.x;

		F[6]![15] = 0.5 * dt * q.z;
		F[7]![15] = -0.5 * dt * q.y;
		F[8]![15] = 0.5 * dt * q.x;
		F[9]![15] = -0.5 * dt * q.w;

		const accelMag = Math.sqrt(ax * ax + ay * ay + az * az);
		const gyroMag = Math.sqrt(gx * gx + gy * gy + gz * gz);
		this.adaptProcessNoise(accelMag, gyroMag);

		// P = F * P * F' + Q
		const FP = MatrixUtils.multiply(F, this.P);
		const FPFt = MatrixUtils.multiply(FP, MatrixUtils.transpose(F));
		this.P = MatrixUtils.add(FPFt, this.Q);
	}

	private adaptProcessNoise(accelMag: number, gyroMag: number): void {
		const accelDeviation = Math.abs(accelMag - this.g);
		const motionFactor = 1 + Math.min(4, accelDeviation / 2 + gyroMag * 2);
		const targetScale = Math.max(1.0, Math.min(8.0, motionFactor));
		if (targetScale > this.procNoiseScale) {
			this.procNoiseScale = Math.min(8.0, this.procNoiseScale * 1.05);
		} else {
			this.procNoiseScale = Math.max(1.0, this.procNoiseScale * 0.98);
		}

		// Scale only the dynamic blocks (position, velocity, quaternion).
		// Do not inflate the bias random walk.
		this.Q = MatrixUtils.copy(this.baseQ);
		for (let i = 0; i < 10; i++) {
			for (let j = 0; j < 10; j++) {
				this.Q[i]![j] *= this.procNoiseScale;
			}
		}

		console.debug('AEKF adapt Q', {
			accelMag,
			gyroMag,
			procNoiseScale: this.procNoiseScale,
		});
	}

	private adaptMeasurementNoise(R_pos: number[][], nis: number): number[][] {
		const minScale = 0.5;
		const maxScale = 10.0;
		if (nis > 12.0) {
			// Large innovation: measurement is suspect, raise R
			this.measNoiseScale = Math.min(maxScale, this.measNoiseScale * 1.2);
		} else if (nis < 4.0) {
			// Small innovation: measurement is very consistent, can lower R
			this.measNoiseScale = Math.max(minScale, this.measNoiseScale * 0.9);
		} else {
			this.measNoiseScale = Math.max(
				minScale,
				Math.min(maxScale, this.measNoiseScale * 0.99),
			);
		}
		const scaled = MatrixUtils.scale(R_pos, this.measNoiseScale);
		console.debug('AEKF adapt R', {
			nis,
			scale: this.measNoiseScale,
			Rpos: R_pos,
			Radapted: scaled,
		});
		return scaled;
	}

	/**
	 * Update step using a position measurement (GPS in ENU meters).
	 * @param pos   Measured position [east, north, up]
	 * @param R_pos Measurement noise covariance (3x3)
	 */
	updatePosition(pos: [number, number, number], R_pos: number[][]): void {
		const H = [
			[1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
			[0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
			[0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
		];

		const z = pos;
		const x0: number = this.x[0] ?? 0;
		const x1: number = this.x[1] ?? 0;
		const x2: number = this.x[2] ?? 0;
		const y = [z[0] - x0, z[1] - x1, z[2] - x2];

		const Ht = MatrixUtils.transpose(H);
		const HP = MatrixUtils.multiply(H, this.P);
		const HPHt = MatrixUtils.multiply(HP, Ht);
		const Sorig = MatrixUtils.add(HPHt, R_pos);

		let invS: number[][];
		try {
			invS = MatrixUtils.inverse(Sorig);
		} catch (e) {
			console.warn('AEKF Sorig singular, rejecting GPS update', e);
			return;
		}

		const nis = MatrixUtils.vectorDot(
			y,
			MatrixUtils.matrixVectorMultiply(invS, y),
		);

		const R_adapted = this.adaptMeasurementNoise(R_pos, nis);

		// Gate with a reasonable chi-square threshold (~99.5% for 3 DOF)
		if (nis > 12.0) {
			console.warn('AEKF GPS innovation rejected', { nis, y });
			return;
		}

		this.nisHistory.push(nis);
		if (this.nisHistory.length > 20) this.nisHistory.shift();

		const S = MatrixUtils.add(HPHt, R_adapted);
		try {
			invS = MatrixUtils.inverse(S);
		} catch (e) {
			console.warn(
				'AEKF cannot invert adapted S, rejecting GPS update',
				e,
			);
			return;
		}

		const K = MatrixUtils.multiply(MatrixUtils.multiply(this.P, Ht), invS);

		// Update state
		const Ky = MatrixUtils.matrixVectorMultiply(K, y);
		for (let i = 0; i < 16; i++) this.x[i]! += Ky[i]!;

		// Joseph form covariance update
		const I = MatrixUtils.eye(16);
		const KH = MatrixUtils.multiply(K, H);
		const I_KH = MatrixUtils.subtract(I, KH);
		const P1 = MatrixUtils.multiply(
			MatrixUtils.multiply(I_KH, this.P),
			MatrixUtils.transpose(I_KH),
		);
		const KRKt = MatrixUtils.multiply(
			MatrixUtils.multiply(K, R_adapted),
			MatrixUtils.transpose(K),
		);
		this.P = MatrixUtils.add(P1, KRKt);

		// Sanity clamp and quaternion constraint
		this.sanitizeState();

		// Diagnostics snapshot
		try {
			const Pdiag = this.P.map((row, i) =>
				row && row[i] !== undefined ? row[i] : 0,
			);
			const dbg: any = {
				event: 'updatePosition',
				t: this.now(),
				posMeasured: pos,
				statePos: [this.x[0], this.x[1], this.x[2]],
				stateVel: [this.x[3], this.x[4], this.x[5]],
				Pdiag,
				nis,
				diagTrace: this.getCovarianceTrace(),
				P: MatrixUtils.copy(this.P),
				Q: MatrixUtils.copy(this.Q),
			};
			console.debug('AEKF', dbg);
			if (this.debugCallback) this.debugCallback(dbg);
		} catch (e) {}
	}

	/**
	 * Update step using a velocity measurement (e.g. from GPS speed + heading).
	 * @param vel Measured velocity [east, north, up] in m/s
	 * @param R_vel Measurement noise covariance (3x3)
	 */
	updateVelocityMeasurement(
		vel: [number, number, number],
		R_vel: number[][],
	): void {
		const H = [
			[0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
			[0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
			[0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
		];

		const x3: number = this.x[3] ?? 0;
		const x4: number = this.x[4] ?? 0;
		const x5: number = this.x[5] ?? 0;
		const y = [vel[0] - x3, vel[1] - x4, vel[2] - x5];

		this.applyMeasurementUpdate(H, y, R_vel, 'updateVelocityMeasurement');
	}

	/**
	 * Zero-velocity update: when device is stationary, constrain velocity to [0,0,0].
	 * This prevents velocity drift during rest periods.
	 * @param R_vel Measurement noise for velocity (3x3), typically small e.g. 0.01
	 */
	updateVelocity(R_vel: number[][]): void {
		this.updateVelocityMeasurement([0, 0, 0], R_vel);
	}

	/**
	 * Tilt update: correct roll/pitch using accelerometer gravity alignment.
	 * Only call this when the device is not accelerating heavily (e.g. standing still
	 * or moving at constant velocity). Use a large R_tilt when motion is suspected.
	 * @param accel   Body-frame accelerometer reading [m/s²]
	 * @param R_tilt  Measurement noise (3x3), usually small (e.g. 0.1-1.0)
	 */
	updateTilt(accel: [number, number, number], R_tilt: number[][]): void {
		// Expected gravity in body frame: at rest the accelerometer measures the
		// upward reaction to gravity, so expected reading is R(q)^T * [0,0,g].
		const gWorld = new Vector3(0, 0, this.g);
		const h = gWorld.applyQuaternion(this.quaternionFromState().invert());

		const y = [accel[0] - h.x, accel[1] - h.y, accel[2] - h.z];

		// Jacobian of y = z - h w.r.t. quaternion error (body-frame convention)
		// δh ≈ h × (2 * [δqx, δqy, δqz]), so H = -2 * [h ×]
		const H = [
			[0, 0, 0, 0, 0, 0, 0, 0, 2 * h.z, -2 * h.y, 0, 0, 0, 0, 0, 0],
			[0, 0, 0, 0, 0, 0, 0, -2 * h.z, 0, 2 * h.x, 0, 0, 0, 0, 0, 0],
			[0, 0, 0, 0, 0, 0, 0, 2 * h.y, -2 * h.x, 0, 0, 0, 0, 0, 0],
		];

		this.applyMeasurementUpdate(H, y, R_tilt, 'updateTilt');
	}

	/**
	 * Heading update: correct yaw using a heading measurement (e.g. magnetometer
	 * heading or GPS course-over-ground).
	 * @param yaw     Measured yaw in radians, ENU convention
	 * @param R_yaw   Measurement noise covariance (1x1)
	 */
	updateHeading(yaw: number, R_yaw: number[][]): void {
		const q = this.quaternionFromState();
		const [x, y, z, w] = [q.x, q.y, q.z, q.w];

		// ZYX yaw from quaternion: psi = atan2(2(xy+wz), 1 - 2(y^2+z^2))
		const u = 2 * (x * y + w * z);
		const v = 1 - 2 * (y * y + z * z);
		const D = u * u + v * v;

		const H = [
			[
				0,
				0,
				0,
				0,
				0,
				0,
				(2 * z * v) / D,
				(2 * y * v) / D,
				(2 * x * v + 4 * y * u) / D,
				(2 * w * v + 4 * z * u) / D,
				0,
				0,
				0,
				0,
				0,
				0,
			],
		];

		const predictedYaw = Math.atan2(u, v);
		let innovation = yaw - predictedYaw;
		while (innovation > Math.PI) innovation -= 2 * Math.PI;
		while (innovation < -Math.PI) innovation += 2 * Math.PI;

		this.applyMeasurementUpdate(H, [innovation], R_yaw, 'updateHeading');
	}

	private applyMeasurementUpdate(
		H: number[][],
		y: number[],
		R: number[][],
		eventName: string,
	): void {
		const Ht = MatrixUtils.transpose(H);
		const HP = MatrixUtils.multiply(H, this.P);
		const HPHt = MatrixUtils.multiply(HP, Ht);
		const S = MatrixUtils.add(HPHt, R);

		let invS: number[][];
		try {
			invS = MatrixUtils.inverse(S);
		} catch (e) {
			console.warn(`AEKF ${eventName} S singular, skipping`, e);
			return;
		}

		const K = MatrixUtils.multiply(MatrixUtils.multiply(this.P, Ht), invS);

		// Update state
		const Ky = MatrixUtils.matrixVectorMultiply(K, y);
		for (let i = 0; i < 16; i++) this.x[i]! += Ky[i]!;

		// Joseph form covariance update
		const I = MatrixUtils.eye(16);
		const KH = MatrixUtils.multiply(K, H);
		const I_KH = MatrixUtils.subtract(I, KH);
		const P1 = MatrixUtils.multiply(
			MatrixUtils.multiply(I_KH, this.P),
			MatrixUtils.transpose(I_KH),
		);
		const KRKt = MatrixUtils.multiply(
			MatrixUtils.multiply(K, R),
			MatrixUtils.transpose(K),
		);
		this.P = MatrixUtils.add(P1, KRKt);

		// Sanity clamp and quaternion constraint
		this.sanitizeState();

		// Diagnostics snapshot
		try {
			const Pdiag = this.P.map((row, i) =>
				row && row[i] !== undefined ? row[i] : 0,
			);
			const dbg: any = {
				event: eventName,
				t: this.now(),
				innovation: y,
				statePos: [this.x[0], this.x[1], this.x[2]],
				stateVel: [this.x[3], this.x[4], this.x[5]],
				Pdiag,
				diagTrace: this.getCovarianceTrace(),
				P: MatrixUtils.copy(this.P),
				Q: MatrixUtils.copy(this.Q),
			};
			console.debug('AEKF', dbg);
			if (this.debugCallback) this.debugCallback(dbg);
		} catch (e) {}
	}

	// Getters for reactive state
	getPosition(): [number, number, number] {
		return [this.x[0]!, this.x[1]!, this.x[2]!];
	}
	getVelocity(): [number, number, number] {
		return [this.x[3]!, this.x[4]!, this.x[5]!];
	}
	getAttitude(): [number, number, number] {
		return this.getEulerFromQuaternion();
	}
	getBiasAcc(): [number, number, number] {
		return [this.x[10]!, this.x[11]!, this.x[12]!];
	}
	getBiasGyro(): [number, number, number] {
		return [this.x[13]!, this.x[14]!, this.x[15]!];
	}

	/**
	 * Return covariance trace (sum of diagonal) for quick diagnostics.
	 */
	getCovarianceTrace(): number {
		let tr = 0;
		for (let i = 0; i < this.P.length; i++) {
			if (this.P[i] && this.P[i]![i] !== undefined) tr += this.P[i]![i]!;
		}
		return tr;
	}

	setState(x: number[]) {
		this.x = [...x];
	}
	setCovariance(P: number[][]) {
		this.P = MatrixUtils.copy(P);
	}

	/**
	 * Clamp state entries to reasonable ranges to avoid numerical runaway,
	 * and keep the quaternion unit-normalized with a consistent covariance.
	 */
	private sanitizeState(): void {
		const vmax = 5.0; // m/s
		const bacc_max = 50.0; // m/s^2
		const bgyro_max = 5.0; // rad/s (~286 deg/s)

		// Clamp velocities (indices 3..5)
		for (let i = 3; i <= 5; i++) {
			if (Math.abs(this.x[i]!) > vmax) {
				this.x[i] = Math.sign(this.x[i]!) * vmax;
				if (
					this.P[i] &&
					this.P[i]![i] !== undefined &&
					this.P[i]![i]! < 1.0
				)
					this.P[i]![i]! = 1.0;
			}
		}

		// Clamp accel bias (indices 10..12)
		for (let i = 10; i <= 12; i++) {
			if (Math.abs(this.x[i]!) > bacc_max) {
				this.x[i] = Math.sign(this.x[i]!) * bacc_max;
				if (
					this.P[i] &&
					this.P[i]![i] !== undefined &&
					this.P[i]![i]! < 1.0
				)
					this.P[i]![i]! = 1.0;
			}
		}

		// Clamp gyro bias (indices 13..15)
		for (let i = 13; i <= 15; i++) {
			if (Math.abs(this.x[i]!) > bgyro_max) {
				this.x[i] = Math.sign(this.x[i]!) * bgyro_max;
				if (
					this.P[i] &&
					this.P[i]![i] !== undefined &&
					this.P[i]![i]! < 1.0
				)
					this.P[i]![i]! = 1.0;
			}
		}

		// Maintain the unit-norm quaternion and keep the covariance on the
		// 3D attitude tangent space, not the 4D over-parameterised space.
		this.normalizeQuaternion();
		this.projectQuaternionCovariance();
	}
}
