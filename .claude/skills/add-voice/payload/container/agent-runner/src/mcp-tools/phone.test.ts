import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { setCurrentReplyRoute } from '../db/session-state.js';
import { askUserQuestion, sendCard } from './interactive.js';
import {
  phoneBattery,
  phoneCalendarDraft,
  phoneCalendarRead,
  phoneCalendarUpdate,
  phoneCalendarDelete,
  phoneConfirm,
  phoneLocation,
  phoneNotifications,
  phoneNote,
  phonePlayMusic,
  phoneSignalDraft,
  phoneCall,
  phoneFlashlight,
  phoneProduct,
  phoneIdentifyPlant,
  phoneImageSearch,
  phoneMedia,
  phoneNavigate,
  phoneOpenApp,
  phoneOpenUrl,
  phoneSetAlarm,
  phoneSetTimer,
  phoneSmsDraft,
  phoneSnoozeAlarm,
  phoneStopAlarm,
  phoneStopTimer,
  phoneVolume,
  voiceWorking,
  inVoiceSession,
} from './phone.js';

function seedVoiceDestination(): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('voice', 'Voice', 'channel', 'voice', 'voice:default', NULL)`,
    )
    .run();
}

/** The outbound content as the old marker text, so expectations read as they always did. */
function asMarkers(content: string): string {
  const c = JSON.parse(content) as {
    text: string;
    voice_action?: { name: string; args: unknown };
    voice_working?: boolean;
  };
  const lead = `${c.text}${c.voice_working ? (c.text ? ' [[working]]' : '[[working]]') : ''}`;
  if (!c.voice_action) return lead;
  const marker = `[[action:${c.voice_action.name} ${JSON.stringify(c.voice_action.args)}]]`;
  return lead ? `${lead}\n${marker}` : marker;
}

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

describe('phone_set_timer MCP tool', () => {
  it('queues a set_timer action marker for the voice channel', async () => {
    seedVoiceDestination();

    const result = await phoneSetTimer.handler({ seconds: 180 });

    expect(result.isError).toBeUndefined();
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('voice');
    expect(out[0].platform_id).toBe('voice:default');
    expect(asMarkers(out[0].content)).toBe('[[action:set_timer {"seconds":180}]]');
  });

  it('fails without a wired voice channel and writes nothing', async () => {
    const result = await phoneSetTimer.handler({ seconds: 60 });

    expect(result.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('rejects invalid durations', async () => {
    seedVoiceDestination();

    for (const seconds of [0, -5, 1.5, 86_401, '60', undefined]) {
      const result = await phoneSetTimer.handler({ seconds });
      expect(result.isError).toBe(true);
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

describe('phone_set_alarm MCP tool', () => {
  it('queues a set_alarm marker with minute 0 and tomorrow false by default', async () => {
    seedVoiceDestination();
    const result = await phoneSetAlarm.handler({ hour: 7 });
    expect(result.isError).toBeUndefined();
    expect(asMarkers(getUndeliveredMessages()[0].content)).toBe(
      '[[action:set_alarm {"hour":7,"minute":0,"tomorrow":false}]]',
    );
  });

  it('passes minute and tomorrow through', async () => {
    seedVoiceDestination();
    await phoneSetAlarm.handler({ hour: 6, minute: 45, tomorrow: true });
    expect(asMarkers(getUndeliveredMessages()[0].content)).toBe(
      '[[action:set_alarm {"hour":6,"minute":45,"tomorrow":true}]]',
    );
  });

  it('rejects invalid times and writes nothing', async () => {
    seedVoiceDestination();
    for (const args of [
      { hour: 24 },
      { hour: -1 },
      { hour: 7, minute: 60 },
      { hour: 7.5 },
      { minute: 5 },
      { hour: '7' },
    ]) {
      expect((await phoneSetAlarm.handler(args)).isError).toBe(true);
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

describe('phone_open_app and phone_call MCP tools', () => {
  it('queue open_app and call markers', async () => {
    seedVoiceDestination();
    await phoneOpenApp.handler({ name: ' Signal ' });
    await phoneCall.handler({ target: 'Mario Rossi' });
    const texts = getUndeliveredMessages().map((m) => asMarkers(m.content));
    expect(texts).toEqual(['[[action:open_app {"name":"Signal"}]]', '[[action:call {"target":"Mario Rossi"}]]']);
  });

  it('refuse names that could break the marker', async () => {
    seedVoiceDestination();
    for (const bad of ['', '   ', 'a]]b', 'x{y}', 'line\nbreak', 'x'.repeat(61), 5, undefined]) {
      expect((await phoneOpenApp.handler({ name: bad })).isError).toBe(true);
      expect((await phoneCall.handler({ target: bad })).isError).toBe(true);
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('fail without a voice channel', async () => {
    expect((await phoneOpenApp.handler({ name: 'Signal' })).isError).toBe(true);
    expect((await phoneCall.handler({ target: 'Mario' })).isError).toBe(true);
    expect((await phoneSetAlarm.handler({ hour: 7 })).isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

describe('voice_working MCP tool', () => {
  it('queues the line with the working marker, default text included', async () => {
    seedVoiceDestination();
    const result = await voiceWorking.handler({});
    await voiceWorking.handler({ text: 'Controllo' });
    // The answer must come in the final <message> block: one sent with send_message leaves the turn ending with
    // unwrapped text, which the runner sends back, and the model answers it with a second "Fatto" message.
    expect((result.content[0] as { text: string }).text).toContain('Do not send the answer with send_message');
    const texts = getUndeliveredMessages().map((m) => asMarkers(m.content));
    expect(texts).toEqual(['Cerco sul Web... [[working]]', 'Controllo [[working]]']);
  });

  it('refuses bad text and a missing voice channel', async () => {
    expect((await voiceWorking.handler({ text: 'a]]b' })).isError).toBe(true);
    expect((await voiceWorking.handler({})).isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

describe('voice-only phone tools', () => {
  const fromVoice = () =>
    setCurrentReplyRoute({ inReplyTo: 'm1', channelType: 'voice', platformId: 'voice:default', threadId: null });
  const texts = () => getUndeliveredMessages().map((m) => asMarkers(m.content));

  it('queue their actions when the request comes from the app', async () => {
    seedVoiceDestination();
    fromVoice();
    for (const [tool, args] of [
      [phoneMedia, { command: 'next' }],
      [phoneVolume, { percent: 40 }],
      [phoneVolume, { change: 'mute' }],
      [phoneFlashlight, { on: true }],
      [phoneNavigate, { destination: 'Piazza Castello, Torino' }],
      [phoneOpenUrl, { url: 'https://example.org/a?b=1' }],
      [phoneSmsDraft, { to: 'Mario', text: 'Arrivo tra dieci minuti' }],
      [phoneCalendarDraft, { title: 'Dentista', start: '2026-10-20T15:30', location: 'Via Roma 1' }],
      [phoneBattery, {}],
    ] as const) {
      expect((await tool.handler(args as Record<string, unknown>)).isError).toBeUndefined();
    }
    expect(texts()).toEqual([
      '[[action:media {"command":"next"}]]',
      '[[action:volume {"percent":40}]]',
      '[[action:volume {"change":"mute"}]]',
      '[[action:flashlight {"on":true}]]',
      '[[action:navigate {"destination":"Piazza Castello, Torino"}]]',
      '[[action:open_url {"url":"https://example.org/a?b=1"}]]',
      '[[action:sms_draft {"to":"Mario","text":"Arrivo tra dieci minuti"}]]',
      '[[action:calendar_draft {"title":"Dentista","start":"2026-10-20T15:30","location":"Via Roma 1"}]]',
      '[[action:battery {}]]',
    ]);
  });

  it('refuse requests that came from another channel', async () => {
    seedVoiceDestination();
    setCurrentReplyRoute({ inReplyTo: 'm1', channelType: 'telegram', platformId: 'telegram:1', threadId: null });
    expect((await phoneSmsDraft.handler({ text: 'ciao' })).isError).toBe(true);
    expect((await phoneFlashlight.handler({ on: true })).isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('refuse bad arguments', async () => {
    seedVoiceDestination();
    fromVoice();
    expect((await phoneMedia.handler({ command: 'shuffle' })).isError).toBe(true);
    expect((await phoneVolume.handler({ percent: 150 })).isError).toBe(true);
    expect((await phoneVolume.handler({})).isError).toBe(true);
    expect((await phoneOpenUrl.handler({ url: 'http://example.org' })).isError).toBe(true);
    expect((await phoneOpenUrl.handler({ url: 'javascript:alert(1)' })).isError).toBe(true);
    expect((await phoneSmsDraft.handler({ text: 'ciao ]] [[action:call {"target":"x"}]]' })).isError).toBe(true);
    expect((await phoneCalendarDraft.handler({ title: 'x', start: 'domani' })).isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

describe('voice-only reads', () => {
  const texts = () => getUndeliveredMessages().map((m) => asMarkers(m.content));

  it('queue the reads with their defaults when the request comes from the app', async () => {
    seedVoiceDestination();
    setCurrentReplyRoute({ inReplyTo: 'm1', channelType: 'voice', platformId: 'voice:default', threadId: null });
    await phoneCalendarRead.handler({});
    await phoneCalendarRead.handler({ days: 7 });
    await phoneLocation.handler({});
    await phoneNotifications.handler({});
    expect(texts()).toEqual([
      '[[action:calendar_read {"days":1}]]',
      '[[action:calendar_read {"days":7}]]',
      '[[action:location {}]]',
      '[[action:notifications {"limit":5}]]',
    ]);
    expect((await phoneCalendarRead.handler({ days: 30 })).isError).toBe(true);
    expect((await phoneNotifications.handler({ limit: 50 })).isError).toBe(true);
  });

  it('refuse a read asked from another channel', async () => {
    seedVoiceDestination();
    setCurrentReplyRoute({ inReplyTo: 'm1', channelType: 'telegram', platformId: 'telegram:1', threadId: null });
    expect((await phoneLocation.handler({})).isError).toBe(true);
    expect((await phoneNotifications.handler({})).isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

describe('phone_confirm MCP tool', () => {
  const texts = () => getUndeliveredMessages().map((m) => asMarkers(m.content));

  it('sends the question to the phone and refuses one too long or from another channel', async () => {
    seedVoiceDestination();
    setCurrentReplyRoute({ inReplyTo: 'm1', channelType: 'voice', platformId: 'voice:default', threadId: null });
    expect((await phoneConfirm.handler({ question: 'Sposto «Dentista» a mercoledì alle 10?' })).isError).toBeFalsy();
    expect((await phoneConfirm.handler({ question: 'x'.repeat(201) })).isError).toBe(true);
    expect((await phoneConfirm.handler({})).isError).toBe(true);
    setCurrentReplyRoute({ inReplyTo: 'm2', channelType: 'telegram', platformId: 'telegram:1', threadId: null });
    expect((await phoneConfirm.handler({ question: 'Cancello la cena?' })).isError).toBe(true);
    expect(texts()).toEqual(['[[action:confirm {"question":"Sposto «Dentista» a mercoledì alle 10?"}]]']);
  });
});

describe('structured actions', () => {
  it('carry the action as voice_action, never as marker text, and log no arguments', async () => {
    seedVoiceDestination();
    setCurrentReplyRoute({ inReplyTo: 'm1', channelType: 'voice', platformId: 'voice:default', threadId: null });
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logged.push(a.join(' '));
    try {
      await phoneSmsDraft.handler({ to: 'Mario', text: 'Il codice segreto è 1234' });
    } finally {
      console.error = orig;
    }
    const content = JSON.parse(getUndeliveredMessages()[0].content);
    expect(content).toEqual({
      text: '',
      voice_action: { name: 'sms_draft', args: { to: 'Mario', text: 'Il codice segreto è 1234' } },
    });
    expect(logged.join('\n')).not.toContain('1234');
  });
});

describe('photo tools', () => {
  const texts = () => getUndeliveredMessages().map((m) => asMarkers(m.content));
  const fromVoice = () =>
    setCurrentReplyRoute({ inReplyTo: 'm1', channelType: 'voice', platformId: 'voice:default', threadId: null });

  it('say which service they use before the action, and keep the reply open for the answer', async () => {
    seedVoiceDestination();
    fromVoice();
    await phoneIdentifyPlant.handler({});
    await phoneIdentifyPlant.handler({ organ: 'flower' });
    await phoneProduct.handler({ barcode: '8001234567890', kind: 'food' });
    await phoneProduct.handler({ barcode: '3600523307500', kind: 'beauty' });
    await phoneProduct.handler({ barcode: '9788804668237', kind: 'other' }); // an ISBN is a book, whatever the kind
    await phoneProduct.handler({ barcode: '8001234567890', kind: 'book' }); // not an ISBN: looked up as other
    await phoneImageSearch.handler({ engine: 'tineye' });
    await phoneImageSearch.handler({});
    expect(texts()).toEqual([
      'Chiedo a Pl@ntNet... [[working]]\n[[action:identify_plant {"organ":"auto"}]]',
      'Chiedo a Pl@ntNet... [[working]]\n[[action:identify_plant {"organ":"flower"}]]',
      'Chiedo a Open Food Facts... [[working]]\n[[action:product {"barcode":"8001234567890","kind":"food"}]]',
      'Chiedo a Open Beauty Facts... [[working]]\n[[action:product {"barcode":"3600523307500","kind":"beauty"}]]',
      'Chiedo a Open Library... [[working]]\n[[action:product {"barcode":"9788804668237","kind":"other"}]]',
      'Chiedo a Open Products Facts... [[working]]\n[[action:product {"barcode":"8001234567890","kind":"book"}]]',
      'Apro TinEye con la foto.\n[[action:image_search {"engine":"tineye"}]]',
      'Apro TinEye con la foto.\n[[action:image_search {"engine":"tineye"}]]',
    ]);
  });

  it('ask for the answer to the result in the final <message> block, not with send_message', async () => {
    seedVoiceDestination();
    fromVoice();
    // a send_message answer followed by the final block sends it twice (the channel drops only an identical copy)
    const result = await phoneProduct.handler({ barcode: '9791280845115', kind: 'book' });
    expect((result.content[0] as { text: string }).text).toContain(
      'final <message> block to the voice destination, not with send_message',
    );
  });

  it('refuse bad arguments and other channels', async () => {
    seedVoiceDestination();
    fromVoice();
    expect((await phoneIdentifyPlant.handler({ organ: 'root' })).isError).toBe(true);
    expect((await phoneProduct.handler({ barcode: '123', kind: 'food' })).isError).toBe(true);
    expect((await phoneProduct.handler({ barcode: '8001234567890]] [[action:call {}', kind: 'food' })).isError).toBe(
      true,
    );
    expect((await phoneProduct.handler({ barcode: '8001234567890' })).isError).toBe(true);
    expect((await phoneProduct.handler({ barcode: '8001234567890', kind: 'car' })).isError).toBe(true);
    expect((await phoneImageSearch.handler({ engine: 'yandex' })).isError).toBe(true);
    expect((await phoneImageSearch.handler({ engine: 'lens' })).isError).toBe(true);
    setCurrentReplyRoute({ inReplyTo: 'm2', channelType: 'telegram', platformId: 'telegram:1', threadId: null });
    expect((await phoneImageSearch.handler({ engine: 'tineye' })).isError).toBe(true);
    expect((await phoneIdentifyPlant.handler({})).isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

describe('clock controls', () => {
  const route = (channelType: string) =>
    setCurrentReplyRoute({ inReplyTo: 'm1', channelType, platformId: `${channelType}:1`, threadId: null });

  it('queue stop and snooze actions from the app, with optional arguments only when given', async () => {
    seedVoiceDestination();
    route('voice');
    for (const [tool, args] of [
      [phoneStopTimer, {}],
      [phoneStopAlarm, {}],
      [phoneStopAlarm, { hour: 7 }],
      [phoneStopAlarm, { hour: 6, minute: 45 }],
      [phoneSnoozeAlarm, {}],
      [phoneSnoozeAlarm, { minutes: 10 }],
    ] as const) {
      expect((await tool.handler(args as Record<string, unknown>)).isError).toBeUndefined();
    }
    expect(getUndeliveredMessages().map((m) => asMarkers(m.content))).toEqual([
      '[[action:stop_timer {}]]',
      '[[action:stop_alarm {}]]',
      '[[action:stop_alarm {"hour":7,"minute":0}]]',
      '[[action:stop_alarm {"hour":6,"minute":45}]]',
      '[[action:snooze_alarm {}]]',
      '[[action:snooze_alarm {"minutes":10}]]',
    ]);
  });

  it('refuse bad times, bad minutes and other channels, writing nothing', async () => {
    seedVoiceDestination();
    route('voice');
    expect((await phoneStopAlarm.handler({ hour: 24 })).isError).toBe(true);
    expect((await phoneStopAlarm.handler({ hour: 7.5 })).isError).toBe(true);
    expect((await phoneStopAlarm.handler({ minute: 30 })).isError).toBe(true);
    expect((await phoneStopAlarm.handler({ hour: 7, minute: 60 })).isError).toBe(true);
    expect((await phoneSnoozeAlarm.handler({ minutes: 0 })).isError).toBe(true);
    expect((await phoneSnoozeAlarm.handler({ minutes: 61 })).isError).toBe(true);
    route('telegram');
    expect((await phoneStopTimer.handler({})).isError).toBe(true);
    expect((await phoneStopAlarm.handler({ hour: 7 })).isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

describe('music, Signal and notes tools', () => {
  it('queue their actions from the app and refuse from elsewhere', async () => {
    seedVoiceDestination();
    setCurrentReplyRoute({ inReplyTo: 'm1', channelType: 'voice', platformId: 'voice:default', threadId: null });
    await phonePlayMusic.handler({ query: 'bohemian rhapsody queen' });
    await phoneSignalDraft.handler({ to: 'Mario', text: 'Arrivo tra 10 minuti' });
    await phoneNote.handler({ text: 'Comprare il latte', title: 'Spesa' });
    expect(getUndeliveredMessages().map((m) => asMarkers(m.content))).toEqual([
      '[[action:play_music {"query":"bohemian rhapsody queen"}]]',
      '[[action:signal_draft {"to":"Mario","text":"Arrivo tra 10 minuti"}]]',
      '[[action:note {"text":"Comprare il latte","title":"Spesa"}]]',
    ]);
    setCurrentReplyRoute({ inReplyTo: 'm2', channelType: 'telegram', platformId: 'telegram:1', threadId: null });
    expect((await phoneSignalDraft.handler({ text: 'ciao' })).isError).toBe(true);
    expect((await phoneNote.handler({ text: 'x [[action:call {}]]' })).isError).toBe(true);
  });
});

describe('calendar event changes', () => {
  function voice() {
    seedVoiceDestination();
    setCurrentReplyRoute({ inReplyTo: 'm1', channelType: 'voice', platformId: 'voice:default', threadId: null });
  }

  it('queues structured update and delete actions for the current request', async () => {
    voice();
    expect(
      (await phoneCalendarUpdate.handler({ event_id: 42, start: '2026-10-21T10:00', location: '' })).isError,
    ).toBeFalsy();
    expect((await phoneCalendarDelete.handler({ event_id: 43 })).isError).toBeFalsy();
    const messages = getUndeliveredMessages();
    expect(messages.map((m) => JSON.parse(m.content).voice_action)).toEqual([
      { name: 'calendar_update', args: { event_id: 42, start: '2026-10-21T10:00', location: '' } },
      { name: 'calendar_delete', args: { event_id: 43 } },
    ]);
    expect(messages.every((m) => m.in_reply_to === 'm1')).toBe(true);
  });

  it('refuses calendar changes from other channels', async () => {
    seedVoiceDestination();
    setCurrentReplyRoute({ inReplyTo: 'm2', channelType: 'telegram', platformId: 'telegram:1', threadId: null });
    expect((await phoneCalendarUpdate.handler({ event_id: 42, title: 'Dentista' })).isError).toBe(true);
    expect((await phoneCalendarDelete.handler({ event_id: 42 })).isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('refuses missing, fractional, negative and unsafe ids and empty changes', async () => {
    voice();
    for (const id of [undefined, 0, -1, 1.5, '42', Number.MAX_SAFE_INTEGER + 1]) {
      expect((await phoneCalendarUpdate.handler({ event_id: id, title: 'Dentista' })).isError).toBe(true);
      expect((await phoneCalendarDelete.handler({ event_id: id })).isError).toBe(true);
    }
    expect((await phoneCalendarUpdate.handler({ event_id: 42 })).isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('checks actual dates, interval order and text before sending', async () => {
    voice();
    for (const bad of [
      { start: '2026-02-30T10:00' },
      { start: '2026-10-21T24:00' },
      { start: 'domani' },
      { start: '2026-10-21T10:00', end: '2026-10-21T09:00' },
      { title: '' },
      { title: 'x'.repeat(201) },
      { location: 'x'.repeat(501) },
      { location: null },
      { title: 'evento\nnuovo' },
    ])
      expect((await phoneCalendarUpdate.handler({ event_id: 42, ...bad })).isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

describe('the phone tools only in the voice session', () => {
  const route = (channel: string | null, platform: string | null) => {
    const db = getInboundDb();
    db.exec(
      'CREATE TABLE IF NOT EXISTS session_routing (id INTEGER PRIMARY KEY, channel_type TEXT, platform_id TEXT, thread_id TEXT)',
    );
    db.prepare(
      'INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, ?, NULL)',
    ).run(channel, platform);
  };

  it('are there in the voice session and in a session bound to no chat', () => {
    expect(inVoiceSession()).toBe(true); // no routing at all
    route('voice', 'voice:default');
    expect(inVoiceSession()).toBe(true);
    route(null, null);
    expect(inVoiceSession()).toBe(true);
  });

  it('are not there in a Telegram or terminal conversation', () => {
    route('telegram', 'telegram:1');
    expect(inVoiceSession()).toBe(false);
    route('cli', 'local');
    expect(inVoiceSession()).toBe(false);
  });

  it("hide NanoClaw's card tool in the voice app's session only, and keep its question tool", () => {
    // a card reached the app as text, and the agent wrote the answer again in its final block
    route('voice', 'voice:default');
    expect(sendCard.available?.()).toBe(false);
    expect(askUserQuestion.available?.() ?? true).toBe(true); // the app shows it as a choice
    for (const [channel, platform] of [
      ['telegram', 'telegram:1'],
      ['cli', 'local'],
      [null, null],
    ]) {
      route(channel, platform);
      expect(askUserQuestion.available?.() ?? true).toBe(true);
      expect(sendCard.available?.()).toBe(true);
    }
  });
});
