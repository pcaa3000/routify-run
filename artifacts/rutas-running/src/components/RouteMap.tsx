import { useEffect, useRef, useState } from 'react';
import { Map, MapPinned } from 'lucide-react';
import type { Coord, Place, RoutePoint, RouteStep } from '../lib/running';
import { pointAtElapsed } from '../lib/running';

type LeafletIcon = { divIcon: (options: Record<string, unknown>) => unknown };
type LeafletMapInstance = {
  setView: (center: [number, number], zoom: number) => LeafletMapInstance;
  fitBounds: (bounds: unknown, options?: Record<string, unknown>) => LeafletMapInstance;
  remove: () => void;
  invalidateSize: () => void;
};
type LeafletGroup = { addTo: (map: LeafletMapInstance) => LeafletGroup; clearLayers: () => void };
type LeafletMarker = { addTo: (group: LeafletGroup | LeafletMapInstance) => LeafletMarker; setLatLng: (point: [number, number]) => void };
type LeafletApi = {
  map: (element: HTMLElement, options?: Record<string, unknown>) => LeafletMapInstance;
  tileLayer: (url: string, options: Record<string, unknown>) => { addTo: (map: LeafletMapInstance) => unknown };
  marker: (point: [number, number], options?: Record<string, unknown>) => LeafletMarker;
  divIcon: (options: Record<string, unknown>) => unknown;
  polyline: (coords: [number, number][], options: Record<string, unknown>) => { addTo: (group: LeafletGroup) => unknown };
  featureGroup: () => LeafletGroup & { getBounds: () => unknown };
  latLngBounds: (coords: [number, number][]) => unknown;
};
declare global { interface Window { L?: LeafletApi } }

let leafletPromise: Promise<LeafletApi> | null = null;
function loadLeaflet(): Promise<LeafletApi> {
  if (window.L) return Promise.resolve(window.L);
  if (!leafletPromise) {
    leafletPromise = new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      link.dataset.leaflet = 'true';
      document.head.appendChild(link);
      const existing = document.querySelector<HTMLScriptElement>('script[data-leaflet="true"]');
      const script = existing || document.createElement('script');
      script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      script.dataset.leaflet = 'true';
      script.onload = () => window.L ? resolve(window.L) : reject(new Error('La librería del mapa no está disponible.'));
      script.onerror = () => {
        script.remove();
        leafletPromise = null;
        reject(new Error('No se pudo cargar Leaflet. Comprueba la conexión para mostrar el mapa.'));
      };
      if (!existing) document.body.appendChild(script);
    });
  }
  return leafletPromise;
}

function iconHtml(kind: 'start' | 'end' | 'water' | 'runner') {
  if (kind === 'water') return `<div class="map-pin water water-pop"><span><svg width="15" height="17" viewBox="0 0 16 20" fill="none" aria-hidden="true"><path d="M8 1C6.2 4.1 2 8.5 2 12a6 6 0 0 0 12 0c0-3.5-4.2-7.9-6-11Z" fill="white"/><path d="M5 13c.2 1.4 1.1 2.2 2.4 2.5" stroke="#DF7955" stroke-width="1.2" stroke-linecap="round"/></svg></span></div>`;
  const content = kind === 'start' ? 'S' : kind === 'end' ? 'F' : 'R';
  return `<div class="map-pin ${kind} ${kind === 'runner' ? 'runner-pulse' : ''}"><span>${content}</span></div>`;
}

