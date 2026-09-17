/** Display helpers shared by every surface. Russian copy, metric units. */

export function formatDistance(meters: number | null | undefined): string {
  if (meters == null || !Number.isFinite(meters)) return '—';
  if (meters < 1000) return `${Math.round(meters)} м`;
  return `${(meters / 1000).toFixed(2).replace(/\.?0+$/, '')} км`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const total = Math.max(1, Math.round(seconds / 60));
  if (total < 60) return `${total} мин`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

export function formatPoints(points: number | null | undefined): string {
  if (points == null || !Number.isFinite(points)) return '—';
  return points.toLocaleString('ru-RU');
}

export function formatCountdown(msLeft: number): string {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}:${String(rem).padStart(2, '0')}` : `${rem} с`;
}

/** Decode a Mapbox `polyline6` string into [lng, lat] pairs for GeoJSON. */
export function decodePolyline6(encoded: string): [number, number][] {
  const factor = 1e6;
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push([lng / factor, lat / factor]);
  }
  return coords;
}

export function routeToGeoJson(encoded: string | null | undefined): GeoJSON.Feature<GeoJSON.LineString> {
  const coordinates = encoded ? decodePolyline6(encoded) : [];
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } };
}

/** Human label for a raw Mapbox POI class, falling back to a tidy title case. */
const CATEGORY_LABELS: Record<string, string> = {
  restaurant: 'Ресторан',
  food_and_drink: 'Еда и напитки',
  food: 'Еда',
  bar: 'Бар',
  cafe: 'Кафе',
  shopping: 'Шопинг',
  shop: 'Магазин',
  mall: 'Торговый центр',
  grocery: 'Продукты',
  lodging: 'Отель',
  hotel: 'Отель',
  beach: 'Пляж',
  park: 'Парк',
  attraction: 'Достопримечательность',
  tourism: 'Туризм',
  landmark: 'Достопримечательность',
  museum: 'Музей',
  nightlife: 'Ночная жизнь',
  fitness: 'Спорт',
  medical: 'Медицина',
  place: 'Место',
  address: 'Адрес',
};

export function categoryLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = raw.toLowerCase().trim();
  if (CATEGORY_LABELS[key]) return CATEGORY_LABELS[key];
  const first = key.split(/[,;]/)[0]?.trim();
  if (first && CATEGORY_LABELS[first]) return CATEGORY_LABELS[first];
  if (!first) return null;
  return first.replace(/_/g, ' ').replace(/^\p{Ll}/u, (c) => c.toUpperCase());
}

export function bearingToCardinal(deg: number | null | undefined): string {
  if (deg == null || !Number.isFinite(deg)) return '';
  const dirs = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8] ?? '';
}
