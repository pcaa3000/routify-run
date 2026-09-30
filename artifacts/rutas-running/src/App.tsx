import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  Activity, AlertCircle, ArrowDownRight, ArrowUpRight, Check,
  Clock3, Droplets, Footprints, Gauge, MapPin, Mountain, Pause, Play,
  RotateCcw, Route as RouteIcon, Thermometer, Volume2, VolumeX, Weight,
} from 'lucide-react';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import { LocationSearch } from './components/LocationSearch';
import { RouteMap } from './components/RouteMap';
import { ElevationProfile } from './components/ElevationProfile';
import {
  buildRouteProfile, fetchElevations, fetchFootRoute, formatDuration, formatPace,
  hydrationPlan, pointAtElapsed, sampleRoute, type FootRoute, type Place, type RoutePoint,
} from './lib/running';
import './index.css';

const queryClient = new QueryClient();

type GeneratedRoute = {
  coords: FootRoute['coords'];
  steps: FootRoute['steps'];
  profile: RoutePoint[];
  distanceKm: number;
  ascent: number;
  descent: number;
  id: number;
};

function parsePace(value: string): number | null {
  const match = value.trim().match(/^(\d{1,2}):([0-5]\d)$/);
  if (!match) return null;
  return Number(match[1]) + Number(match[2]) / 60;
}

