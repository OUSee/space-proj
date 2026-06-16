import { MatrixUtils } from './matrix';
import { Quaternion, Euler, Vector3 } from 'three';

export class AEKFFilter {
	private x: number[]; // state vector [pos3, vel3, quat4, biasAcc3, biasGyro3]
	private P: number[][]; // covariance matrix (16x16)
	private Q: number[][]; // process noise (16x16)
	private baseQ: number[][]; // baseline Q for adaptation
	private R: number[][]; // measurement noise (3x3 for position)
	private baseR: number[][]; // baseline R for adaptation
	private measNoiseScale = 1.0;
	private procNoiseScale = 1.0;
	private nisHistory: number[] = [];
	private g: number = 9.81; // gravity magnitude (m/s²)

	// Optional callback for debugging/telemetry. If set, receives a
	// snapshot object after predict/update steps. Also logs to console.debug.
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
		const qDot = quat.clone().multiply(omega).multiplyScalar(0.5);
		quat.x += qDot.x * dt;
		quat.y += qDot.y * dt;
		quat.z += qDot.z * dt;
		quat.w += qDot.w * dt;
		quat.normalize();

		const bodyAccel = new Vector3(ax, ay, az);
		const worldAccel = bodyAccel.applyQuaternion(quat);
		const aw_x = worldAccel.x;
		const aw_y = worldAccel.y;
		const aw_z = worldAccel.z - this.g;
		// Update velocity and position
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

		// Prevent runaway state values (sanity clamp)
		this.sanitizeState();

		// Diagnostics snapshot for this prediction step
		try {
			const beforeVel = [vx!, vy!, vz!];
			const afterVel = [this.x[3]!, this.x[4]!, this.x[5]!];
			const Pdiag = this.P.map((row, i) =>
				row && row[i] !== undefined ? row[i] : 0,
			);
			const diagTrace = this.getCovarianceTrace();
			const dbg = {
				event: 'predict',
				dt,
				rawAccel: accel,
				accelBias: [bax, bay, baz],
				bodyAccelNoBias: [ax, ay, az],
				worldAccel: [aw_x, aw_y, aw_z],
				beforeVel,
				afterVel,
				Pdiag,
				diagTrace,
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
		// Velocity from accelerometer bias
		for (let i = 0; i < 3; i++) F[i + 3]![i + 10] = -dt;
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
		F[6]![13] = 0;
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
			this.procNoiseScale = Math.max(0.5, this.procNoiseScale * 0.98);
		}
		this.Q = MatrixUtils.scale(this.baseQ, this.procNoiseScale);
		console.debug('AEKF adapt Q', {
			accelMag,
			gyroMag,
			procNoiseScale: this.procNoiseScale,
		});
	}

	private adaptMeasurementNoise(R_pos: number[][], nis: number): number[][] {
		const minScale = 0.5;
		const maxScale = 10.0;
		if (nis > 16.0) {
			this.measNoiseScale = Math.min(maxScale, this.measNoiseScale * 1.2);
		} else if (nis < 4.0) {
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
		const Sorig = MatrixUtils.add(HPHt, R_pos); // correct: HPHt + R
		let invS = MatrixUtils.inverse(Sorig);
		const nis = MatrixUtils.vectorDot(
			y,
			MatrixUtils.matrixVectorMultiply(invS, y),
		);
		this.nisHistory.push(nis);
		if (this.nisHistory.length > 20) this.nisHistory.shift();

		const R_adapted = this.adaptMeasurementNoise(R_pos, nis);
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

		if (nis > 50.0) {
			console.warn('AEKF GPS innovation rejected', { nis, y, R_pos });
			return;
		}
		const K = MatrixUtils.multiply(MatrixUtils.multiply(this.P, Ht), invS);

		// Update state
		const Ky = MatrixUtils.matrixVectorMultiply(K, y);
		for (let i = 0; i < 15; i++) this.x[i]! += Ky[i]!;

		// Joseph form covariance update
		const I = MatrixUtils.eye(15);
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

		// Sanity clamp after measurement update
		this.sanitizeState();

		// Diagnostics snapshot for position update
		try {
			const Pdiag = this.P.map((row, i) =>
				row && row[i] !== undefined ? row[i] : 0,
			);
			const dbg = {
				event: 'updatePosition',
				posMeasured: pos,
				statePos: [this.x[0], this.x[1], this.x[2]],
				Pdiag,
				diagTrace: this.getCovarianceTrace(),
			};
			console.debug('AEKF', dbg);
			if (this.debugCallback) this.debugCallback(dbg);
		} catch (e) {}
	}

	/**
	 * Zero-velocity update: when device is stationary, constrain velocity to [0,0,0].
	 * This prevents velocity drift during rest periods.
	 * @param R_vel Measurement noise for velocity (3x3), typically small e.g. 0.01
	 */
	updateVelocity(R_vel: number[][]): void {
		// H extracts velocity [3,4,5] from state
		const H = [
			[0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
			[0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
			[0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
		];

		// Measurement: velocity should be zero
		const x3: number = this.x[3] ?? 0;
		const x4: number = this.x[4] ?? 0;
		const x5: number = this.x[5] ?? 0;
		const y = [-x3, -x4, -x5];

		const Ht = MatrixUtils.transpose(H);
		const HP = MatrixUtils.multiply(H, this.P);
		const HPHt = MatrixUtils.multiply(HP, Ht);
		const S = MatrixUtils.add(HPHt, R_vel);
		const invS = MatrixUtils.inverse(S);
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
			MatrixUtils.multiply(K, R_vel),
			MatrixUtils.transpose(K),
		);
		this.P = MatrixUtils.add(P1, KRKt);

		// Sanity clamp after velocity update
		this.sanitizeState();

		// Diagnostics snapshot for velocity update (ZUPT)
		try {
			const Pdiag = this.P.map((row, i) =>
				row && row[i] !== undefined ? row[i] : 0,
			);
			const dbg = {
				event: 'updateVelocity',
				stateVel: [this.x[3], this.x[4], this.x[5]],
				Pdiag,
				diagTrace: this.getCovarianceTrace(),
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
	 * Clamp state entries to reasonable ranges to avoid numerical runaway.
	 */
	private sanitizeState(): void {
		// thresholds
		const vmax = 50.0; // m/s
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
	}
}
