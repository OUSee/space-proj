import { MatrixUtils } from './matrix';

export class AEKFFilter {
	private x: number[]; // state vector [pos3, vel3, att3, biasAcc3, biasGyro3]
	private P: number[][]; // covariance matrix (15x15)
	private Q: number[][]; // process noise (15x15)
	private R: number[][]; // measurement noise (3x3 for position)
	private g: number = 9.81; // gravity magnitude (m/s²)

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

		// ----- Covariance prediction (linearised) -----
		const F = MatrixUtils.eye(15);
		// Position from velocity
		for (let i = 0; i < 3; i++) F[i]![i + 3] = dt;
		// Velocity from accelerometer bias
		for (let i = 0; i < 3; i++) F[i + 3]![i + 9] = -dt;
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
		const y = [z[0] - this.x[0]!, z[1] - this.x[1]!, z[2] - this.x[2]!];

		const Ht = MatrixUtils.transpose(H);
		const HP = MatrixUtils.multiply(H, this.P);
		const HPHt = MatrixUtils.multiply(HP, Ht);
		const S = MatrixUtils.add(HPHt, R_pos); // correct: HPHt + R
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
			MatrixUtils.multiply(K, R_pos),
			MatrixUtils.transpose(K),
		);
		this.P = MatrixUtils.add(P1, KRKt);
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

	setState(x: number[]) {
		this.x = [...x];
	}
	setCovariance(P: number[][]) {
		this.P = MatrixUtils.copy(P);
	}
}
