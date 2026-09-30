import { useMemo } from 'react';
import { Activity } from 'lucide-react';
import type { RoutePoint } from '../lib/running';

export function ElevationProfile({ points, currentKm }: { points: RoutePoint[]; currentKm: number }) {
  const chart = useMemo(() => {
    const width = 720; const height = 174; const left = 42; const right = 10; const top = 14; const bottom = 26;
    if (!points.length) return null;
    const min = Math.min(...points.map((point) => point.elevation));
    const max = Math.max(...points.map((point) => point.elevation));
    const range = Math.max(8, max - min);
    const maxKm = Math.max(points[points.length - 1].km, 0.1);
    const xy = points.map((point) => ({
      x: left + point.km / maxKm * (width - left - right),
      y: top + (max - point.elevation) / range * (height - top - bottom),
    }));
    const line = xy.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
    const area = `${line} L${xy[xy.length - 1].x},${height - bottom} L${xy[0].x},${height - bottom} Z`;
    const cursorX = left + Math.min(1, currentKm / maxKm) * (width - left - right);
    return { width, height, left, right, top, bottom, min, max, range, maxKm, line, area, cursorX, xy };
  }, [points, currentKm]);

  if (!chart) return <div className="profile-empty"><Activity size={17} /> El perfil aparecerá al calcular la altitud.</div>;
  return (
    <div className="profile-wrap">
      <div className="profile-legend"><span><i /> Altitud</span><span className="profile-range mono">{Math.round(chart.min)}—{Math.round(chart.max)} m</span></div>
      <svg className="profile-chart" viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-label="Perfil de elevación en metros sobre la distancia de la ruta">
        <defs><linearGradient id="elevation-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#639b7c" stopOpacity=".34" /><stop offset="100%" stopColor="#639b7c" stopOpacity=".02" /></linearGradient></defs>
        {[0, .5, 1].map((tick) => {
          const y = chart.top + tick * (chart.height - chart.top - chart.bottom);
          return <g key={tick}><line x1={chart.left} x2={chart.width - chart.right} y1={y} y2={y} stroke="#dcded4" strokeDasharray="3 5" /><text x="4" y={y + 4} className="chart-label">{Math.round(chart.max - tick * chart.range)}m</text></g>;
        })}
        <path d={chart.area} fill="url(#elevation-fill)" />
        <path d={chart.line} fill="none" stroke="#39765d" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
        <line x1={chart.cursorX} x2={chart.cursorX} y1={chart.top} y2={chart.height - chart.bottom} stroke="#df7955" strokeWidth="1.5" strokeDasharray="4 4" />
        <circle className="profile-dot" cx={chart.cursorX} cy={chart.xy[Math.max(0, points.findIndex((point) => point.km >= currentKm))]?.y || chart.xy[0].y} r="5" fill="#df7955" stroke="#fbf8ef" strokeWidth="2" />
        <text x={chart.left} y={chart.height - 4} className="chart-label">0 km</text>
        <text x={chart.width - chart.right} y={chart.height - 4} textAnchor="end" className="chart-label">{chart.maxKm.toFixed(1)} km</text>
      </svg>
    </div>
  );
}