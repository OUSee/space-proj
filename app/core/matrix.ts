export class MatrixUtils {
	static copy(m: number[][]): number[][] {
		return m.map((row) => [...row]);
	}

	static eye(size: number): number[][] {
		const m = Array(size)
			.fill(0)
			.map(() => Array(size).fill(0));
		for (let i = 0; i < size; i++) m[i][i] = 1;
		return m;
	}

	static transpose(m: number[][]): number[][] {
		return m[0].map((_, colIndex) => m.map((row) => row[colIndex]));
	}

	static multiply(a: number[][], b: number[][]): number[][] {
		const result = Array(a.length)
			.fill(0)
			.map(() => Array(b[0].length).fill(0));
		for (let i = 0; i < a.length; i++) {
			for (let j = 0; j < b[0].length; j++) {
				for (let k = 0; k < a[0].length; k++) {
					result[i][j] += a[i][k] * b[k][j];
				}
			}
		}
		return result;
	}

	static add(a: number[][], b: number[][]): number[][] {
		return a.map((row, i) => row.map((val, j) => val + b[i][j]));
	}

	static subtract(a: number[][], b: number[][]): number[][] {
		return a.map((row, i) => row.map((val, j) => val - b[i][j]));
	}

	static scale(m: number[][], s: number): number[][] {
		return m.map((row) => row.map((val) => val * s));
	}

	static matrixVectorMultiply(m: number[][], v: number[]): number[] {
		return m.map((row) =>
			row.reduce((sum, val, i) => sum + val * (v[i] ?? 0), 0),
		);
	}

	static vectorDot(v1: number[], v2: number[]): number {
		return v1.reduce((sum, val, i) => sum + val * (v2[i] ?? 0), 0);
	}

	static inverse(m: number[][]): number[][] {
		// Simple LU decomposition or Gaussian elimination for matrix inversion
		// For EKF, we often invert small matrices (3x3 for position update).
		const n = m.length;
		const inv = this.eye(n);
		const a = this.copy(m);

		for (let i = 0; i < n; i++) {
			let pivot = a[i][i];
			if (Math.abs(pivot) < 1e-12) {
				// Try to find a better pivot
				let found = false;
				for (let j = i + 1; j < n; j++) {
					if (Math.abs(a[j][i]) > 1e-12) {
						[a[i], a[j]] = [a[j], a[i]];
						[inv[i], inv[j]] = [inv[j], inv[i]];
						pivot = a[i][i];
						found = true;
						break;
					}
				}
				if (!found) throw new Error('Matrix is singular');
			}

			for (let j = 0; j < n; j++) {
				if (i !== j) {
					const factor = a[j][i] / pivot;
					for (let k = 0; k < n; k++) {
						a[j][k] -= factor * a[i][k];
						inv[j][k] -= factor * inv[i][k];
					}
				}
			}

			for (let j = 0; j < n; j++) {
				inv[i][j] /= pivot;
				a[i][j] /= pivot;
			}
		}

		return inv;
	}
}
