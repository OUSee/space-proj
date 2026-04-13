// # Pinia-like store (xest, Pk, EKF) - Phone-only mode
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { AEKFFilter } from '~/core/aekf';
import type { StateVector, IMUData } from '~/types';

export const useNavStore = defineStore('nav', () => {
	const deviceMode = ref<'pc' | 'phone'>('phone');
	const filter = ref<AEKFFilter>();
	const xest = ref<StateVector>({
		pos: [0, 0, 0],
		vel: [0, 0, 0],
		att: [0, 0, 0],
		biasAcc: [0, 0, 0],
		biasGyro: [0, 0, 0],
	});
	const trajectory = ref<number[][]>([]);
	const rmse = computed(() => {
		if (trajectory.value.length < 2) return 0;
		let sum = 0;
		for (const pos of trajectory.value) {
			if (
				pos &&
				pos[0] !== undefined &&
				pos[1] !== undefined &&
				pos[2] !== undefined
			) {
				sum += pos[0] * pos[0] + pos[1] * pos[1] + pos[2] * pos[2];
			}
		}
		return Math.sqrt(sum / trajectory.value.length);
	});
	const chi2 = computed(() => {
		// Placeholder: from filter residuals
		return 1.2;
	});
	const fps = ref(0);

	const init = () => {
		// Initialize AEKF filter for phone mode (all calculations local)
		const Q = Array.from({ length: 15 }, () => Array(15).fill(0.01));
		const R = Array.from({ length: 3 }, () => Array(3).fill(0.1));
		filter.value = new AEKFFilter(0.01, Q, R);
	};

	const feedIMU = (imu: IMUData) => {
		// Process IMU data through filter (local on phone)
		if (filter.value) {
			const pred = filter.value.predict(imu);
			xest.value.pos = pred.xpred.slice(0, 3) as [number, number, number];
			xest.value.vel = pred.xpred.slice(3, 6) as [number, number, number];
			xest.value.att = pred.xpred.slice(6, 9) as [number, number, number];
			xest.value.biasAcc = pred.xpred.slice(9, 12) as [
				number,
				number,
				number,
			];
			xest.value.biasGyro = pred.xpred.slice(12, 15) as [
				number,
				number,
				number,
			];

			trajectory.value.push([...xest.value.pos]);
			if (trajectory.value.length > 2000) trajectory.value.shift();
		}
	};

	return {
		deviceMode,
		init,
		feedIMU,
		xest,
		trajectory,
		rmse,
		chi2,
		fps,
	};
});
