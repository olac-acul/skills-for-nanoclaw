/**
 * The weather for the voice app: one tool call instead of a web search and several reads of a page too large to fit.
 * Italian places come from 3B Meteo's page (its high-resolution local forecast), read for its strip of days; places
 * abroad, and Italian ones whenever 3B Meteo does not answer or its page cannot be read, come from Open-Meteo's free
 * API. Open-Meteo's geocoding also says which country a place is in. The result is a few short lines with the source.
 */
import type { McpToolDefinition } from './types.js';

const USER_AGENT = 'Mozilla/5.0 (compatible; NanoClaw voice assistant)';
const TIMEOUT_MS = 8_000;
const MAX_DAYS = 7;

export interface Place {
  name: string;
  country: string;
  countryCode: string;
  latitude: number;
  longitude: number;
}

export interface Day {
  /** "oggi", "domani" or "lunedì 26 ottobre". */
  label: string;
  sky: string;
  min: number;
  max: number;
  /** Open-Meteo only. */
  rain?: number;
  wind?: number;
}

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * No redirects: 3B Meteo could send an unknown name to another page that still has a strip of days, whose forecast
 * would then be given for the place asked. A redirect is "no page" (the next name, then Open-Meteo).
 */
const get: Fetch = (url) =>
  fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });

/** 3B Meteo's address for a place: lower case, no accents or apostrophes, "+" between words ("cassano+dadda"). */
export function threeBSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Mn}+/gu, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, '+')
    .replace(/^\++|\++$/g, '');
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  agrave: 'à',
  egrave: 'è',
  eacute: 'é',
  igrave: 'ì',
  ograve: 'ò',
  ugrave: 'ù',
};
const decode = (text: string) =>
  text.replace(/&(#\d+|[a-z]+);/gi, (m, e: string) =>
    e.startsWith('#') ? String.fromCodePoint(Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m),
  );
/** Text from a page or an API: one short line, nothing that looks like the channel's markers. */
const clean = (text: string, max = 60) =>
  decode(text)
    .replace(/[\[\]<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** The strip of days of a 3B Meteo page (#weather-days): label, sky, min and max for each; empty when it is not there. */
export function parseThreeB(html: string): Day[] {
  const start = html.indexOf('id="weather-days"');
  if (start < 0) return [];
  const strip = html.slice(start, start + 20_000);
  const days: Day[] = [];
  for (const m of strip.matchAll(
    /<a href="\/meteo\/[^"]*" title="([^"]+)"(?: aria-label="([^"]+)")?\s*>([\s\S]*?)<\/a>/g,
  )) {
    const sky = m[3].match(/<img [^>]*alt="([^"]+)"/);
    const temps = [...m[3].matchAll(/data-temp-c="(-?\d+)"/g)].map((t) => Number(t[1]));
    if (!sky || temps.length < 2) break;
    days.push({ label: clean(m[2] ?? m[1]), sky: clean(sky[1]), min: temps[0], max: temps[1] });
    if (days.length === MAX_DAYS) break;
  }
  return days;
}

/** WMO weather codes as Open-Meteo gives them. */
const WMO: Array<[number[], string]> = [
  [[0], 'sereno'],
  [[1], 'poco nuvoloso'],
  [[2], 'nubi sparse'],
  [[3], 'coperto'],
  [[45, 48], 'nebbia'],
  [[51, 53, 55], 'pioviggine'],
  [[56, 57], 'pioviggine gelata'],
  [[61, 63], 'pioggia'],
  [[65], 'pioggia forte'],
  [[66, 67], 'pioggia gelata'],
  [[71, 73, 75, 77], 'neve'],
  [[80, 81], 'rovesci'],
  [[82], 'rovesci forti'],
  [[85, 86], 'rovesci di neve'],
  [[95], 'temporale'],
  [[96, 99], 'temporale con grandine'],
];
export const skyOf = (code: number) => WMO.find(([codes]) => codes.includes(code))?.[1] ?? 'tempo non indicato';

const dayLabel = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('it-IT', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });

/** Open-Meteo's daily forecast: an object of arrays, one entry per day. */
export function parseOpenMeteo(body: string): Day[] {
  const daily = (JSON.parse(body) as { daily?: Record<string, unknown[]> }).daily;
  if (!daily || !Array.isArray(daily.time)) return [];
  const at = (key: string, i: number) => (Array.isArray(daily[key]) ? (daily[key][i] as number | null) : null);
  return daily.time.slice(0, MAX_DAYS).map((iso, i) => ({
    label: dayLabel(String(iso)),
    sky: skyOf(Number(at('weather_code', i))),
    min: Math.round(Number(at('temperature_2m_min', i))),
    max: Math.round(Number(at('temperature_2m_max', i))),
    rain: at('precipitation_probability_max', i) ?? undefined,
    wind: Math.round(Number(at('wind_speed_10m_max', i))),
  }));
}

export function describe(source: string, place: string, link: string, days: Day[]): string {
  const lines = days.map((d) => {
    const extra = [d.rain !== undefined ? `pioggia ${d.rain}%` : '', d.wind ? `vento fino a ${d.wind} km/h` : '']
      .filter(Boolean)
      .join(', ');
    return `- ${d.label}: ${d.sky}, ${d.min}°/${d.max}°${extra ? `, ${extra}` : ''}`;
  });
  return `${source}, ${place}:\n${lines.join('\n')}\nFonte: ${link}`;
}

export async function findPlace(name: string, fetcher: Fetch = get): Promise<Place | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=it&format=json`;
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`Open-Meteo geocoding answered ${res.status}`);
  const first = (JSON.parse(await res.text()) as { results?: Array<Record<string, unknown>> }).results?.[0];
  if (!first) return null;
  return {
    name: clean(String(first.name ?? name)),
    country: clean(String(first.country ?? '')),
    countryCode: String(first.country_code ?? ''),
    latitude: Number(first.latitude),
    longitude: Number(first.longitude),
  };
}

/** 3B Meteo for an Italian place, trying the name as said and then the official one; null when neither page reads. */
export async function threeB(said: string, place: Place, fetcher: Fetch = get): Promise<string | null> {
  for (const slug of [...new Set([threeBSlug(said), threeBSlug(place.name)])]) {
    if (!slug) continue;
    const link = `https://www.3bmeteo.com/meteo/${slug}`;
    try {
      const res = await fetcher(link);
      if (!res.ok) continue;
      const days = parseThreeB(await res.text());
      if (days.length > 0) return describe('3B Meteo', place.name, link, days);
    } catch {
      // unreachable or too slow: the next name, then Open-Meteo
    }
  }
  return null;
}

