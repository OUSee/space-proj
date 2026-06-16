import { MatrixUtils } from './matrix';
import { Quaternion, Euler, Vector3 } from 'three';

export class AEKFFilter {
	private x: number[]; // state vector [pos3, vel3, quat4, biasAcc3, biasGyro3]
	private P: number[][]; // covariance matrix (16x16)
	private Q: number[][]; // process noise (16x16)
	private baseQ: number[][]; // baseline Q for adaptation
	private measNoiseScale = 1.0;
	private procNoiseScale = 1.0;
	private g: number = 9.81; // gravity magnitude (m/s²)

	public debugCallback?: (d: Record<string, any>) => void;

	constructor(initialX: number[], initialP: number[][], Q: number[][]) {
		this.x = [...initialX];
		this.P = MatrixUtils.copy(initialP);
		this.Q = MatrixUtils.copy(Q);
		this.baseQ = MatrixUtils.copy(Q);
	}

	private quaternionFromState(): Quaternion {
		// x[6]=w, x[7]=x, x[8]=y, x[9]=z
		return new Quaternion(
			this.x[7] ?? 0,
			this.x[8] ?? 0,
			this.x[9] ?? 0,
			this.x[6] ?? 1,
		);
	}

	private getEulerFromQuaternion(): [number, number, number] {
		const q = this.quaternionFromState();
		const e = new Euler(0, 0, 0, 'ZYX');
		e.setFromQuaternion(q);
		return [e.x, e.y, e.z];
	}

