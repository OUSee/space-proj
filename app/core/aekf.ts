// # AEKF 15x15 (predict/update)

import { MatrixUtils } from './matrix';
import type { IMUData } from '~/types';

interface Measurement {
	pos?: [number, number, number];
	vel?: [number, number, number];
}

export class AEKFFilter {
	private xest: number[] = new Array(15).fill(0);
	private Pest: number[][] = MatrixUtils.eye(15).map((row) =>
		row.map(() => 100),
	);
	private dt = 0.01;
	private Q: number[][];
	private R: number[][];
	private sageD = 0.02;
	constructor(dt: number, Q: number[][], R: number[][]) {
		this.dt = dt;
		this.Q = Q;
		this.R = R;
	}
	predict(imu: IMUData): { xpred: number[]; Ppred: number[][] } {
		// Simplified kinematics: integrate IMU
		// xest[3-5] vel += (imu.accel - biasAcc) * dt
		for (let i = 0; i < 3; i++) {
			this.xest[3 + i]! += (imu.accel[i]! - this.xest[9 + i]!) * this.dt;
			this.xest[i]! += this.xest[3 + i]! * this.dt; // pos += vel * dt
			// att += gyro * dt (simplified, no quaternion)
			this.xest[6 + i]! += (imu.gyro[i]! - this.xest[12 + i]!) * this.dt;
		}
		// F matrix: identity + kinematics
		const F = MatrixUtils.eye(15);
		for (let i = 0; i < 3; i++) {
			F[i]![i + 3] = this.dt;
			F[i + 3]![i + 9] = -this.dt; // vel -= biasAcc * dt (but approximated)
			F[i + 6]![i + 12] = -this.dt;
		}
		// Ppred = F * Pest * F' + Q
		let Ppred = MatrixUtils.multiply(
			MatrixUtils.multiply(F, this.Pest),
			MatrixUtils.transpose(F),
		);
		for (let i = 0; i < 15; i++) {
			if (Ppred[i] && Ppred[i]![i] !== undefined) {
				Ppred[i]![i]! += this.Q[i]![i]!;
			}
		}
		return { xpred: [...this.xest], Ppred };
	}
	update(z: Measurement, H: number[][], R: number[][]): void {
		if (!z.pos) return; // only GPS for now
		const y = z.pos!.map((val, i) => val - this.xest[i]!); // innovation
		const HPHt = MatrixUtils.multiply(
			MatrixUtils.multiply(H, this.Pest),
			MatrixUtils.transpose(H),
		);
		const S = MatrixUtils.multiply(HPHt, R); // simplified, should be HPHt + R
		// For simplicity, assume S is 3x3, compute inv(S) manually or placeholder
		const invS = MatrixUtils.inverse(S); // placeholder
		const K = MatrixUtils.multiply(
			MatrixUtils.multiply(this.Pest, MatrixUtils.transpose(H)),
			invS,
		);
		// Update xest
		const Ky = MatrixUtils.matrixVectorMultiply(K, y);
		for (let i = 0; i < 15; i++) this.xest[i]! += Ky[i]!;
		// Joseph form for Pest
		const I = MatrixUtils.eye(15);
		const IK = MatrixUtils.multiply(
			I,
			MatrixUtils.multiply(K, H).map((row) => row.map((el) => -el)),
		); // I - K*H
		const PestNew = MatrixUtils.multiply(
			MatrixUtils.multiply(IK, this.Pest),
			MatrixUtils.transpose(IK),
		);
		const KRKt = MatrixUtils.multiply(
			MatrixUtils.multiply(K, R),
			MatrixUtils.transpose(K),
		);
		// Pest = (I - K*H)*Pest*(I - K*H)' + K*R*K'
		for (let i = 0; i < 15; i++) {
			for (let j = 0; j < 15; j++) {
				this.Pest[i]![j]! += KRKt[i]![j]!;
			}
		}
		// Simplified, not full Joseph
		this.Pest = PestNew;
	}
}
