// # Gate, chi2-test
import { MatrixUtils } from './matrix';

export class RobustValidator {
	chi2Test(y: number[], S: number[][], m: number, pfa = 0.001): boolean {
		const invS = MatrixUtils.inverse(S);
		const invSy = MatrixUtils.matrixVectorMultiply(invS, y);
		const mahal = y.reduce((sum, val, i) => sum + val * invSy[i]!, 0);
		// Simplified chi2 threshold, for m=3, pfa=0.001 ~16.27
		const thresh = 16.27;
		return mahal < thresh;
	}
	mahalanobisGate(y: number[], S: number[][]): number {
		const invS = MatrixUtils.inverse(S);
		const invSy = MatrixUtils.matrixVectorMultiply(invS, y);
		return y.reduce((sum, val, i) => sum + val * invSy[i]!, 0);
	}
}