	predict(
		accel: [number, number, number],
		gyro: [number, number, number],
		dt: number,
	): void {
		if (dt <= 0) return;

		// 1. Extract state
		let px = this.x[0],
			py = this.x[1],
			pz = this.x[2];
		let vx = this.x[3],
			vy = this.x[4],
			vz = this.x[5];
		let qw = this.x[6],
			qx = this.x[7],
			qy = this.x[8],
			qz = this.x[9];
		let bax = this.x[10],
			bay = this.x[11],
			baz = this.x[12];
		let bgx = this.x[13],
			bgy = this.x[14],
			bgz = this.x[15];

		// 2. Correct measurements
		const ax = accel[0] - bax;
		const ay = accel[1] - bay;
		const az = accel[2] - baz;
		const gx = gyro[0] - bgx;
		const gy = gyro[1] - bgy;
		const gz = gyro[2] - bgz;

		// 3. State Propagation (Kinematics)
		const currentQuat = new Quaternion(qx, qy, qz, qw);

		// Accelerometer in world frame
		const bodyAccel = new Vector3(ax, ay, az);
		const worldAccel = bodyAccel.clone().applyQuaternion(currentQuat);
		const awx = worldAccel.x;
		const awy = worldAccel.y;
		const awz = worldAccel.z - this.g;

		// Predict position and velocity
		const nextPx = px + vx * dt + 0.5 * awx * dt * dt;
		const nextPy = py + vy * dt + 0.5 * awy * dt * dt;
		const nextPz = pz + vz * dt + 0.5 * awz * dt * dt;
		const nextVx = vx + awx * dt;
		const nextVy = vy + awy * dt;
		const nextVz = vz + awz * dt;

		// Predict quaternion
		// dq/dt = 0.5 * q * [0, omega]
		const omegaQuat = new Quaternion(
			gx * dt * 0.5,
			gy * dt * 0.5,
			gz * dt * 0.5,
			0,
		);
		const nextQuat = currentQuat.clone();
		// Approximation of exp(0.5 * omega * dt)
		// q_next = q_curr * (1 + 0.5 * omega * dt)
		const deltaQuat = currentQuat.clone().multiply(omegaQuat);
		nextQuat.w += deltaQuat.w;
		nextQuat.x += deltaQuat.x;
		nextQuat.y += deltaQuat.y;
		nextQuat.z += deltaQuat.z;
		nextQuat.normalize();

		// 4. Jacobian Matrix F (16x16)
		const F = MatrixUtils.eye(16);

		// df_pos / df_vel
		F[0][3] = dt;
		F[1][4] = dt;
		F[2][5] = dt;

		// df_vel / df_quat (Derivative of R(q)*a with respect to q)
		// For simplicity and stability, we use a common linearisation:
		// d(R(q)a)/dq is complex, but we can approximate it.
		// Using the formula for R(q)v derivative:
		const dR_dq = this.getRotationDerivative(currentQuat, bodyAccel);
		for (let i = 0; i < 3; i++) {
			for (let j = 0; j < 4; j++) {
				F[3 + i][6 + j] = dR_dq[i][j] * dt;
			}
		}

		// df_vel / df_ba (bias acc)
		// a_world = R(q)(a_body - bias_acc) -> d(a_world)/d(bias_acc) = -R(q)
		const R = this.getRotationMatrix(currentQuat);
		for (let i = 0; i < 3; i++) {
			for (let j = 0; j < 3; j++) {
				F[3 + i][10 + j] = -R[i][j] * dt;
			}
		}

		// df_quat / df_quat
		// q_next = q + 0.5 * q * omega * dt
		// This part is handled by the identity + Omega matrix
		const Omega = [
			[0, -gx, -gy, -gz],
			[gx, 0, gz, -gy],
			[gy, -gz, 0, gx],
			[gz, gy, -gx, 0],
		];
		for (let i = 0; i < 4; i++) {
			for (let j = 0; j < 4; j++) {
				F[6 + i][6 + j] += 0.5 * dt * Omega[i][j];
			}
		}

		// df_quat / df_bg (bias gyro)
		// d(q_next)/d(bg) = d(0.5 * q * (gyro - bg) * dt) / d(bg) = -0.5 * dt * q * [0, 1]
		const dq_dbg = this.getQuaternionBiasDerivative(currentQuat);
		for (let i = 0; i < 4; i++) {
			for (let j = 0; j < 3; j++) {
				F[6 + i][13 + j] = dq_dbg[i][j] * dt;
			}
		}

		// 5. Update State
		this.x = [
			nextPx,
			nextPy,
			nextPz,
			nextVx,
			nextVy,
			nextVz,
			nextQuat.w,
			nextQuat.x,
			nextQuat.y,
			nextQuat.z,
			bax,
			bay,
			baz,
			bgx,
			bgy,
			bgz,
		];

		// 6. Predict Covariance: P = F * P * F' + Q
		const accelMag = Math.sqrt(ax * ax + ay * ay + az * az);
		const gyroMag = Math.sqrt(gx * gx + gy * gy + gz * gz);
		this.adaptProcessNoise(accelMag, gyroMag);

		const FP = MatrixUtils.multiply(F, this.P);
		const FPFt = MatrixUtils.multiply(FP, MatrixUtils.transpose(F));
		this.P = MatrixUtils.add(FPFt, this.Q);

		this.sanitizeState();

		if (this.debugCallback) {
			this.debugCallback({
				event: 'predict',
				t: performance.now(),
				state: [...this.x],
				diagP: this.P.map((r, i) => r[i]),
			});
		}
	}

	private getRotationMatrix(q: Quaternion): number[][] {
		const w = q.w,
			x = q.x,
			y = q.y,
			z = q.z;
		return [
			[
				1 - 2 * y * y - 2 * z * z,
				2 * x * y - 2 * w * z,
				2 * x * z + 2 * w * y,
			],
			[
				2 * x * y + 2 * w * z,
				1 - 2 * x * x - 2 * z * z,
				2 * y * z - 2 * w * x,
			],
			[
				2 * x * z - 2 * w * y,
				2 * y * z + 2 * w * x,
				1 - 2 * x * x - 2 * y * y,
			],
		];
	}

