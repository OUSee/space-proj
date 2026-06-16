// Matrix ops (multiply, inverse, etc.)
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
		return A.map((row) =>
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

	static vectorDot(a: number[], b: number[]): number {
		if (a.length !== b.length) throw new Error('Vector lengths must match');
		return a.reduce((sum, el, i) => sum + el * b[i]!, 0);
	}

	static scale(A: number[][], factor: number): number[][] {
		return A.map((row) => row.map((value) => value * factor));
	}

	static inverse(A: number[][]): number[][] {
		const n = A.length;
		if (n === 0) throw new Error('Cannot invert empty matrix');
		if (!A.every((row) => row.length === n)) {
			throw new Error('Matrix must be square');
		}

		// Create augmented matrix [A | I]
		const identity = MatrixUtils.eye(n);
		const aug = A.map((row, i) => [...row, ...identity[i]!]);

		// Gaussian elimination with partial pivoting
		for (let col = 0; col < n; col++) {
			// Find pivot row
			let pivotRow = col;
			let maxAbs = Math.abs(aug[col]![col]!);
			for (let row = col + 1; row < n; row++) {
				const val = Math.abs(aug[row]![col]!);
				if (val > maxAbs) {
					maxAbs = val;
					pivotRow = row;
				}
			}

			if (maxAbs < 1e-12) {
				throw new Error('Matrix is singular or near-singular');
			}

			// Swap current row with pivot row
			if (pivotRow !== col) {
				const tmp = aug[col];
				aug[col] = aug[pivotRow];
				aug[pivotRow] = tmp;
			}

			// Normalize pivot row
			const pivot = aug[col]![col]!;
			for (let j = 0; j < 2 * n; j++) {
				aug[col]![j]! /= pivot;
			}

			// Eliminate other rows
			for (let row = 0; row < n; row++) {
				if (row === col) continue;
				const factor = aug[row]![col]!;
				if (factor === 0) continue;
				for (let j = 0; j < 2 * n; j++) {
					aug[row]![j]! -= factor * aug[col]![j]!;
				}
			}
		}

		// Extract inverse from the right half
		return aug.map((row) => row.slice(n));
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
