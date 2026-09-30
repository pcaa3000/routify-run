export type Place = { label: string; lat: number; lon: number };
export type Coord = { lat: number; lon: number };
export type RouteStep = { distance: number; name?: string; mode?: string };
export type FootRoute = { coords: Coord[]; distance: number; steps: RouteStep[] };
export type RoutePoint = Coord & { km: number; elevation: number; grade: number; paceMinKm: number; elapsedSec: number };
export type HydrationPlan = { intervalMin: number; mlLow: number; mlHigh: number; sweatLHour: number; stops: number[] };

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
let lastNominatimRequest = 0;

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<Place[]> {
  const wait = Math.max(0, 1100 - (Date.now() - lastNominatimRequest));
  if (wait) await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, wait);
    signal?.addEventListener('abort', () => { window.clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  lastNominatimRequest = Date.now();
  const url = new URL(NOMINATIM);
  url.search = new URLSearchParams({ q: query, format: 'jsonv2', limit: '5', addressdetails: '1' }).toString();
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(response.status === 429 ? 'Nominatim está limitando las búsquedas. Espera un momento.' : `No se pudo buscar el lugar (${response.status}).`);
  const data = await response.json() as Array<{ lat: string; lon: string; display_name: string }>;
  return data.map((item) => ({ lat: Number(item.lat), lon: Number(item.lon), label: item.display_name }));
}

function destinationPoint(origin: Coord, distanceKm: number, bearingDegrees: number): Coord {
  const angular = distanceKm / 6371;
  const bearing = bearingDegrees * Math.PI / 180;
  const lat1 = origin.lat * Math.PI / 180;
  const lon1 = origin.lon * Math.PI / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing));
  const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1), Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: lat2 * 180 / Math.PI, lon: lon2 * 180 / Math.PI };
}

export async function fetchFootRoute(start: Coord, targetKm: number, destination?: Coord, signal?: AbortSignal): Promise<FootRoute> {
  // Four intermediate waypoints make a real loop, rather than a single out-and-back.
  // The four cardinal waypoints approximate the requested square-loop perimeter;
  // the pedestrian router snaps each point to nearby walkable paths.
  const waypoints: Coord[] = destination ? [start, destination] : [
    start,
    ...[0, 90, 180, 270].map((bearing) => destinationPoint(start, Math.max(0.08, targetKm / (4 * Math.sqrt(2))), bearing)),
    start,
  ];
  const coordinates = waypoints.map((point) => `${point.lon},${point.lat}`).join(';');
  const url = `https://routing.openstreetmap.de/routed-foot/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=true&alternatives=false`;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(response.status === 429 ? 'El servicio de rutas peatonales está saturado. Inténtalo de nuevo en un minuto.' : `El servicio de rutas peatonales respondió ${response.status}.`);
  const data = await response.json() as { code: string; message?: string; routes?: Array<{ distance: number; geometry: { coordinates: [number, number][] }; legs: Array<{ steps: Array<{ distance: number; name?: string; mode?: string }> }> }>; };
  if (data.code !== 'Ok' || !data.routes?.[0]) throw new Error(data.message || 'No se encontró un camino peatonal entre esos puntos. Prueba con otro origen o destino.');
  const route = data.routes[0];
  const coords = route.geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
  if (coords.length < 2) throw new Error('La ruta devuelta no contiene suficientes puntos.');
  return { coords, distance: route.distance, steps: route.legs.flatMap((leg) => leg.steps.map((step) => ({ distance: step.distance, name: step.name, mode: step.mode }))) };
}

function haversine(a: Coord, b: Coord): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const p = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(p), Math.sqrt(1 - p));
}

export function sampleRoute(coords: Coord[], count = 72): Array<Coord & { km: number }> {
  const cumulative = [0];
  for (let i = 1; i < coords.length; i++) cumulative.push(cumulative[i - 1] + haversine(coords[i - 1], coords[i]));
  const total = cumulative[cumulative.length - 1];
  if (!total) return [];
  const samples: Array<Coord & { km: number }> = [];
  let segment = 1;
  for (let index = 0; index < count; index++) {
    const target = total * index / (count - 1);
    while (segment < cumulative.length - 1 && cumulative[segment] < target) segment++;
    const before = cumulative[segment - 1];
    const span = cumulative[segment] - before;
    const ratio = span ? (target - before) / span : 0;
    samples.push({
      lat: coords[segment - 1].lat + (coords[segment].lat - coords[segment - 1].lat) * ratio,
      lon: coords[segment - 1].lon + (coords[segment].lon - coords[segment - 1].lon) * ratio,
      km: target / 1000,
    });
  }
  return samples;
}

