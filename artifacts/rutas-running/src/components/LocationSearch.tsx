import { useEffect, useRef, useState } from 'react';
import { LocateFixed, MapPin, Search, X } from 'lucide-react';
import { searchPlaces, type Place } from '../lib/running';

type Props = {
  label: string;
  placeholder: string;
  value: Place | null;
  onChange: (place: Place | null) => void;
  onGps?: () => void;
  gpsBusy?: boolean;
  testId: string;
};

export function LocationSearch({ label, placeholder, value, onChange, onGps, gpsBusy, testId }: Props) {
  const [query, setQuery] = useState(value?.label || '');
  const [results, setResults] = useState<Place[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (value?.label) setQuery(value.label); }, [value?.label]);
  useEffect(() => {
    if (query.trim().length < 3 || query === value?.label) {
      setResults([]);
      setLoading(false);
      setError('');
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        const found = await searchPlaces(query.trim(), controller.signal);
        setResults(found);
        setOpen(true);
        if (!found.length) setError('Sin coincidencias. Prueba con otro nombre.');
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'No se pudo buscar el lugar.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 900);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, value?.label]);
  useEffect(() => {
    function close(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  function selectPlace(place: Place) {
    setQuery(place.label);
    setResults([]);
    setOpen(false);
    onChange(place);
  }

  return (
    <div className="location-field" ref={rootRef}>
      <label className="field-label" htmlFor={`${testId}-search`}>{label}</label>
      <div className={`location-input-wrap ${open && results.length ? 'is-open' : ''}`}>
        <Search size={16} aria-hidden="true" className="input-icon" />
        <input
          id={`${testId}-search`}
          data-testid={testId}
          type="search"
          autoComplete="off"
          value={query}
          placeholder={placeholder}
          aria-label={label}
          aria-expanded={open && results.length > 0}
          aria-controls={`${testId}-results`}
          onFocus={() => setOpen(true)}
          onChange={(event) => { setQuery(event.target.value); onChange(null); setOpen(true); }}
        />
        {query && <button className="input-clear" type="button" aria-label="Borrar ubicación" data-testid={`${testId}-clear`} onClick={() => { setQuery(''); onChange(null); setResults([]); }}><X size={15} /></button>}
        {onGps && (
          <button className={`gps-button ${gpsBusy ? 'is-busy' : ''}`} type="button" onClick={onGps} disabled={gpsBusy} aria-label="Usar mi ubicación actual" data-testid="button-geolocation">
            <LocateFixed size={16} /><span>{gpsBusy ? 'Localizando' : 'Mi ubicación'}</span>
          </button>
        )}
        {open && (loading || results.length > 0 || error) && (
          <div className="suggestions" id={`${testId}-results`} role="listbox" aria-label={`Resultados de ${label}`}>
            {loading && <div className="suggestion-status" role="status">Buscando lugares…</div>}
            {!loading && results.map((place, index) => (
              <button type="button" role="option" aria-selected={value?.label === place.label} className="suggestion" key={`${place.lat}-${place.lon}`} onClick={() => selectPlace(place)} data-testid={`${testId}-option-${index}`}>
                <span className="suggestion-pin"><MapPin size={15} /></span>
                <span>{place.label}</span>
              </button>
            ))}
            {!loading && error && <div className={`suggestion-status ${error.startsWith('Sin') ? '' : 'error'}`} role="status">{error}</div>}
            <div className="suggestion-attribution">Búsqueda por OpenStreetMap · Nominatim</div>
          </div>
        )}
      </div>
      {value && <p className="location-coordinates mono" data-testid={`${testId}-coordinates`}>{value.lat.toFixed(5)}° · {value.lon.toFixed(5)}°</p>}
    </div>
  );
}