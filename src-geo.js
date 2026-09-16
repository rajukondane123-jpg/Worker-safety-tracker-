// ALTIGUARD geometry helpers.
// Public zone payloads use [lat,lng]. Internally the ray-casting routine
// normalizes them to [lng,lat] so longitude is X and latitude is Y.
export function normalizeRing(polygon) {
  if (!Array.isArray(polygon)) return [];
  const ring = Array.isArray(polygon[0]) && Array.isArray(polygon[0][0]) ? polygon[0] : polygon;
  return ring.filter(p => Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
    .map(p => [Number(p[0]), Number(p[1])]);
}

export function pointInPolygon(point, polygon) {
  const [x, y] = point || [];
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const ring = normalizeRing(polygon).map(([lat,lng]) => [lng,lat]);
  if (ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / ((yj - yi) || Number.EPSILON) + xi);
    if (crosses) inside = !inside;
  }
  return inside;
}

export function pointToGeoJSON(lat, lng) { return [Number(lng), Number(lat)]; }
