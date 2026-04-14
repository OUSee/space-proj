// # Matrix ops (multiply, inverse)
export class MatrixUtils {
	static eye(size: number): number[][] {
		return Array.from({ length: size }, (_, i) =>
			Array.from({ length: size }, (_, j) => (i === j ? 1 : 0)),
		);
	}
	static multiply(A: number[][], B: number[][]): number[][] {
		if (
			A.length === 0 ||
			B.length === 0 ||
			!A[0] ||
			A[0].length !== B.length
		) {
			throw new Error('Invalid matrix dimensions for multiplication');
		}
		return A.map((row, i) =>
			B[0]!.map((_, j) =>
				row.reduce((sum, el, k) => sum + el * (B[k]?.[j] ?? 0), 0),
			),
		);
	}
	static matrixVectorMultiply(A: number[][], v: number[]): number[] {
		if (A.length === 0 || !A[0] || A[0].length !== v.length) {
			throw new Error(
				'Invalid dimensions for matrix-vector multiplication',
			);
		}
		return A.map((row) => row.reduce((sum, el, i) => sum + el * v[i]!, 0));
	}
	static inverse(A: number[][]): number[][] {
		// Simple 3x3 inverse for demo
		if (A.length !== 3 || !A[0] || A[0].length !== 3) return A; // placeholder
		const a = A[0]![0]!,
			b = A[0]![1]!,
			c = A[0]![2]!;
		const d = A[1]![0]!,
			e = A[1]![1]!,
			f = A[1]![2]!;
		const g = A[2]![0]!,
			h = A[2]![1]!,
			i = A[2]![2]!;
		const det =
			a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
		if (det === 0) throw new Error('Matrix not invertible');
		const invDet = 1 / det;
		return [
			[
				(e * i - f * h) * invDet,
				(c * h - b * i) * invDet,
				(b * f - c * e) * invDet,
			],
			[
				(f * g - d * i) * invDet,
				(a * i - c * g) * invDet,
				(c * d - a * f) * invDet,
			],
			[
				(d * h - e * g) * invDet,
				(b * g - a * h) * invDet,
				(a * e - b * d) * invDet,
			],
		];
	}
	static add(A: number[][], B: number[][]): number[][] {
		if (A.length !== B.length || A[0]?.length !== B[0]?.length)
			throw new Error('Matrix dimensions mismatch for addition');
		return A.map((row, i) => row.map((val, j) => val + B[i]![j]!));
	}

	static subtract(A: number[][], B: number[][]): number[][] {
		if (A.length !== B.length || A[0]?.length !== B[0]?.length)
			throw new Error('Matrix dimensions mismatch for subtraction');
		return A.map((row, i) => row.map((val, j) => val - B[i]![j]!));
	}

	static copy(A: number[][]): number[][] {
		return A.map((row) => [...row]);
	}

	// Also add a helper to create a diagonal matrix from an array
	static diag(values: number[]): number[][] {
		const n = values.length;
		const out = Array.from({ length: n }, () => new Array(n).fill(0));
		for (let i = 0; i < n; i++) out[i]![i] = values[i]!;
		return out;
	}
	static transpose(A: number[][]): number[][] {
		if (A.length === 0) return [];
		const numCols = A[0]!.length;
		if (!A.every((row) => row.length === numCols)) {
			throw new Error('Matrix rows have inconsistent lengths');
		}
		return A[0]!.map((_, i) => A.map((row) => row[i]!));
	}
}
