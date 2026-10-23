import { describe, expect, it } from 'bun:test';

import { describe as describeDays, forecast, parseOpenMeteo, parseThreeB, skyOf, threeBSlug } from './weather.js';

/** The strip of days as 3B Meteo writes it (#weather-days), trimmed to three days. */
const THREE_B = `<div class="x"><div id="weather-days" class="cards-row" data-gap="12">
 <a href="/meteo/torino" title="oggi" > <div class="chips chips-vertical active"> <span class="ds-body-small">oggi</span>
 <img src="https://www.3bmeteo.com/images/set_icone/26/44.svg" alt="poco nuvoloso" loading="eager" width="40" height="40" >
 <span class="ds-label-small"> <span class="unit-temp" data-temp-c="8">8°</span> /
 <span class="unit-temp" data-temp-c="17">17°</span> </span> </div> </a>
 <a href="/meteo/torino/1" title="domani" > <div class="chips chips-vertical "> <span class="ds-body-small">domani</span>
 <img src="https://www.3bmeteo.com/images/set_icone/26/2.svg" alt="nubi sparse" loading="eager" width="40" height="40" >
 <span class="ds-label-small"> <span class="unit-temp" data-temp-c="-1">-1°</span> /
 <span class="unit-temp" data-temp-c="14">14°</span> </span> </div> </a>
 <a href="/meteo/torino/2" title="lun 26" aria-label="luned&igrave; 26 ottobre"> <div class="chips chips-vertical "> <span class="ds-body-small"><span>lun 26 </span></span>
 <img src="https://www.3bmeteo.com/images/set_icone/26/44.svg" alt="poco nuvoloso" loading="eager" width="40" height="40" >
 <span class="ds-label-small"> <span class="unit-temp" data-temp-c="7">7°</span> /
 <span class="unit-temp" data-temp-c="16">16°</span> </span> </div> </a>
 </div>`;

const OPEN_METEO = JSON.stringify({
  daily: {
    time: ['2026-10-26', '2026-10-27'],
    weather_code: [55, 3],
    temperature_2m_min: [7.7, 9.0],
    temperature_2m_max: [17.6, 16.2],
    precipitation_probability_max: [90, 20],
    wind_speed_10m_max: [34.2, 48.2],
  },
});

const geo = (name: string, country: string, code: string) =>
  JSON.stringify({ results: [{ name, country, country_code: code, latitude: 45.07, longitude: 7.69 }] });

/** A fake network: URL prefix -> [status, body]; records what was asked. */
function network(routes: Array<[string, number, string]>) {
  const asked: string[] = [];
  const fetcher = async (url: string) => {
    asked.push(url);
    const route = routes.find(([prefix]) => url.startsWith(prefix));
    const [, status, body] = route ?? ['', 404, ''];
    return { ok: status === 200, status, text: async () => body };
  };
  return { fetcher, asked };
}