	private getRotationDerivative(q: Quaternion, v: Vector3): number[][] {
		const w = q.w,
			x = q.x,
			y = q.y,
			z = q.z;
		const vx = v.x,
			vy = v.y,
			vz = v.z;

		// d(R(q)v)/dw
		const dw = [
			-2 * z * vy + 2 * y * vz,
			2 * z * vx - 2 * x * vz,
			-2 * y * vx + 2 * x * vy,
		];
		// d(R(q)v)/dx
		const dx = [
			2 * y * vy + 2 * z * vz,
			2 * y * vx - 4 * x * vy - 2 * w * vz,
			2 * z * vx + 2 * w * vy - 4 * x * vz,
		];
		// d(R(q)v)/dy
		const dy = [
			-4 * y * vx + 2 * x * vy + 2 * w * vz,
			2 * x * vx + 2 * z * vz,
			-2 * w * vx + 2 * z * vy - 4 * y * vz,
		];
		// d(R(q)v)/dz
		const dz = [
			-4 * z * vx - 2 * w * vy + 2 * x * vz,
			2 * w * vx - 4 * z * vy + 2 * y * vz,
			2 * x * vx + 2 * y * vy,
		];

		return [
			[dw[0], dx[0], dy[0], dz[0]],
			[dw[1], dx[1], dy[1], dz[1]],
			[dw[2], dx[2], dy[2], dz[2]],
		];
	}

	private getQuaternionBiasDerivative(q: Quaternion): number[][] {
		const w = q.w,
			x = q.x,
			y = q.y,
			z = q.z;
		// q_dot = 0.5 * q * omega
		// d(q_dot)/d(omega_x) = 0.5 * q * [0, 1, 0, 0]
		// Multiplication q * [0, 1, 0, 0]:
		// (w + xi + yj + zk) * i = wi^2 + xii + yji + zki = w*i - x - y*k + z*j = -x + w*i + z*j - y*k
		// So d(q_dot)/d(gx) = 0.5 * [-x, w, z, -y]
		return [
			[-0.5 * x, -0.5 * y, -0.5 * z], // dw/dbg
			[0.5 * w, -0.5 * z, 0.5 * y], // dx/dbg
			[0.5 * z, 0.5 * w, -0.5 * x], // dy/dbg
			[-0.5 * y, 0.5 * x, 0.5 * w], // dz/dbg
		];
	}

	private adaptProcessNoise(accelMag: number, gyroMag: number): void {
		const accelDeviation = Math.abs(accelMag - this.g);
		const motionFactor =
			1 + Math.min(5, accelDeviation * 0.5 + gyroMag * 2);
		this.procNoiseScale = 0.95 * this.procNoiseScale + 0.05 * motionFactor;
		this.Q = MatrixUtils.scale(this.baseQ, this.procNoiseScale);
	}

	private adaptMeasurementNoise(R_pos: number[][], nis: number): number[][] {
		// NIS for 3 degrees of freedom: mean should be 3.
		// If NIS is large, measurement is less reliable -> increase R.
		const factor = nis > 7.81 ? 1.5 : nis < 0.35 ? 0.8 : 1.0;
		this.measNoiseScale = Math.max(
			0.1,
			Math.min(20, this.measNoiseScale * factor),
		);
		return MatrixUtils.scale(R_pos, this.measNoiseScale);
	}

	updatePosition(pos: [number, number, number], R_pos: number[][]): void {
		const H = Array(3)
			.fill(0)
			.map(() => Array(16).fill(0));
		H[0][0] = 1;
		H[1][1] = 1;
		H[2][2] = 1;

		const z = pos;
		const y = [z[0] - this.x[0], z[1] - this.x[1], z[2] - this.x[2]];

		const Ht = MatrixUtils.transpose(H);
		const HP = MatrixUtils.multiply(H, this.P);
		const HPHt = MatrixUtils.multiply(HP, Ht);

		// Innovation covariance
		const S = MatrixUtils.add(HPHt, R_pos);
		let invS: number[][];
		try {
			invS = MatrixUtils.inverse(S);
		} catch (e) {
			return;
		}

		const nis = MatrixUtils.vectorDot(
			y,
			MatrixUtils.matrixVectorMultiply(invS, y),
		);

		// Gating
		if (nis > 16.0) {
			// Reject extreme outliers
			console.warn('AEKF GPS rejected, NIS:', nis);
			return;
		}

		const R_adapted = this.adaptMeasurementNoise(R_pos, nis);
		const S_final = MatrixUtils.add(HPHt, R_adapted);
		const invS_final = MatrixUtils.inverse(S_final);

		const K = MatrixUtils.multiply(
			MatrixUtils.multiply(this.P, Ht),
			invS_final,
		);

		// Update state
		const Ky = MatrixUtils.matrixVectorMultiply(K, y);
		for (let i = 0; i < 16; i++) this.x[i] += Ky[i];

		// Re-normalize quaternion
		const updatedQuat = new Quaternion(
			this.x[7],
			this.x[8],
			this.x[9],
			this.x[6],
		).normalize();
		this.x[6] = updatedQuat.w;
		this.x[7] = updatedQuat.x;
		this.x[8] = updatedQuat.y;
		this.x[9] = updatedQuat.z;

		// Joseph form covariance update: P = (I - KH)P(I - KH)' + KRK'
		const I = MatrixUtils.eye(16);
		const KH = MatrixUtils.multiply(K, H);
		const I_KH = MatrixUtils.subtract(I, KH);
		const P_next = MatrixUtils.add(
			MatrixUtils.multiply(
				MatrixUtils.multiply(I_KH, this.P),
				MatrixUtils.transpose(I_KH),
			),
			MatrixUtils.multiply(
				MatrixUtils.multiply(K, R_adapted),
				MatrixUtils.transpose(K),
			),
		);
		this.P = P_next;

		this.sanitizeState();
	}