export function RouteMap({ start, route, steps, profile, hydrationSeconds, elapsed, mapId }: {
  start: Place | null;
  route: Coord[] | null;
  steps: RouteStep[];
  profile: RoutePoint[];
  hydrationSeconds: number[];
  elapsed: number;
  mapId: string;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMapInstance | null>(null);
  const layerRef = useRef<LeafletGroup | null>(null);
  const runnerRef = useRef<LeafletMarker | null>(null);
  const [mapError, setMapError] = useState('');
  const [ready, setReady] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let alive = true;
    loadLeaflet().then((L) => {
      if (!alive || !elementRef.current) return;
      if (!mapRef.current) {
        const initial: [number, number] = start ? [start.lat, start.lon] : [0, 0];
        const map = L.map(elementRef.current, { zoomControl: true, scrollWheelZoom: true, keyboard: true }).setView(initial, start ? 14 : 2);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
        }).addTo(map);
        mapRef.current = map;
        layerRef.current = L.featureGroup().addTo(map);
        window.setTimeout(() => map.invalidateSize(), 80);
      }
      setReady(true);
      setMapError('');
    }).catch((error: unknown) => {
      if (alive) setMapError(error instanceof Error ? error.message : 'Error al cargar el mapa.');
    });
    return () => { alive = false; };
  }, [retryCount]);

  useEffect(() => {
    const L = window.L;
    const map = mapRef.current;
    const layers = layerRef.current;
    if (!L || !map || !layers) return;
    layers.clearLayers();
    runnerRef.current = null;
    if (route?.length) {
      const points: [number, number][] = route.map((point) => [point.lat, point.lon]);
      L.polyline(points, { color: '#f7f2e7', weight: 10, opacity: .96, lineCap: 'round', lineJoin: 'round' }).addTo(layers);
      // Step names from the routing response identify footpaths and cycleways when available.
      const totalMeters = route.slice(1).reduce((sum, point, index) => {
        const a = route[index];
        return sum + Math.hypot((point.lat - a.lat) * 111_000, (point.lon - a.lon) * 111_000 * Math.cos(a.lat * Math.PI / 180));
      }, 0);
      let kmBefore = 0;
      const totalStep = steps.reduce((sum, step) => sum + step.distance, 0) || totalMeters;
      if (!steps.length) L.polyline(points, { color: '#4f7f9c', weight: 5.5, opacity: 0.98, lineCap: 'round', lineJoin: 'round' }).addTo(layers);
      steps.forEach((step) => {
        const fraction = step.distance / totalStep;
        const startIndex = Math.floor((kmBefore / totalStep) * (route.length - 1));
        kmBefore += step.distance;
        const endIndex = Math.max(startIndex + 1, Math.ceil((kmBefore / totalStep) * (route.length - 1)));
        const name = `${step.name || ''} ${step.mode || ''}`.toLowerCase();
        const naturalPath = /parque|park|ciclov|cycle|trail|sender|camino|path|pista|greenway/.test(name);
        L.polyline(points.slice(startIndex, Math.min(route.length, endIndex + 1)), {
          color: naturalPath ? '#347a60' : '#4f7f9c',
          weight: naturalPath ? 5 : 5.5,
          opacity: 0.98,
          lineCap: 'round',
          lineJoin: 'round',
        }).addTo(layers);
      });
      L.marker(points[0], { icon: L.divIcon({ className: '', html: iconHtml('start'), iconSize: [28, 34], iconAnchor: [13, 31] }), title: 'Salida', alt: 'Marcador de salida' }).addTo(layers);
      L.marker(points[points.length - 1], { icon: L.divIcon({ className: '', html: iconHtml('end'), iconSize: [28, 34], iconAnchor: [13, 31] }), title: 'Llegada', alt: 'Marcador de llegada' }).addTo(layers);
      hydrationSeconds.forEach((second, index) => {
        const point = pointAtElapsed(profile, second);
        const marker = L.marker([point.lat, point.lon], { icon: L.divIcon({ className: '', html: iconHtml('water'), iconSize: [28, 34], iconAnchor: [13, 31] }), title: `Pausa de agua ${index + 1}`, alt: `Punto de hidratación ${index + 1}` });
        marker.addTo(layers);
      });
      if (profile.length) {
        const runner = pointAtElapsed(profile, elapsed);
        runnerRef.current = L.marker([runner.lat, runner.lon], { icon: L.divIcon({ className: '', html: iconHtml('runner'), iconSize: [34, 40], iconAnchor: [16, 36] }), title: 'Tu posición simulada', alt: 'Corredor en la ruta' }).addTo(layers);
      }
      map.fitBounds(L.latLngBounds(points), { padding: [34, 34], maxZoom: 16 });
    } else if (start) {
      map.setView([start.lat, start.lon], 15);
      L.marker([start.lat, start.lon], { icon: L.divIcon({ className: '', html: iconHtml('start'), iconSize: [28, 34], iconAnchor: [13, 31] }), title: 'Salida', alt: 'Marcador de salida' }).addTo(layers);
    } else {
      map.setView([0, 0], 2);
    }
  }, [start, route, steps, profile, hydrationSeconds, mapId]);

  useEffect(() => {
    if (!profile.length || !runnerRef.current) return;
    const point = pointAtElapsed(profile, elapsed);
    runnerRef.current.setLatLng([point.lat, point.lon]);
  }, [elapsed, profile]);

  return (
    <div className="map-frame">
      <div ref={elementRef} className="map-canvas" role="application" aria-label="Mapa interactivo de la ruta de carrera" data-testid="map-route" />
      {!ready && !mapError && <div className="map-loading"><span className="map-skeleton" /><span>Cargando mapa de OpenStreetMap</span></div>}
      {mapError && <div className="map-error" role="alert"><MapPinned size={20} /><span>{mapError}</span><button type="button" onClick={() => { leafletPromise = null; setRetryCount((count) => count + 1); }} data-testid="button-map-retry">Reintentar</button></div>}
      {ready && !route && !start && <div className="map-empty"><span className="map-empty-mark"><Map size={20} /></span><strong>La ruta empieza aquí.</strong><span>Busca un punto de salida o comparte tu ubicación.</span></div>}
      {route && <div className="map-key" aria-label="Leyenda del mapa"><span><i className="key-line street" /> Calles</span><span><i className="key-line path" /> Senderos / parques</span><span><i className="key-dot water-key" /> Agua</span></div>}
      {route && <div className="map-scale-note">Camino peatonal · OpenStreetMap</div>}
    </div>
  );
}