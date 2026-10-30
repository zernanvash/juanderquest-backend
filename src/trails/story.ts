import type { TrailNode, TrailSolution } from './types.js';

export function templateTrailStory(theme: string, nodes: TrailNode[], solution: TrailSolution, municipalities: string[]) {
  const names = municipalities.length ? municipalities.join(' and ') : 'Pangasinan';
  const hours = Math.max(1, Math.round(solution.totalMin / 60));
  const cleanTheme = theme.trim().replace(/[<>]/g, '').slice(0, 50) || 'Local discoveries';
  const title = `${cleanTheme} in ${names}`.slice(0, 80);
  const intro = `${cleanTheme} through ${names}: ${solution.stops.length} stops, about ${hours} ${hours === 1 ? 'hour' : 'hours'}. Follow the ordered route and take time to enjoy each place.`.slice(0, 400);
  const byId = new Map(nodes.map(n => [n.spotId, n]));
  return {
    source: 'template', intro,
    stops: solution.stops.map(stop => ({ spot_id: stop.spotId, narration: (byId.get(stop.spotId)?.description ?? '').trim().slice(0, 280) })),
  };
}
