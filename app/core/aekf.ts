import { MatrixUtils } from './matrix';

export class AEKFFilter {
	private x: number[]; // state vector [pos3, vel3, att3, biasAcc3, biasGyro3]
	private P: number[][]; // covariance matrix (15x15)
	private Q: number[][]; // process noise (15x15)
	private R: number[][]; // measurement noise (3x3 for position)
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
		this.Q = Q;
		this.R = R;
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
		let [roll, pitch, yaw] = this.x.slice(6, 9);
		let [bax, bay, baz] = this.x.slice(9, 12);
		let [bgx, bgy, bgz] = this.x.slice(12, 15);

		// Remove estimated biases from sensor readings
		const ax = accel[0] - bax!;
		const ay = accel[1] - bay!;
		const az = accel[2] - baz!;
		const gx = gyro[0] - bgx!;
		const gy = gyro[1] - bgy!;
		const gz = gyro[2] - bgz!;
		// Update attitude (Euler integration – simple for demo)
		roll! += gx * dt;
		pitch! += gy * dt;
		yaw! += gz * dt;
		// Build rotation matrix from body to world (ZYX Euler)
		const cr = Math.cos(roll!),
			sr = Math.sin(roll!);
		const cp = Math.cos(pitch!),
			sp = Math.sin(pitch!);
		const cy = Math.cos(yaw!),
			sy = Math.sin(yaw!);
		const R_wb = [
			[cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
			[sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr],
			[-sp, cp * sr, cp * cr],
		];

		// Transform acceleration to world frame and subtract gravity
		const aw_x = R_wb[0]![0]! * ax + R_wb[0]![1]! * ay + R_wb[0]![2]! * az;
		const aw_y = R_wb[1]![0]! * ax + R_wb[1]![1]! * ay + R_wb[1]![2]! * az;
		const aw_z =
			R_wb[2]![0]! * ax + R_wb[2]![1]! * ay + R_wb[2]![2]! * az - this.g;
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
			roll!,
			pitch!,
			yaw!,
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
		const F = MatrixUtils.eye(15);
		// Position from velocity
		for (let i = 0; i < 3; i++) F[i]![i + 3] = dt;
		// Velocity from accelerometer bias
		for (let i = 0; i < 3; i++) F[i + 3]![i + 9] = -dt;
		// Attitude error → velocity error via gravity coupling
		// This helps the filter understand that roll/pitch errors create velocity drift.
		F[3]![7] = dt * this.g;
		F[4]![6] = -dt * this.g;
		// Attitude from gyro bias
		for (let i = 0; i < 3; i++) F[i + 6]![i + 12] = -dt;

		// P = F * P * F' + Q
		const FP = MatrixUtils.multiply(F, this.P);
		const FPFt = MatrixUtils.multiply(FP, MatrixUtils.transpose(F));
		this.P = MatrixUtils.add(FPFt, this.Q);
	}

	/**
	 * Update step using a position measurement (GPS in ENU meters).
	 * @param pos   Measured position [east, north, up]
	 * @param R_pos Measurement noise covariance (3x3)
	 */
	updatePosition(pos: [number, number, number], R_pos: number[][]): void {
		const H = [
			[1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
			[0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
			[0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
		];

		const z = pos;
		const x0: number = this.x[0] ?? 0;
		const x1: number = this.x[1] ?? 0;
		const x2: number = this.x[2] ?? 0;
		const y = [z[0] - x0, z[1] - x1, z[2] - x2];

		const Ht = MatrixUtils.transpose(H);
		const HP = MatrixUtils.multiply(H, this.P);
		const HPHt = MatrixUtils.multiply(HP, Ht);
		const S = MatrixUtils.add(HPHt, R_pos); // correct: HPHt + R
		const invS = MatrixUtils.inverse(S);
		const nis = MatrixUtils.vectorDot(
			y,
			MatrixUtils.matrixVectorMultiply(invS, y),
		);
		if (nis > 16.0) {
			console.warn('AEKF GPS innovation gated', { nis, y, R_pos });
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
			MatrixUtils.multiply(K, R_pos),
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
			[0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
			[0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
			[0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
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
		return [this.x[6]!, this.x[7]!, this.x[8]!];
	}
	getBiasAcc(): [number, number, number] {
		return [this.x[9]!, this.x[10]!, this.x[11]!];
	}
	getBiasGyro(): [number, number, number] {
		return [this.x[12]!, this.x[13]!, this.x[14]!];
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

		// Clamp accel bias (indices 9..11)
		for (let i = 9; i <= 11; i++) {
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

		// Clamp gyro bias (indices 12..14)
		for (let i = 12; i <= 14; i++) {
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
