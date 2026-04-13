// # Pinia-like store (xest, Pk, EKF)
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { AEKFFilter } from '~/core/aekf';
import { SensorGateway } from '~/sensors/peer-gateway';
import type { StateVector, IMUData } from '~/types';

export const useNavStore = defineStore('nav', () => {
	const deviceMode = ref<'pc' | 'phone'>('pc');
	const filter = ref<AEKFFilter>();
	const gateway = ref<SensorGateway>();
	const xest = ref<StateVector>({
		pos: [0, 0, 0],
		vel: [0, 0, 0],
		att: [0, 0, 0],
		biasAcc: [0, 0, 0],
		biasGyro: [0, 0, 0],
	});
	const trajectory = ref<number[][]>([]);
	const rmse = computed(() => {
		// Placeholder: calculate RMSE from trajectory
		return 0.5; // example
	});
	const chi2 = computed(() => {
		// Placeholder: from filter residuals
		return 1.2;
	});
	const fps = ref(0);
	const init = () => {
		// Only initialize AEKF on PC mode
		if (deviceMode.value === 'pc') {
			// Placeholder covariances: Q 15x15, R 3x3
			const Q = Array.from({ length: 15 }, () => Array(15).fill(0.1));
			const R = Array.from({ length: 3 }, () => Array(3).fill(0.1));
			filter.value = new AEKFFilter(0.01, Q, R);
		}
	};
	const connectPhone = async (id: string) => {
		if (!id) throw new Error('Invalid phone ID');
		if (!gateway.value) gateway.value = new SensorGateway();
		await gateway.value.connect(id, feedIMU);
	};
	const feedIMU = (imu: IMUData) => {
		// Only process IMU on PC mode
		if (deviceMode.value === 'pc' && filter.value) {
			const pred = filter.value.predict(imu);
			/* update xest */
			trajectory.value.push(pred.xpred.slice(0, 3));
			if (trajectory.value.length > 1000) trajectory.value.shift();
		}
	};
	return {
		deviceMode,
		init,
		connectPhone,
		feedIMU,
		xest,
		trajectory,
		rmse,
		chi2,
		fps,
	};
});
