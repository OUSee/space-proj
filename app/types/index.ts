// # StateVector, IMUData, etc.
export interface StateVector {
	pos: [number, number, number];
	vel: [number, number, number];
	att: [number, number, number];
	biasAcc: [number, number, number];
	biasGyro: [number, number, number];
}
export interface IMUData {
	accel: [number, number, number];
	gyro: [number, number, number];
	ts: number;
}
export interface Measurement {
	type: 'GPS' | 'BARO';
	data: number[];
}