function Home() {
  const [start, setStart] = useState<Place | null>(null);
  const [destination, setDestination] = useState<Place | null>(null);
  const [routeKind, setRouteKind] = useState<'loop' | 'destination'>('loop');
  const [distance, setDistance] = useState('5');
  const [weight, setWeight] = useState('68');
  const [temperature, setTemperature] = useState('18');
  const [paceInput, setPaceInput] = useState('5:30');
  const [routeData, setRouteData] = useState<GeneratedRoute | null>(null);
  const [busy, setBusy] = useState<'route' | 'elevation' | null>(null);
  const [gpsBusy, setGpsBusy] = useState(false);
  const [error, setError] = useState('');
  const [gpsError, setGpsError] = useState('');
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [elapsed, setElapsed] = useState(0);
  const [soundAlert, setSoundAlert] = useState(false);
  const [hydrationNotice, setHydrationNotice] = useState<number | null>(null);
  const elapsedRef = useRef(0);
  const lastFrameRef = useRef<number | null>(null);
  const alertIndexRef = useRef(0);
  const hydrationRef = useRef<number[]>([]);
  const soundRef = useRef(false);
  const audioRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    document.title = 'Paso — planificador de rutas para correr';
    const meta = document.querySelector('meta[name="description"]') || document.createElement('meta');
    meta.setAttribute('name', 'description');
    meta.setAttribute('content', 'Planifica una ruta peatonal, conoce sus desniveles y prepara tu ritmo e hidratación antes de salir a correr.');
    if (!meta.parentElement) document.head.appendChild(meta);
  }, []);

  const flatPace = parsePace(paceInput);
  const runnerWeight = Number(weight);
  const ambientTemp = Number(temperature);
  const targetKm = Number(distance);
  const totalSeconds = routeData?.profile.at(-1)?.elapsedSec || 0;
  const hydration = useMemo(
    () => routeData ? hydrationPlan(runnerWeight, ambientTemp, totalSeconds / 60) : null,
    [routeData, runnerWeight, ambientTemp, totalSeconds],
  );
  const currentPoint = routeData?.profile.length ? pointAtElapsed(routeData.profile, elapsed) : null;
  const currentKm = currentPoint?.km || 0;
  const progress = totalSeconds ? Math.min(100, elapsed / totalSeconds * 100) : 0;

  useEffect(() => { elapsedRef.current = elapsed; }, [elapsed]);
  useEffect(() => { soundRef.current = soundAlert; }, [soundAlert]);
  useEffect(() => {
    hydrationRef.current = hydration?.stops || [];
    const nextStop = hydrationRef.current.findIndex((stop) => stop > elapsedRef.current);
    alertIndexRef.current = nextStop < 0 ? hydrationRef.current.length : nextStop;
  }, [routeData, hydration]);

  useEffect(() => {
    if (!running || !routeData) return;
    lastFrameRef.current = null;
    const timer = window.setInterval(() => {
      const now = performance.now();
      if (lastFrameRef.current === null) {
        lastFrameRef.current = now;
        return;
      }
      const delta = (now - lastFrameRef.current) / 1000 * speed;
      lastFrameRef.current = now;
      const next = Math.min(totalSeconds, elapsedRef.current + delta);
      const stops = hydrationRef.current;
      while (alertIndexRef.current < stops.length && elapsedRef.current < stops[alertIndexRef.current] && next >= stops[alertIndexRef.current]) {
        setHydrationNotice(alertIndexRef.current + 1);
        window.setTimeout(() => setHydrationNotice(null), 4300);
        if (soundRef.current) {
          try {
            const AudioContextClass = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (AudioContextClass) {
              if (!audioRef.current) audioRef.current = new AudioContextClass();
              const context = audioRef.current;
              const oscillator = context.createOscillator();
              const gain = context.createGain();
              oscillator.type = 'sine';
              oscillator.frequency.value = 660;
              gain.gain.setValueAtTime(0.035, context.currentTime);
              gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.42);
              oscillator.connect(gain);
              gain.connect(context.destination);
              oscillator.start();
              oscillator.stop(context.currentTime + 0.43);
            }
          } catch { /* Audio is optional; the visual hydration alert remains active. */ }
        }
        alertIndexRef.current++;
      }
      elapsedRef.current = next;
      setElapsed(next);
      if (next >= totalSeconds) setRunning(false);
    }, 160);
    return () => { window.clearInterval(timer); lastFrameRef.current = null; };
  }, [running, routeData, speed, totalSeconds]);

  async function generateRoute(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if (!start) { setError('Indica un punto de salida antes de calcular la ruta.'); return; }
    if (!Number.isFinite(targetKm) || targetKm < 0.5 || targetKm > 42) { setError('La distancia debe estar entre 0,5 y 42 km.'); return; }
    if (routeKind === 'destination' && !destination) { setError('Elige un destino de la lista para continuar.'); return; }
    if (!Number.isFinite(runnerWeight) || runnerWeight < 30 || runnerWeight > 200) { setError('El peso debe estar entre 30 y 200 kg.'); return; }
    if (!Number.isFinite(ambientTemp) || ambientTemp < -10 || ambientTemp > 50) { setError('La temperatura debe estar entre −10 y 50 °C.'); return; }
    if (!flatPace || flatPace < 2.5 || flatPace > 15) { setError('Introduce un ritmo válido entre 2:30 y 15:00 min/km.'); return; }

    const controller = new AbortController();
    setBusy('route');
    setRunning(false);
    setHydrationNotice(null);
    try {
      const result = await fetchFootRoute(
        { lat: start.lat, lon: start.lon },
        targetKm,
        routeKind === 'destination' && destination ? { lat: destination.lat, lon: destination.lon } : undefined,
        controller.signal,
      );
      setBusy('elevation');
      const samples = sampleRoute(result.coords);
      const elevations = await fetchElevations(samples, controller.signal);
      const profile = buildRouteProfile(samples, elevations, flatPace);
      const climb: number[] = [];
      const descent: number[] = [];
      for (let index = 1; index < elevations.length; index++) {
        const diff = elevations[index] - elevations[index - 1];
        if (diff > 0) climb.push(diff);
        else descent.push(Math.abs(diff));
      }
      const created: GeneratedRoute = {
        coords: result.coords,
        steps: result.steps,
        profile,
        distanceKm: profile.at(-1)?.km || result.distance / 1000,
        ascent: climb.reduce((sum, value) => sum + value, 0),
        descent: descent.reduce((sum, value) => sum + value, 0),
        id: Date.now(),
      };
      setRouteData(created);
      setElapsed(0);
      elapsedRef.current = 0;
      setSpeed(1);
      setError('');
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError(reason instanceof Error ? reason.message : 'No se pudo calcular la ruta.');
    } finally {
      setBusy(null);
    }
  }

  function locateMe() {
    setGpsError('');
    if (!navigator.geolocation) {
      setGpsError('Este navegador no ofrece geolocalización. Busca tu punto de salida manualmente.');
      return;
    }
    setGpsBusy(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude: lat, longitude: lon } = position.coords;
        setStart({ lat, lon, label: `Mi ubicación · ${lat.toFixed(4)}, ${lon.toFixed(4)}` });
        setGpsBusy(false);
      },
      (positionError) => {
        const reason = positionError.code === positionError.PERMISSION_DENIED ? 'Permiso denegado. Puedes buscar una dirección manualmente.' : positionError.code === positionError.POSITION_UNAVAILABLE ? 'No se pudo determinar la ubicación. Inténtalo de nuevo.' : 'La geolocalización tardó demasiado. Inténtalo de nuevo.';
        setGpsError(reason);
        setGpsBusy(false);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
    );
  }

  function toggleRun() {
    if (!routeData) return;
    if (elapsed >= totalSeconds) {
      setElapsed(0);
      elapsedRef.current = 0;
      alertIndexRef.current = 0;
    }
    setRunning((previous) => !previous);
  }

  function resetSimulation() {
    setRunning(false);
    setElapsed(0);
    elapsedRef.current = 0;
    alertIndexRef.current = 0;
    setHydrationNotice(null);
    setSpeed(1);
  }

  function toggleSoundAlert() {
    const next = !soundAlert;
    if (next) {
      try {
        const AudioContextClass = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AudioContextClass) {
          if (!audioRef.current) audioRef.current = new AudioContextClass();
          void audioRef.current.resume();
        }
      } catch { /* Audio remains optional. */ }
    }
    setSoundAlert(next);
  }

  const waterLiters = hydration ? (hydration.stops.length * (hydration.mlLow + hydration.mlHigh) / 2 / 1000) : 0;
  const representativePace = currentPoint ? formatPace(currentPoint.point.paceMinKm) : (flatPace ? formatPace(flatPace) : '—');
  const currentGrade = currentPoint ? currentPoint.point.grade : 0;

  return (
    <main className="planner-shell">
      <header className="topbar">
        <div className="brand-lockup" aria-label="Paso, planificador de rutas">
          <span className="brand-mark"><Footprints size={20} strokeWidth={2.3} /></span>
          <span className="brand-name">paso<span>.</span></span>
          <span className="brand-divider" />
          <span className="brand-caption">PLANIFICADOR DE CARRERA</span>
        </div>
        <div className="topbar-right"><span className="service-indicator"><i /> DATOS ABIERTOS</span><span className="topbar-date">HECHO PARA SALIR</span></div>
      </header>

      <section className="intro-row">
        <div>
          <p className="eyebrow"><span>01</span> DISEÑA TU PRÓXIMA SALIDA</p>
          <h1>Corre con <em>un plan.</em></h1>
          <p className="intro-copy">Una buena ruta se piensa antes de atarse las zapatillas.</p>
        </div>
        <div className="intro-aside"><span className="intro-aside-kicker">RUTAS A PIE</span><span>El terreno cambia.<br /><strong>Tu ritmo también.</strong></span></div>
      </section>

      <div className="workspace">
        <aside className="planner-card">
          <div className="card-heading">
            <div><span className="section-index">A / TU RECORRIDO</span><h2>Traza el camino</h2></div>
            <span className="card-icon"><RouteIcon size={19} /></span>
          </div>
          <form onSubmit={generateRoute} noValidate>
            <LocationSearch label="Punto de salida" placeholder="Calle, barrio o ciudad" value={start} onChange={setStart} onGps={locateMe} gpsBusy={gpsBusy} testId="input-start-location" />
            {gpsError && <p className="inline-message error-message" role="status" data-testid="status-geolocation">{gpsError}</p>}

            <div className="route-mode-label"><span className="field-label">Tipo de ruta</span><span className="mode-note">{routeKind === 'loop' ? 'Salida y vuelta al mismo punto' : 'Punto a punto'}</span></div>
            <div className="segmented-control" role="radiogroup" aria-label="Tipo de ruta">
              <button type="button" role="radio" aria-checked={routeKind === 'loop'} className={routeKind === 'loop' ? 'segment selected' : 'segment'} onClick={() => setRouteKind('loop')} data-testid="button-route-loop"><RouteIcon size={15} /> Circular</button>
              <button type="button" role="radio" aria-checked={routeKind === 'destination'} className={routeKind === 'destination' ? 'segment selected' : 'segment'} onClick={() => setRouteKind('destination')} data-testid="button-route-destination"><MapPin size={15} /> Con destino</button>
            </div>
            {routeKind === 'destination' && <div className="destination-field fade-up"><LocationSearch label="Destino" placeholder="¿Hasta dónde?" value={destination} onChange={setDestination} testId="input-destination" /><p className="destination-hint">El camino termina en el destino; la distancia final puede variar.</p></div>}

            <div className="field-divider" />
            <div className="field-label-row"><label className="field-label" htmlFor="distance-input">Distancia objetivo</label><span className="range-hint">0,5—42 km</span></div>
            <div className="number-field">
              <input id="distance-input" data-testid="input-distance" type="number" min="0.5" max="42" step="0.5" value={distance} onChange={(event) => setDistance(event.target.value)} />
              <span>km</span>
            </div>

            <div className="two-fields">
              <div>
                <label className="field-label" htmlFor="weight-input"><Weight size={14} /> Peso</label>
                <div className="compact-number"><input id="weight-input" data-testid="input-weight" type="number" min="30" max="200" value={weight} onChange={(event) => setWeight(event.target.value)} /><span>kg</span></div>
              </div>
              <div>
                <label className="field-label" htmlFor="temp-input"><Thermometer size={14} /> Temperatura</label>
                <div className="compact-number"><input id="temp-input" data-testid="input-temperature" type="number" min="-10" max="50" value={temperature} onChange={(event) => setTemperature(event.target.value)} /><span>°C</span></div>
              </div>
            </div>

            <div className="field-divider" />
            <div className="field-label-row"><label className="field-label" htmlFor="pace-input">Ritmo en llano</label><span className="range-hint">min / km</span></div>
            <div className="pace-input-wrap"><Gauge size={16} /><input id="pace-input" data-testid="input-flat-pace" inputMode="numeric" aria-label="Ritmo en llano, minutos y segundos por kilómetro" value={paceInput} onChange={(event) => setPaceInput(event.target.value)} /><span className="pace-format">MM:SS</span></div>

            {error && <div className="form-error" role="alert" data-testid="status-route-error"><AlertCircle size={17} /><span>{error}</span></div>}
            <button className="build-button" type="submit" disabled={!!busy} data-testid="button-generate-route">
              {busy ? <><span className="button-loader" />{busy === 'route' ? 'Buscando camino peatonal…' : 'Calculando desnivel…'}</> : <><span>{routeData ? 'Actualizar mi ruta' : 'Calcular mi ruta'}</span><span className="button-arrow">↗</span></>}
            </button>
            <p className="route-source-note"><span className="source-dot" /> Se buscan caminos peatonales reales, no líneas rectas.</p>
          </form>
          <div className="panel-footnote"><span className="footnote-mark">i</span><span>Tu ubicación solo se usa para calcular esta ruta. No se guarda.</span></div>
        </aside>

        <section className="route-stage" aria-label="Vista y análisis de ruta">
          <div className="map-section">
            <div className="map-titlebar">
              <div><span className="section-index">B / VISTA DE RUTA</span><h2>{routeData ? routeKind === 'loop' ? 'Tu vuelta está lista' : 'Tu recorrido está listo' : 'Un buen camino, por delante'}</h2></div>
              {routeData && <div className="route-total"><strong data-testid="value-route-distance">{routeData.distanceKm.toFixed(2)}</strong><span>KM</span></div>}
            </div>
            <RouteMap start={start} route={routeData?.coords || null} steps={routeData?.steps || []} profile={routeData?.profile || []} hydrationSeconds={hydration?.stops || []} elapsed={elapsed} mapId={String(routeData?.id || 'empty')} />
            {busy && <div className="route-loading" role="status" data-testid="status-route-loading"><span className="route-loading-glyph" /><span>{busy === 'route' ? 'Encontrando un itinerario peatonal…' : 'Leyendo el perfil de altitud…'}</span></div>}
            <div className="map-footer">
              <div className="map-caption"><span className="tiny-compass">N</span><span>{routeData ? routeKind === 'loop' ? 'Inicio y final en el mismo punto' : `Destino: ${destination?.label.split(',').slice(0, 2).join(',') || 'seleccionado'}` : 'Mapas © OpenStreetMap contributors'}</span></div>
              {routeData && <div className="map-distance">{routeData.distanceKm.toFixed(1)} km <span>·</span> camino a pie</div>}
            </div>
          </div>

          <section className="analysis-panel" aria-label="Análisis de elevación">
            <div className="analysis-head">
              <div><span className="section-index">C / TERRENO</span><h2>El perfil del camino</h2></div>
              {routeData ? <div className="elevation-totals"><span><ArrowUpRight size={14} /> <strong data-testid="value-ascent">{Math.round(routeData.ascent)} m</strong> subida</span><span><ArrowDownRight size={14} /> <strong data-testid="value-descent">{Math.round(routeData.descent)} m</strong> bajada</span></div> : <span className="chart-pending">PENDIENTE DE RUTA</span>}
            </div>
            {busy === 'elevation' && !routeData && <div className="chart-loading"><span /><span /><span /><span /><span /><small>Calculando elevaciones reales…</small></div>}
            {routeData ? <ElevationProfile points={routeData.profile} currentKm={currentKm} /> : <ElevationProfile points={[]} currentKm={0} />}
            {routeData && <div className="grade-note"><Mountain size={14} /><span>El ritmo se ajusta a cada tramo: cuesta arriba y cuesta abajo.</span></div>}
          </section>

          <section className="simulation-panel" aria-label="Simulador de carrera">
            <div className="simulation-header">
              <div><span className="section-index">D / SIMULACIÓN</span><h2>Ensaya tu ritmo</h2></div>
              {routeData && <span className={`run-state ${running ? 'is-running' : elapsed >= totalSeconds && elapsed > 0 ? 'is-done' : ''}`} data-testid="status-simulation">
                <i /> {running ? 'EN MARCHA' : elapsed >= totalSeconds && elapsed > 0 ? 'COMPLETADA' : elapsed > 0 ? 'EN PAUSA' : 'LISTA'}
              </span>}
            </div>
            {!routeData ? (
              <div className="simulation-empty"><span className="empty-clock"><Clock3 size={19} /></span><div><strong>Primero, dibuja la ruta.</strong><p>Después podrás recorrerla a tu ritmo y ver cómo cambia el paso en cada pendiente.</p></div></div>
            ) : (
              <>
                <div className="sim-readouts">
                  <div className="sim-primary"><span>Distancia recorrida</span><strong data-testid="value-distance-covered">{currentKm.toFixed(2)}<small> km</small></strong><div className="progress-track"><i style={{ width: `${progress}%` }} /></div><div className="progress-labels"><span>0 km</span><span>{routeData.distanceKm.toFixed(1)} km</span></div></div>
                  <div className="sim-value"><span>TIEMPO</span><strong className="mono" data-testid="value-elapsed-time">{formatDuration(elapsed)}</strong><small>de <span data-testid="value-total-time">{formatDuration(totalSeconds)}</span></small></div>
                  <div className="sim-value"><span>RITMO AHORA</span><strong className="mono" data-testid="value-current-pace">{representativePace}<small> /km</small></strong><small data-testid="value-current-slope">{currentGrade > .1 ? `+${currentGrade.toFixed(1)}% subida` : currentGrade < -.1 ? `${currentGrade.toFixed(1)}% bajada` : 'terreno llano'}</small></div>
                </div>
                <div className="simulation-controls">
                  <div className="play-controls">
                    <button type="button" className="play-button" onClick={toggleRun} aria-label={running ? 'Pausar simulación' : elapsed > 0 && elapsed < totalSeconds ? 'Reanudar simulación' : 'Iniciar simulación'} data-testid="button-simulation-toggle">
                      {running ? <Pause size={18} fill="currentColor" /> : <Play size={17} fill="currentColor" />}<span>{running ? 'Pausar' : elapsed > 0 && elapsed < totalSeconds ? 'Continuar' : 'Iniciar'}</span>
                    </button>
                    <button type="button" className="reset-button" onClick={resetSimulation} disabled={elapsed === 0 && !running} aria-label="Reiniciar simulación" data-testid="button-simulation-reset"><RotateCcw size={16} /></button>
                  </div>
                  <div className="speed-control" aria-label="Velocidad de simulación">
                    <span>VELOCIDAD</span>
                    {[1, 2, 5, 10].map((value) => <button key={value} type="button" aria-pressed={speed === value} className={speed === value ? 'speed-option active' : 'speed-option'} onClick={() => setSpeed(value)} data-testid={`button-speed-${value}`}>{value}×</button>)}
                  </div>
                  <button type="button" className={`sound-toggle ${soundAlert ? 'sound-on' : ''}`} aria-pressed={soundAlert} onClick={toggleSoundAlert} data-testid="button-sound-alert">
                    {soundAlert ? <Volume2 size={15} /> : <VolumeX size={15} />}<span>{soundAlert ? 'Sonido activado' : 'Aviso sonoro'}</span>
                  </button>
                </div>
                {hydrationNotice !== null && <div className="hydration-toast" role="status" data-testid="status-hydration-alert"><span className="drop-icon"><Droplets size={17} /></span><span><strong>Momento de hidratarte</strong><small>Parada {hydrationNotice} · un sorbo y sigue con calma</small></span><Check size={17} /></div>}
              </>
            )}
          </section>

          <section className="hydration-panel" aria-label="Plan de hidratación">
            <div className="hydration-icon"><Droplets size={20} /></div>
            <div className="hydration-copy">
              <span className="section-index">E / HIDRATACIÓN</span>
              <h2>Agua para el camino</h2>
              {hydration ? (
                <p data-testid="text-hydration-guidance">Cada <strong>{hydration.intervalMin} min</strong>, toma <strong>{hydration.mlLow}–{hydration.mlHigh} ml</strong>. Estimación de sudor: <strong>{hydration.sweatLHour.toFixed(2)} L/h</strong>.</p>
              ) : (
                <p>Calculamos un recordatorio a partir de tu peso, el calor y el tiempo estimado de carrera.</p>
              )}
              <span className="hydration-caveat">Orientativo: la hidratación varía según la persona y las condiciones.</span>
            </div>
            <div className="water-estimate"><span>AGUA EN RUTA</span><strong data-testid="value-water-estimate">{hydration ? `${waterLiters.toFixed(2)} L` : '—'}</strong><small>{hydration ? `${hydration.stops.length} ${hydration.stops.length === 1 ? 'parada prevista' : 'paradas previstas'}` : 'según duración'}</small></div>
          </section>
          <footer className="page-footer"><span><Activity size={13} /> Una estimación para salir mejor preparado.</span><span>Rutas a pie · Altitud <a data-testid="link-open-meteo-attribution" href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a> · OpenStreetMap</span></footer>
        </section>
      </div>
    </main>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;