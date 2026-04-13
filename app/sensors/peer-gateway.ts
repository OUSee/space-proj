// # WebRTC Peer.js IMU/GPS stream
import Peer from 'peerjs';
import type { IMUData } from '~/types';

export class SensorGateway {
	private peer: Peer | null = null;
	private initialized = false;

	private async initPeer(): Promise<Peer> {
		if (this.peer) return this.peer;
		if (typeof window === 'undefined')
			throw new Error('Peer.js requires browser environment');

		return new Promise((resolve, reject) => {
			const p = new Peer('pc-navigator', {
				host: '192.168.0.46', // ← ТВОЙ PC IP (ipconfig)
				port: 9000, // ← peerjs --port 9000
				path: '/',
				debug: 2,
				secure: false, // ← HTTP, НЕ wss!
				config: {
					iceServers: [
						// ← Обязательно для local!
						{ urls: 'stun:stun.l.google.com:19302' },
					],
				},
			});
			p.on('open', (id: string) => {
				console.log('Peer initialized with ID:', id);
				this.peer = p;
				this.initialized = true;
				resolve(p);
			});

			p.on('error', (err: any) => {
				console.error('Peer initialization error:', err);
				reject(err);
			});

			// Timeout after 15s
			setTimeout(() => {
				if (!this.initialized) {
					p.destroy();
					reject(
						new Error(
							'Peer initialization timeout - check internet connection',
						),
					);
				}
			}, 15000);
		});
	}

	async connect(
		phoneId: string,
		onData: (data: IMUData) => void,
	): Promise<void> {
		try {
			const peer = await this.initPeer();
			const conn = peer.connect(phoneId);

			return new Promise((resolve, reject) => {
				conn.on('open', () => {
					console.log('Connected to phone:', phoneId);
					resolve();
				});

				conn.on('data', (data: any) => {
					onData(data as IMUData);
				});

				conn.on('error', (err) => {
					console.error('Connection error:', err);
					reject(err);
				});

				conn.on('close', () => {
					console.log('Connection closed');
				});

				// Timeout after 60s - WebRTC can take time
				setTimeout(() => {
					if (!conn.open) {
						conn.close();
						reject(
							new Error(
								'Connection timeout - phone not responding. Verify phone Peer ID is correct.',
							),
						);
					}
				}, 60000);
			});
		} catch (error) {
			console.error('Connect failed:', error);
			throw error;
		}
	}
}