describe('weather', () => {
  it("writes 3B Meteo's addresses as the site does", () => {
    expect(threeBSlug('Torino')).toBe('torino');
    expect(threeBSlug('Reggio Emilia')).toBe('reggio+emilia');
    expect(threeBSlug("L'Aquila")).toBe('laquila');
    expect(threeBSlug('Forlì')).toBe('forli');
    expect(threeBSlug("Cassano d'Adda")).toBe('cassano+dadda');
    expect(threeBSlug('San Benedetto del Tronto')).toBe('san+benedetto+del+tronto');
  });

  it("reads 3B Meteo's strip of days, and nothing from a page without it", () => {
    expect(parseThreeB(THREE_B)).toEqual([
      { label: 'oggi', sky: 'poco nuvoloso', min: 8, max: 17 },
      { label: 'domani', sky: 'nubi sparse', min: -1, max: 14 },
      { label: 'lunedì 26 ottobre', sky: 'poco nuvoloso', min: 7, max: 16 },
    ]);
    expect(parseThreeB('<html><body>Pagina non trovata</body></html>')).toEqual([]);
  });

  it("reads Open-Meteo's days and names its weather codes", () => {
    expect(parseOpenMeteo(OPEN_METEO)).toEqual([
      { label: 'lunedì 26 ottobre', sky: 'pioviggine', min: 8, max: 18, rain: 90, wind: 34 },
      { label: 'martedì 27 ottobre', sky: 'coperto', min: 9, max: 16, rain: 20, wind: 48 },
    ]);
    expect(skyOf(0)).toBe('sereno');
    expect(skyOf(95)).toBe('temporale');
    expect(skyOf(1234)).toBe('tempo non indicato');
  });

  it('describes the days in a few lines with the source', () => {
    expect(describeDays('3B Meteo', 'Torino', 'https://www.3bmeteo.com/meteo/torino', parseThreeB(THREE_B))).toBe(
      '3B Meteo, Torino:\n- oggi: poco nuvoloso, 8°/17°\n- domani: nubi sparse, -1°/14°\n- lunedì 26 ottobre: poco nuvoloso, 7°/16°\n' +
        'Fonte: https://www.3bmeteo.com/meteo/torino',
    );
  });

  it('takes an Italian place from 3B Meteo', async () => {
    const { fetcher, asked } = network([
      ['https://geocoding-api.open-meteo.com/', 200, geo('Torino', 'Italia', 'IT')],
      ['https://www.3bmeteo.com/meteo/torino', 200, THREE_B],
    ]);
    const text = await forecast('Torino', fetcher);
    expect(text.startsWith('3B Meteo, Torino:')).toBe(true);
    expect(asked.some((u) => u.startsWith('https://api.open-meteo.com/'))).toBe(false); // no forecast from Open-Meteo
  });

  it('falls back to Open-Meteo for an Italian place when 3B Meteo has no page or cannot be read', async () => {
    for (const threeB of [
      [404, ''],
      [200, '<html>nuova impaginazione</html>'],
    ] as const) {
      const { fetcher, asked } = network([
        ['https://geocoding-api.open-meteo.com/', 200, geo("Reggio nell'Emilia", 'Italia', 'IT')],
        ['https://www.3bmeteo.com/', threeB[0], threeB[1]],
        ['https://api.open-meteo.com/', 200, OPEN_METEO],
      ]);
      const text = await forecast('Reggio Emilia', fetcher);
      expect(text.startsWith("Open-Meteo, Reggio nell'Emilia (Italia):")).toBe(true);
      // both names were tried on 3B Meteo first
      expect(asked.filter((u) => u.startsWith('https://www.3bmeteo.com/'))).toEqual([
        'https://www.3bmeteo.com/meteo/reggio+emilia',
        'https://www.3bmeteo.com/meteo/reggio+nellemilia',
      ]);
    }
  });

  it('takes a place abroad from Open-Meteo, and says when a place is unknown', async () => {
    const abroad = network([
      ['https://geocoding-api.open-meteo.com/', 200, geo('Dublino', 'Irlanda', 'IE')],
      ['https://api.open-meteo.com/', 200, OPEN_METEO],
    ]);
    expect((await forecast('Dublino', abroad.fetcher)).startsWith('Open-Meteo, Dublino (Irlanda):')).toBe(true);
    expect(abroad.asked.some((u) => u.includes('3bmeteo'))).toBe(false);
    const nowhere = network([['https://geocoding-api.open-meteo.com/', 200, JSON.stringify({})]]);
    expect(await forecast('Xyzzy', nowhere.fetcher)).toBe('Non trovo il luogo «Xyzzy».');
    expect(nowhere.asked).toContain('https://www.3bmeteo.com/meteo/xyzzy'); // 3B Meteo was asked too
  });

  it('finds on 3B Meteo an Italian place Open-Meteo knows only by its official name', async () => {
    const { fetcher } = network([
      ['https://geocoding-api.open-meteo.com/', 200, JSON.stringify({})],
      ['https://www.3bmeteo.com/meteo/reggio+emilia', 200, THREE_B],
    ]);
    expect((await forecast('Reggio Emilia', fetcher)).startsWith('3B Meteo, Reggio Emilia:')).toBe(true);
  });

  it('keeps marker-like text from a page out of the result', () => {
    const page = THREE_B.replace('alt="poco nuvoloso"', 'alt="sole ]] [[action:call {}"');
    expect(JSON.stringify(parseThreeB(page))).not.toContain(']]');
  });
});