export async function fetchElevations(samples: Array<Coord & { km: number }>, signal?: AbortSignal): Promise<number[]> {
  if (!samples.length) throw new Error('No hay puntos de ruta para calcular la altitud.');
  const elevations: number[] = [];
  // Open-Meteo accepts coordinate arrays; small batches avoid URL and service limits.
  for (let start = 0; start < samples.length; start += 80) {
    const batch = samples.slice(start, start + 80);
    const url = new URL('https://api.open-meteo.com/v1/elevation');
    url.search = new URLSearchParams({
      latitude: batch.map((p) => p.lat.toFixed(5)).join(','),
      longitude: batch.map((p) => p.lon.toFixed(5)).join(','),
    }).toString();
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(response.status === 429 ? 'Open-Meteo está limitando las solicitudes de altitud. Espera un momento.' : `No se pudo obtener la altitud (${response.status}).`);
    const result = await response.json() as { elevation?: number[] };
    if (!Array.isArray(result.elevation) || result.elevation.some((value) => !Number.isFinite(value))) throw new Error('La respuesta de altitud no contiene datos válidos.');
    elevations.push(...result.elevation);
  }
  return elevations;
}

export function buildRouteProfile(samples: Array<Coord & { km: number }>, elevations: number[], flatPace: number): RoutePoint[] {
  if (samples.length !== elevations.length) throw new Error('No coinciden los puntos de ruta y los datos de altitud.');
  let elapsed = 0;
  return samples.map((sample, index) => {
    const previous = index ? samples[index - 1] : sample;
    const distanceKm = index ? sample.km - previous.km : 0;
    const elevationDifference = index ? elevations[index] - elevations[index - 1] : 0;
    const grade = distanceKm ? elevationDifference / (distanceKm * 1000) * 100 : 0;
    const multiplier = grade > 0 ? 1 + 0.035 * grade : Math.max(0.94, 1 - 0.018 * Math.min(Math.abs(grade), 6));
    const paceMinKm = flatPace * multiplier;
    elapsed += distanceKm * paceMinKm * 60;
    return { ...sample, elevation: elevations[index], grade, paceMinKm, elapsedSec: elapsed };
  });
}

export function hydrationPlan(weightKg: number, temperatureC: number, durationMin: number): HydrationPlan {
  const intervalMin = temperatureC <= 18 ? 20 : temperatureC <= 28 ? 15 : 11;
  const mlLow = temperatureC <= 18 ? 120 : 150;
  const mlHigh = temperatureC <= 18 ? 150 : 200;
  const sweatLHour = weightKg * 0.012 * (1 + (temperatureC - 20) / 30);
  const stops: number[] = [];
  for (let minute = intervalMin; minute < durationMin; minute += intervalMin) stops.push(minute * 60);
  return { intervalMin, mlLow, mlHigh, sweatLHour, stops };
}

export function pointAtElapsed(profile: RoutePoint[], elapsedSec: number): { lat: number; lon: number; km: number; point: RoutePoint } {
  if (!profile.length) throw new Error('La ruta aún no tiene perfil.');
  const target = Math.max(0, Math.min(elapsedSec, profile[profile.length - 1].elapsedSec));
  let right = profile.findIndex((point) => point.elapsedSec >= target);
  if (right < 0) right = profile.length - 1;
  const left = Math.max(0, right - 1);
  const a = profile[left];
  const b = profile[right];
  const ratio = b.elapsedSec === a.elapsedSec ? 0 : (target - a.elapsedSec) / (b.elapsedSec - a.elapsedSec);
  return {
    lat: a.lat + (b.lat - a.lat) * ratio,
    lon: a.lon + (b.lon - a.lon) * ratio,
    km: a.km + (b.km - a.km) * ratio,
    point: ratio < 0.5 ? a : b,
  };
}

export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${minutes}:${String(secs).padStart(2, '0')}`;
}

export function formatPace(minPerKm: number): string {
  const seconds = Math.max(0, Math.round(minPerKm * 60));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function bearingDeltaKm(origin: Coord, target: Coord): number {
  return haversine(origin, target) / 1000;
}