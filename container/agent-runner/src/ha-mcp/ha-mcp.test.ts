/**
 * The claim worth testing is the gating one: a capability the operator did not
 * enable produces no tool, so it is absent from `tools/list` rather than
 * present-and-refusing. Everything else here guards the two places a silent
 * wrong answer is possible — env parsing (a mis-read token looks like a 401
 * much later) and the room map (a bad rewrite loses answers people gave once).
 *
 * Handler assertions stick to paths that reject before any network call, so
 * the suite needs no Home Assistant and no fetch stubbing.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConfigError, connectionFrom, loadServices, parseEnvFile, type Services } from './config.js';
import { HomeAssistant } from './ha.js';
import { noProxyCovers, parseProcEnviron, resolveProxy } from './proxy.js';
import { getRoom, readRooms, setRoom } from './rooms.js';
import { buildTools } from './tools.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ha-mcp-'));
}

const ha = new HomeAssistant({ url: 'http://ha.invalid:8123', auth: 'gateway' });

function names(services: Services): string[] {
  return buildTools(services, ha, '/nonexistent').map((t) => t.tool.name);
}

describe('config.env parsing', () => {
  it('reads plain, quoted, and commented lines', () => {
    const env = parseEnvFile(['# a comment', 'HA_URL=http://ha.lan:8123', 'HA_AUTH="token"', "HA_TOKEN='abc=def'", '', 'BROKEN'].join('\n'));
    expect(env).toEqual({ HA_URL: 'http://ha.lan:8123', HA_AUTH: 'token', HA_TOKEN: 'abc=def' });
  });

  it('keeps everything after the first = so a token containing = survives', () => {
    expect(parseEnvFile('HA_TOKEN=aa=bb=cc').HA_TOKEN).toBe('aa=bb=cc');
  });

  it('strips a trailing slash so paths never double up', () => {
    expect(connectionFrom({ HA_URL: 'https://ha.lan:8123/' }).url).toBe('https://ha.lan:8123');
  });

  it('defaults to gateway and carries no token', () => {
    expect(connectionFrom({ HA_URL: 'https://ha.lan:8123' })).toEqual({ url: 'https://ha.lan:8123', auth: 'gateway' });
  });

  it('rejects token mode with no token rather than sending an empty header', () => {
    expect(() => connectionFrom({ HA_URL: 'http://ha.lan:8123', HA_AUTH: 'token' })).toThrow(ConfigError);
  });

  it('rejects a missing URL', () => {
    expect(() => connectionFrom({ HA_AUTH: 'gateway' })).toThrow(ConfigError);
  });
});

describe('services.json', () => {
  it('treats an absent file as nothing wired, not as an error', () => {
    expect(loadServices(tmpdir())).toEqual({});
  });

  it('treats an empty file the same way', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'services.json'), '  \n');
    expect(loadServices(dir)).toEqual({});
  });

  it('rejects malformed JSON loudly', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'services.json'), '{nope');
    expect(() => loadServices(dir)).toThrow(ConfigError);
  });
});

describe('capability gating', () => {
  it('exposes no tools at all when nothing is wired', () => {
    expect(names({})).toEqual([]);
  });

  it('exposes only the vacuum capabilities that were enabled', () => {
    const got = names({ vacuum: { entity_id: 'vacuum.x', capabilities: ['status', 'list_areas', 'clean_area'] } });
    expect(got.sort()).toEqual(['vacuum_clean_area', 'vacuum_list_areas', 'vacuum_status']);
  });

  it('omits clean_area, clean_everywhere and the room map when they are off', () => {
    const got = names({ vacuum: { entity_id: 'vacuum.x', capabilities: ['status'] } });
    expect(got).not.toContain('vacuum_clean_area');
    expect(got).not.toContain('vacuum_clean_everywhere');
    expect(got).not.toContain('vacuum_get_room');
    expect(got).not.toContain('vacuum_remember_room');
  });

  it('offers only the enabled subset as vacuum_control enum members', () => {
    const [control] = buildTools({ vacuum: { entity_id: 'vacuum.x', capabilities: ['stop', 'locate'] } }, ha, '/nonexistent');
    expect(control.tool.name).toBe('vacuum_control');
    const schema = control.tool.inputSchema as { properties: { command: { enum: string[] } } };
    expect(schema.properties.command.enum).toEqual(['stop', 'locate']);
  });

  it('drops vacuum_control entirely when no direct command is enabled', () => {
    expect(names({ vacuum: { entity_id: 'vacuum.x', capabilities: ['status'] } })).not.toContain('vacuum_control');
  });

  it('does not expose set_mode without a mode entity to drive', () => {
    expect(names({ vacuum: { entity_id: 'vacuum.x', capabilities: ['set_mode'] } })).toEqual([]);
    expect(names({ vacuum: { entity_id: 'vacuum.x', capabilities: ['set_mode'], mode_entity: 'select.x_mode' } })).toEqual(['vacuum_set_mode']);
  });

  it('exposes car tools only for the side that has entries', () => {
    expect(names({ car: { actions: [{ name: 'ac', label: 'AC', entity_id: 'climate.x', service: 'climate.turn_on', off_service: 'climate.turn_off' }], readings: [] } })).toEqual(['car_control']);
    expect(names({ car: { actions: [], readings: [{ name: 'battery', label: 'Battery', entity_id: 'sensor.x' }] } })).toEqual(['car_status']);
  });

  it('lists only the enabled actions and readings in the car schemas', () => {
    const tools = buildTools(
      {
        car: {
          actions: [{ name: 'ac', label: 'AC', entity_id: 'climate.x', service: 'climate.turn_on', off_service: 'climate.turn_off' }],
          readings: [{ name: 'battery', label: 'Battery', entity_id: 'sensor.x' }],
        },
      },
      ha,
      '/nonexistent',
    );
    const control = tools.find((t) => t.tool.name === 'car_control')!;
    const status = tools.find((t) => t.tool.name === 'car_status')!;
    expect((control.tool.inputSchema as { properties: { action: { enum: string[] } } }).properties.action.enum).toEqual(['ac']);
    expect((status.tool.inputSchema as { properties: { readings: { items: { enum: string[] } } } }).properties.readings.items.enum).toEqual(['battery']);
  });

  it('wires vacuum and car together without either shadowing the other', () => {
    const got = names({
      vacuum: { entity_id: 'vacuum.x', capabilities: ['status'] },
      car: { actions: [], readings: [{ name: 'battery', label: 'Battery', entity_id: 'sensor.x' }] },
    });
    expect(got.sort()).toEqual(['car_status', 'vacuum_status']);
  });

  it('exposes printer tools only for the side that has entries', () => {
    expect(names({ printers: [{ name: 'p', label: 'P', readings: [{ name: 'state', kind: 'status', label: 'Status', entity_id: 'sensor.p' }] }] })).toEqual([
      'printer_status',
    ]);
    expect(
      names({ printers: [{ name: 'p', label: 'P', readings: [], actions: [{ name: 'power', label: 'Power', entity_id: 'switch.p', service: 'switch.turn_on', off_service: 'switch.turn_off' }] }] }),
    ).toEqual(['printer_control']);
  });

  it('exposes nothing for a printer with neither readings nor actions', () => {
    expect(names({ printers: [{ name: 'p', label: 'P', readings: [] }] })).toEqual([]);
  });

  it('ignores a printers value that is not a list rather than crashing the server', () => {
    expect(names({ printers: {} as never })).toEqual([]);
  });

  it('wires all three services together', () => {
    const got = names({
      vacuum: { entity_id: 'vacuum.x', capabilities: ['status'] },
      car: { actions: [], readings: [{ name: 'battery', label: 'Battery', entity_id: 'sensor.x' }] },
      printers: [{ name: 'p', label: 'P', readings: [{ name: 'state', kind: 'status', label: 'Status', entity_id: 'sensor.p' }] }],
    });
    expect(got.sort()).toEqual(['car_status', 'printer_status', 'vacuum_status']);
  });
});

describe('car_control argument checking', () => {
  const car = {
    actions: [
      { name: 'ac', label: 'AC', entity_id: 'climate.x', service: 'climate.turn_on', off_service: 'climate.turn_off' },
      { name: 'horn', label: 'Horn', entity_id: 'button.x', service: 'button.press' },
    ],
    readings: [],
  };
  const control = buildTools({ car }, ha, '/nonexistent')[0];

  it('refuses an action that was never enabled', async () => {
    const res = await control.handler({ action: 'unlock' });
    expect(res.isError).toBe(true);
    expect(String((res.content as { text: string }[])[0].text)).toContain('Unknown action');
  });

  it('refuses a two-state action with no state, rather than guessing on', async () => {
    const res = await control.handler({ action: 'ac' });
    expect(res.isError).toBe(true);
  });

  it('refuses a state on a one-shot action', async () => {
    const res = await control.handler({ action: 'horn', state: 'off' });
    expect(res.isError).toBe(true);
  });
});

describe('car target temperature', () => {
  // This car lands 2°C above whatever is written, and discards the write unless
  // hvac_mode rides along. Both corrections belong to the config, not the caller:
  // the agent passes the number the person said.
  const acTemp = { min: 15, max: 31, offset: 2, hvac_mode: 'heat_cool' };
  const car = {
    actions: [
      { name: 'ac', label: 'AC', entity_id: 'climate.x', service: 'climate.turn_on', off_service: 'climate.turn_off', temperature: acTemp },
      { name: 'doors', label: 'Doors', entity_id: 'lock.x', service: 'lock.lock', off_service: 'lock.unlock' },
    ],
    readings: [],
  };

  /** Records service calls instead of making them, so the wire value is assertable. */
  function recording() {
    const calls: { service: string; data: Record<string, unknown> }[] = [];
    const stub = new HomeAssistant({ url: 'http://ha.invalid:8123', auth: 'gateway' });
    stub.callService = async (service: string, data: Record<string, unknown>) => {
      calls.push({ service, data });
      return undefined as unknown as ReturnType<HomeAssistant['callService']>;
    };
    return { calls, control: buildTools({ car }, stub, '/nonexistent')[0] };
  }

  it('subtracts the offset so the number the user said is where the car lands', async () => {
    const { calls, control } = recording();
    const res = await control.handler({ action: 'ac', state: 'on', temperature: 20 });
    expect(res.isError).toBeFalsy();
    expect(calls).toHaveLength(2);
    expect(calls[0].service).toBe('climate.turn_on');
    expect(calls[1].service).toBe('climate.set_temperature');
    expect(calls[1].data.temperature).toBe(18);
    expect(calls[1].data.hvac_mode).toBe('heat_cool');
  });

  it('turns on before setting, because the write is discarded while off', async () => {
    const { calls, control } = recording();
    await control.handler({ action: 'ac', state: 'on', temperature: 22 });
    expect(calls.map((c) => c.service)).toEqual(['climate.turn_on', 'climate.set_temperature']);
  });

  it('still works with no temperature — one call, unchanged behavior', async () => {
    const { calls, control } = recording();
    await control.handler({ action: 'ac', state: 'on' });
    expect(calls).toHaveLength(1);
  });

  it('rejects a temperature outside the car range before calling anything', async () => {
    const { calls, control } = recording();
    const res = await control.handler({ action: 'ac', state: 'on', temperature: 35 });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('rejects a temperature on an action that has none', async () => {
    const { calls, control } = recording();
    const res = await control.handler({ action: 'doors', state: 'on', temperature: 20 });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('rejects a temperature while turning off', async () => {
    const { calls, control } = recording();
    const res = await control.handler({ action: 'ac', state: 'off', temperature: 20 });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('offsets by zero when the car needs no correction', async () => {
    const plain = {
      actions: [{ name: 'ac', label: 'AC', entity_id: 'climate.x', service: 'climate.turn_on', off_service: 'climate.turn_off', temperature: { min: 15, max: 31 } }],
      readings: [],
    };
    const calls: { service: string; data: Record<string, unknown> }[] = [];
    const stub = new HomeAssistant({ url: 'http://ha.invalid:8123', auth: 'gateway' });
    stub.callService = async (service: string, data: Record<string, unknown>) => {
      calls.push({ service, data });
      return undefined as unknown as ReturnType<HomeAssistant['callService']>;
    };
    await buildTools({ car: plain }, stub, '/nonexistent')[0].handler({ action: 'ac', state: 'on', temperature: 20 });
    expect(calls[1].data.temperature).toBe(20);
    expect(calls[1].data.hvac_mode).toBeUndefined();
  });

  it('omits the temperature argument entirely when no action accepts one', () => {
    const tools = buildTools(
      { car: { actions: [{ name: 'doors', label: 'Doors', entity_id: 'lock.x', service: 'lock.lock', off_service: 'lock.unlock' }], readings: [] } },
      ha,
      '/nonexistent',
    );
    const schema = tools[0].tool.inputSchema as { properties: Record<string, unknown> };
    expect(schema.properties.temperature).toBeUndefined();
  });
});

describe('printer schema shaping', () => {
  const canon = {
    name: 'canon',
    label: 'Canon TS3100',
    readings: [
      { name: 'state', kind: 'status' as const, label: 'Printer status', entity_id: 'sensor.canon' },
      { name: 'black', kind: 'supply' as const, label: 'Black ink', entity_id: 'sensor.canon_black' },
    ],
  };
  const laser = {
    name: 'laser',
    label: 'Brother laser',
    readings: [{ name: 'pages', kind: 'counter' as const, label: 'Page counter', entity_id: 'sensor.brother_pages' }],
  };

  function schema(services: Services, tool: string): { properties: Record<string, { enum?: string[] }>; required?: string[] } {
    return buildTools(services, ha, '/nonexistent').find((t) => t.tool.name === tool)!.tool.inputSchema as never;
  }

  it('offers no printer argument at all when there is only one', () => {
    expect(schema({ printers: [canon] }, 'printer_status').properties.printer).toBeUndefined();
  });

  it('offers a printer enum once there are two', () => {
    expect(schema({ printers: [canon, laser] }, 'printer_status').properties.printer!.enum).toEqual(['canon', 'laser']);
  });

  it('lists only the kinds actually wired, in report order', () => {
    expect(schema({ printers: [canon, laser] }, 'printer_status').properties.kind!.enum).toEqual(['status', 'supply', 'counter']);
  });

  it('requires an explicit printer for control only when there is more than one', () => {
    const power = { name: 'power', label: 'Power', entity_id: 'switch.a', service: 'switch.turn_on', off_service: 'switch.turn_off' };
    expect(schema({ printers: [{ ...canon, actions: [power] }] }, 'printer_control').required).toEqual(['action']);
    expect(schema({ printers: [{ ...canon, actions: [power] }, { ...laser, actions: [power] }] }, 'printer_control').required).toEqual([
      'printer',
      'action',
    ]);
  });
});

describe('printer readings', () => {
  /** Answers getState from a fixture instead of the network. */
  function reading(states: Record<string, { state: string; attributes?: Record<string, unknown> }>) {
    const stub = new HomeAssistant({ url: 'http://ha.invalid:8123', auth: 'gateway' });
    stub.getState = async (entityId: string) => {
      const s = states[entityId];
      if (!s) throw new Error(`Entity ${entityId} not found`);
      return { entity_id: entityId, state: s.state, attributes: s.attributes ?? {} };
    };
    return stub;
  }

  async function report(services: Services, stub: HomeAssistant, args: Record<string, unknown> = {}) {
    const tool = buildTools(services, stub, '/nonexistent').find((t) => t.tool.name === 'printer_status')!;
    const res = await tool.handler(args);
    const text = String((res.content as { text: string }[])[0].text);
    // A rejection is prose, not JSON — parsing it would fail the assertion for
    // the wrong reason.
    return { res, text, body: res.isError ? {} : JSON.parse(text) };
  }

  // The live shape from a Canon TS3100 on HA's IPP integration: the marker
  // sensors publish the printer's own low-water mark, so nothing has to guess it.
  const canonStates = {
    'sensor.canon': {
      state: 'stopped',
      attributes: { state_reason: 'media-empty', state_message: null, info: "Yanay's Printer", location: '' },
    },
    'sensor.canon_black': { state: '90', attributes: { unit_of_measurement: '%', marker_low_level: 15, marker_type: 'ink-cartridge' } },
    'sensor.canon_color': { state: '10', attributes: { unit_of_measurement: '%', marker_low_level: 15, marker_type: 'ink-cartridge' } },
  };
  const canon: Services = {
    printers: [
      {
        name: 'canon',
        label: 'Canon TS3100',
        readings: [
          { name: 'state', kind: 'status', label: 'Printer status', entity_id: 'sensor.canon' },
          { name: 'black', kind: 'supply', label: 'Black ink', entity_id: 'sensor.canon_black' },
          { name: 'color', kind: 'supply', label: 'Colour ink', entity_id: 'sensor.canon_color' },
        ],
      },
    ],
  };

  it('groups readings by kind under the printer', async () => {
    const { body } = await report(canon, reading(canonStates));
    expect(Object.keys(body)).toEqual(['canon']);
    expect(body.canon.label).toBe('Canon TS3100');
    expect(Object.keys(body.canon.supply)).toEqual(['black', 'color']);
  });

  it('flags a supply low against the level the printer itself publishes', async () => {
    const { body } = await report(canon, reading(canonStates));
    expect(body.canon.supply.black).toMatchObject({ value: 90, unit: '%', low: false, low_at: 15, type: 'ink-cartridge' });
    expect(body.canon.supply.color).toMatchObject({ value: 10, low: true, low_at: 15 });
  });

  it('prefers an operator threshold over the printer opinion', async () => {
    const strict: Services = {
      printers: [{ name: 'canon', label: 'Canon', readings: [{ name: 'black', kind: 'supply', label: 'Black', entity_id: 'sensor.canon_black', low_threshold: 95 }] }],
    };
    const { body } = await report(strict, reading(canonStates));
    expect(body.canon.supply.black).toMatchObject({ value: 90, low: true, low_at: 95 });
  });

  it('claims nothing about low when neither side names a threshold', async () => {
    const bare: Services = {
      printers: [{ name: 'b', label: 'B', readings: [{ name: 'toner', kind: 'supply', label: 'Toner', entity_id: 'sensor.t' }] }],
    };
    const { body } = await report(bare, reading({ 'sensor.t': { state: '42', attributes: { unit_of_measurement: '%' } } }));
    expect(body.b.supply.toner.value).toBe(42);
    expect(body.b.supply.toner.low).toBeUndefined();
  });

  it('never reports an IPP unknown-level sentinel as a percentage', async () => {
    // -1/-2/-3 are RFC 8011 "no level reported". `-1%` of ink would be a lie,
    // and `low: true` off the back of it a worse one.
    const bare: Services = {
      printers: [{ name: 'b', label: 'B', readings: [{ name: 'black', kind: 'supply', label: 'Black', entity_id: 'sensor.t' }] }],
    };
    const { body } = await report(bare, reading({ 'sensor.t': { state: '-1', attributes: { unit_of_measurement: '%', marker_low_level: 15 } } }));
    expect(body.b.supply.black.value).toBeNull();
    expect(body.b.supply.black.reported).toBe('-1');
    expect(body.b.supply.black.low).toBeUndefined();
    expect(body.b.supply.black.note).toContain('does not report');
  });

  it('passes an asleep printer through as unavailable rather than as a number', async () => {
    const bare: Services = {
      printers: [{ name: 'b', label: 'B', readings: [{ name: 'black', kind: 'supply', label: 'Black', entity_id: 'sensor.t' }] }],
    };
    const { body } = await report(bare, reading({ 'sensor.t': { state: 'unavailable' } }));
    expect(body.b.supply.black.value).toBeNull();
    expect(body.b.supply.black.reported).toBe('unavailable');
  });

  it('surfaces why a stopped printer stopped, and drops the empty extras', async () => {
    const { body } = await report(canon, reading(canonStates));
    expect(body.canon.status.state).toMatchObject({ value: 'stopped', reason: 'media-empty', printer_name: "Yanay's Printer" });
    expect(body.canon.status.state.message).toBeUndefined(); // null
    expect(body.canon.status.state.location).toBeUndefined(); // ''
  });

  it('reports a dead entity per reading instead of blanking the report', async () => {
    const { body } = await report(canon, reading({ ...canonStates, 'sensor.canon_black': undefined as never }));
    expect(body.canon.supply.black.error).toContain('not found');
    expect(body.canon.supply.color.value).toBe(10);
  });

  it('narrows to one kind when asked', async () => {
    const { body } = await report(canon, reading(canonStates), { kind: 'supply' });
    expect(body.canon.status).toBeUndefined();
    expect(Object.keys(body.canon.supply)).toEqual(['black', 'color']);
  });

  it('refuses a kind and a printer it does not have', async () => {
    const stub = reading(canonStates);
    expect((await report(canon, stub, { kind: 'tray' })).res.isError).toBe(true);
    expect((await report(canon, stub, { printer: 'nope' })).res.isError).toBe(true);
  });

  it('treats an unlabelled reading as other rather than dropping it', async () => {
    const untyped: Services = { printers: [{ name: 'b', label: 'B', readings: [{ name: 'mystery', label: 'Mystery', entity_id: 'sensor.t' }] }] };
    const { body } = await report(untyped, reading({ 'sensor.t': { state: '7' } }));
    expect(body.b.other.mystery.value).toBe('7');
  });
});

describe('printer_control', () => {
  function recording(services: Services) {
    const calls: { service: string; data: Record<string, unknown> }[] = [];
    const stub = new HomeAssistant({ url: 'http://ha.invalid:8123', auth: 'gateway' });
    stub.callService = async (service: string, data: Record<string, unknown>) => {
      calls.push({ service, data });
      return undefined as unknown as ReturnType<HomeAssistant['callService']>;
    };
    return { calls, control: buildTools(services, stub, '/nonexistent').find((t) => t.tool.name === 'printer_control')! };
  }

  const power = { name: 'power', label: 'Power', entity_id: 'switch.canon', service: 'switch.turn_on', off_service: 'switch.turn_off' };
  const identify = { name: 'identify', label: 'Identify', entity_id: 'button.canon', service: 'button.press' };
  const one: Services = { printers: [{ name: 'canon', label: 'Canon', readings: [], actions: [power, identify] }] };

  it('drives the only printer without being told which', async () => {
    const { calls, control } = recording(one);
    const res = await control.handler({ action: 'power', state: 'off' });
    expect(res.isError).toBeFalsy();
    expect(calls).toEqual([{ service: 'switch.turn_off', data: { entity_id: 'switch.canon' } }]);
  });

  it('refuses a two-state action with no state, and a state on a one-shot one', async () => {
    const { calls, control } = recording(one);
    expect((await control.handler({ action: 'power' })).isError).toBe(true);
    expect((await control.handler({ action: 'identify', state: 'on' })).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('will not borrow one printer\'s action for another', async () => {
    const two: Services = {
      printers: [
        { name: 'canon', label: 'Canon', readings: [], actions: [power] },
        { name: 'laser', label: 'Laser', readings: [], actions: [identify] },
      ],
    };
    const { calls, control } = recording(two);
    const res = await control.handler({ printer: 'laser', action: 'power', state: 'on' });
    expect(res.isError).toBe(true);
    expect(String((res.content as { text: string }[])[0].text)).toContain('Unknown action');
    expect(calls).toHaveLength(0);
  });
});

describe('proxy resolution', () => {
  // The MCP stdio transport hands a server only HOME/LOGNAME/PATH/SHELL/TERM/USER,
  // so the container's proxy variables have to be recovered from PID 1. If this
  // regresses, gateway mode connects directly and every call 401s with no clue why.
  const gatewayEnv = { HTTPS_PROXY: 'http://172.17.0.1:10255', HTTP_PROXY: 'http://172.17.0.1:10255' };

  it('parses the NUL-separated /proc environ format', () => {
    expect(parseProcEnviron('HOME=/home/node\0HTTPS_PROXY=http://p:1\0\0')).toEqual({
      HOME: '/home/node',
      HTTPS_PROXY: 'http://p:1',
    });
  });

  it('routes through the container proxy in gateway mode', () => {
    expect(resolveProxy('https://ha.lan:8123', 'gateway', gatewayEnv).proxy).toBe('http://172.17.0.1:10255');
  });

  it('routes plain HTTP through the proxy too, rather than silently going direct', () => {
    expect(resolveProxy('http://ha.lan:8123', 'gateway', gatewayEnv).proxy).toBe('http://172.17.0.1:10255');
  });

  it('never uses a proxy in token mode — that is what bypassed means', () => {
    expect(resolveProxy('https://ha.lan:8123', 'token', gatewayEnv).proxy).toBeUndefined();
  });

  it('reads lowercase proxy variables as well', () => {
    expect(resolveProxy('https://ha.lan:8123', 'gateway', { https_proxy: 'http://p:2' }).proxy).toBe('http://p:2');
  });

  it('respects an operator NO_PROXY exclusion instead of overriding it', () => {
    const res = resolveProxy('https://ha.lan:8123', 'gateway', { ...gatewayEnv, NO_PROXY: 'ha.lan,foo' });
    expect(res.proxy).toBeUndefined();
    expect(res.note).toContain('NO_PROXY');
  });

  it('says so plainly when gateway mode finds no proxy at all', () => {
    const res = resolveProxy('https://ha.lan:8123', 'gateway', {});
    expect(res.proxy).toBeUndefined();
    expect(res.note).toContain('no token will be injected');
  });

  it('matches NO_PROXY on parent domains and a leading dot, but not on a suffix accident', () => {
    expect(noProxyCovers('.example.com', 'ha.example.com')).toBe(true);
    expect(noProxyCovers('example.com', 'example.com')).toBe(true);
    expect(noProxyCovers('*', 'anything')).toBe(true);
    expect(noProxyCovers('ample.com', 'example.com')).toBe(false);
  });
});

describe('room map', () => {
  it('reports nothing for an unmapped sender', () => {
    expect(getRoom(tmpdir(), '972524525356@s.whatsapp.net')).toBeUndefined();
  });

  it('round-trips a sender verbatim, suffix and all', () => {
    const dir = tmpdir();
    setRoom(dir, { sender: '972524525356@s.whatsapp.net', area_id: 'hkhdr_shl_myt', area_name: 'החדר של עמית' });
    expect(getRoom(dir, '972524525356@s.whatsapp.net')).toEqual({
      sender: '972524525356@s.whatsapp.net',
      area_id: 'hkhdr_shl_myt',
      area_name: 'החדר של עמית',
    });
  });

  it('replaces a sender row instead of leaving two', () => {
    const dir = tmpdir();
    setRoom(dir, { sender: 'a', area_id: 'one', area_name: 'One' });
    setRoom(dir, { sender: 'b', area_id: 'two', area_name: 'Two' });
    setRoom(dir, { sender: 'a', area_id: 'three', area_name: 'Three' });
    expect(readRooms(dir)).toHaveLength(2);
    expect(getRoom(dir, 'a')!.area_id).toBe('three');
    expect(getRoom(dir, 'b')!.area_id).toBe('two');
  });

  it('does not confuse two senders that share a prefix', () => {
    const dir = tmpdir();
    setRoom(dir, { sender: '9725@s.whatsapp.net', area_id: 'one', area_name: 'One' });
    setRoom(dir, { sender: '9725@lid', area_id: 'two', area_name: 'Two' });
    expect(getRoom(dir, '9725@s.whatsapp.net')!.area_id).toBe('one');
    expect(getRoom(dir, '9725@lid')!.area_id).toBe('two');
  });
});