	updateVelocity(R_vel: number[][]): void {
		const H = Array(3)
			.fill(0)
			.map(() => Array(16).fill(0));
		H[0][3] = 1;
		H[1][4] = 1;
		H[2][5] = 1;

		const y = [-this.x[3], -this.x[4], -this.x[5]];
		const Ht = MatrixUtils.transpose(H);
		const HP = MatrixUtils.multiply(H, this.P);
		const S = MatrixUtils.add(MatrixUtils.multiply(HP, Ht), R_vel);

		try {
			const invS = MatrixUtils.inverse(S);
			const K = MatrixUtils.multiply(
				MatrixUtils.multiply(this.P, Ht),
				invS,
			);
			const Ky = MatrixUtils.matrixVectorMultiply(K, y);
			for (let i = 0; i < 16; i++) this.x[i] += Ky[i];

			const I = MatrixUtils.eye(16);
			const KH = MatrixUtils.multiply(K, H);
			const I_KH = MatrixUtils.subtract(I, KH);
			this.P = MatrixUtils.add(
				MatrixUtils.multiply(
					MatrixUtils.multiply(I_KH, this.P),
					MatrixUtils.transpose(I_KH),
				),
				MatrixUtils.multiply(
					MatrixUtils.multiply(K, R_vel),
					MatrixUtils.transpose(K),
				),
			);
		} catch (e) {}

		this.sanitizeState();
	}

	getPosition(): [number, number, number] {
		return [this.x[0], this.x[1], this.x[2]];
	}
	getVelocity(): [number, number, number] {
		return [this.x[3], this.x[4], this.x[5]];
	}
	getAttitude(): [number, number, number] {
		return this.getEulerFromQuaternion();
	}
	getBiasAcc(): [number, number, number] {
		return [this.x[10], this.x[11], this.x[12]];
	}
	getBiasGyro(): [number, number, number] {
		return [this.x[13], this.x[14], this.x[15]];
	}
	getCovarianceTrace(): number {
		return this.P.reduce((sum, row, i) => sum + row[i], 0);
	}
	getQuaternion(): [number, number, number, number] {
		return [this.x[6], this.x[7], this.x[8], this.x[9]];
	}

	private sanitizeState(): void {
		const vmax = 100.0;
		const bacc_max = 10.0;
		const bgyro_max = 2.0;

		for (let i = 3; i <= 5; i++)
			this.x[i] = Math.max(-vmax, Math.min(vmax, this.x[i]));
		for (let i = 10; i <= 12; i++)
			this.x[i] = Math.max(-bacc_max, Math.min(bacc_max, this.x[i]));
		for (let i = 13; i <= 15; i++)
			this.x[i] = Math.max(-bgyro_max, Math.min(bgyro_max, this.x[i]));

		// Ensure P is symmetric and positive definite (simple hack: clamp diagonals)
		for (let i = 0; i < 16; i++) {
			if (this.P[i][i] < 1e-10) this.P[i][i] = 1e-10;
			for (let j = i + 1; j < 16; j++) {
				const val = (this.P[i][j] + this.P[j][i]) / 2;
				this.P[i][j] = this.P[j][i] = val;
			}
		}
	}
}
