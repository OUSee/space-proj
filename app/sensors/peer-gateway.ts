// # WebRTC Peer.js IMU/GPS stream
import Peer from 'peerjs';
import type { IMUData } from '~/types';

export class SensorGateway {
	private peer = new Peer('pc-navigator');
	async connect(phoneId: string, onData: (data: IMUData) => void) {
		const conn = this.peer.connect(phoneId);
		conn.on('open', () => {
			console.log('Connected to phone');
		});
		conn.on('data', (data: any) => {
			onData(data as IMUData);
		});
		conn.on('error', (err) => {
			console.error('Peer connection error', err);
		});
	}
}