export async function openMeteo(place: Place, fetcher: Fetch = get): Promise<string> {
  const fields = 'weather_code,temperature_2m_min,temperature_2m_max,precipitation_probability_max,wind_speed_10m_max';
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
    `&daily=${fields}&timezone=auto&forecast_days=${MAX_DAYS}`;
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`Open-Meteo answered ${res.status}`);
  const days = parseOpenMeteo(await res.text());
  if (days.length === 0) throw new Error('Open-Meteo gave no days');
  const where = place.country ? `${place.name} (${place.country})` : place.name;
  return describe('Open-Meteo', where, 'https://open-meteo.com', days);
}

export async function forecast(said: string, fetcher: Fetch = get): Promise<string> {
  const place = await findPlace(said, fetcher);
  if (!place) {
    // Open-Meteo knows some Italian places only by their official name ("Reggio nell'Emilia"): 3B Meteo by the usual one.
    const local = await threeB(
      said,
      { name: clean(said), country: 'Italia', countryCode: 'IT', latitude: 0, longitude: 0 },
      fetcher,
    );
    return local ?? `Non trovo il luogo «${clean(said)}».`;
  }
  if (place.countryCode === 'IT') {
    const local = await threeB(said, place, fetcher);
    if (local) return local;
  }
  return openMeteo(place, fetcher);
}

export const weatherForecast: McpToolDefinition = {
  tool: {
    name: 'weather_forecast',
    description:
      'The weather of the next 7 days for a place (Italian places from 3B Meteo, others from Open-Meteo): sky, minimum ' +
      'and maximum each day, and the source link. Use it for every weather question instead of a web search; it is ' +
      'quick, so no voice_working. Pick the days asked for from the result and say the source.',
    inputSchema: {
      type: 'object' as const,
      properties: { place: { type: 'string', maxLength: 80, description: 'City or town, as the person said it.' } },
      required: ['place'],
    },
  },
  async handler(args) {
    const place = typeof args.place === 'string' ? args.place.trim() : '';
    if (!place || place.length > 80)
      return { content: [{ type: 'text', text: 'place must be a city or town name' }], isError: true };
    try {
      return { content: [{ type: 'text', text: await forecast(place) }] };
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `the weather services did not answer (${why}): say so, or search the web` }],
        isError: true,
      };
    }
  },
};
