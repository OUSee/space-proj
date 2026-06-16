const EARTH_RADIUS = 6378137;

export function deg2rad(deg: number): number {
	return (deg * Math.PI) / 180;
}

export function rad2deg(rad: number): number {
	return (rad * 180) / Math.PI;
}

export function geodeticToEnu(
	lat: number,
	lon: number,
	alt: number,
	refLat: number,
	refLon: number,
	refAlt: number,
): [number, number, number] {
	const dLat = deg2rad(lat - refLat);
	const dLon = deg2rad(lon - refLon);
	const meanLat = deg2rad((lat + refLat) / 2);

	const east = dLon * Math.cos(meanLat) * EARTH_RADIUS;
	const north = dLat * EARTH_RADIUS;
	const up = alt - refAlt;

	return [east, north, up];
}

export function enuToGeodetic(
	east: number,
	north: number,
	up: number,
	refLat: number,
	refLon: number,
	refAlt: number,
) {
	const dLat = north / EARTH_RADIUS;
	const dLon = east / (EARTH_RADIUS * Math.cos(deg2rad(refLat)));

	return {
		lat: refLat + rad2deg(dLat),
		lon: refLon + rad2deg(dLon),
		alt: refAlt + up,
	};
}

export function haversineDistance(
	lat1: number,
	lon1: number,
	lat2: number,
	lon2: number,
): number {
	const dLat = deg2rad(lat2 - lat1);
	const dLon = deg2rad(lon2 - lon1);
	const a =
		Math.sin(dLat / 2) * Math.sin(dLat / 2) +
		Math.cos(deg2rad(lat1)) *
		Math.cos(deg2rad(lat2)) *
		Math.sin(dLon / 2) *
		Math.sin(dLon / 2);
	return EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
