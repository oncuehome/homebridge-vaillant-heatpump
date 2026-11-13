'use strict';
// Runs the platform against a minimal stand-in for Homebridge.
const assert = require('assert');
const { VaillantHeatPumpPlatform } = require('./index.js');

class Char { constructor() { this.value = undefined; this.sets = null; }
  setProps(p) { this.props = { ...this.props, ...p }; return this; } updateValue(v) { this.value = v; return this; } onSet(f) { this.sets = f; return this; } }
class Svc { constructor(t, n, sub) { this.t = t; this.UUID = t.id; this.name = n; this.subtype = sub; this.chars = {}; }
  getCharacteristic(c) { return (this.chars[c.id] ||= new Char()); }
  setCharacteristic(c, v) { this.getCharacteristic(c).value = v; return this; }
  updateCharacteristic(c, v) { this.getCharacteristic(c).value = v; return this; }
  addOptionalCharacteristic() {}
  setPrimaryService(v) { this.primary = v; } }
const mkChar = (id, extra = {}) => Object.assign({ id }, extra);
const C = {
  Name: mkChar('Name'), ConfiguredName: mkChar('CN'), CurrentTemperature: mkChar('Temp'),
  LeakDetected: mkChar('Leak', { LEAK_NOT_DETECTED: 0, LEAK_DETECTED: 1 }), On: mkChar('On'),
  StatusFault: mkChar('Fault', { NO_FAULT: 0, GENERAL_FAULT: 1 }), Manufacturer: mkChar('Mf'), Model: mkChar('Mo'), SerialNumber: mkChar('Sn'),
};
const S = { TemperatureSensor: { id: 'TS' }, LeakSensor: { id: 'LS' }, Switch: { id: 'SW' }, AccessoryInformation: { id: 'AI' } };
class Acc { constructor(n, u) { this.displayName = n; this.UUID = u; this.services = []; }
  getService(t) { return this.services.find((s) => s.t === t); }
  getServiceById(t, sub) { return this.services.find((s) => s.t === t && s.subtype === sub); }
  addService(t, n, sub) { const s = new Svc(t, n, sub); this.services.push(s); return s; }
  removeService(sv) { this.services = this.services.filter((s) => s !== sv); } }
const registered = [], updated = [], unregistered = [];
const api = {
  hap: { Perms: { PAIRED_READ: 'pr', NOTIFY: 'ev' }, Service: S, Characteristic: C, uuid: { generate: (x) => x }, HapStatusError: class extends Error {}, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 } },
  platformAccessory: Acc, on() {}, user: { storagePath: () => require('os').tmpdir() },
  registerPlatformAccessories: (_p, _n, a) => registered.push(...a),
  updatePlatformAccessories: (a) => updated.push(...a),
  unregisterPlatformAccessories: (_p, _n, a) => unregistered.push(...a),
};
const log = Object.assign(() => {}, { info() {}, warn() {}, error(m) { throw new Error(m); }, debug() {} });
const mk = (cfg) => { const p = new VaillantHeatPumpPlatform(log, { username: 'a', password: 'b', ...cfg }, api); p.systemId = 'SYS1'; p.statusFile = require('path').join(require('os').tmpdir(), 'vhp-test.json'); return p; };

const p = mk({ allowControl: true });
const calls = [];
p.client = { setBoost: async (...a) => calls.push(a) };
const state = { outdoorC: 7.5, flowC: 33, cylinderTopC: 48, zones: [{ index: 0, name: 'Zone 1', roomC: 20.4 }], dhw: [{ index: 0, boost: true }], faults: [], running: true };
p.apply(state, true);

assert.strictEqual(registered.length, 1, 'one accessory holds everything');
const a = registered[0];
assert.strictEqual(a.displayName, 'Vaillant Heat Pump');
const parts = a.services.filter((s) => s.subtype).map((s) => s.name).sort();
assert.deepStrictEqual(parts, ['Vaillant Heat Pump Compressor State', 'Vaillant Heat Pump Fault Sensor', 'Vaillant Heating Flow Temperature', 'Vaillant Hot Water Boost', 'Vaillant Hot Water Temperature', 'Vaillant Outdoor Temperature', 'Vaillant Zone 1 Temperature']);
const part = (sub) => a.services.find((s) => s.subtype === sub);
assert.strictEqual(part('outdoor').chars.Temp.value, 7.5);
assert.strictEqual(part('fault').chars.Leak.value, 0);
assert.strictEqual(part('compressor').chars.On.value, true);
assert.strictEqual(part('compressor').chars.CN.value, 'Vaillant Heat Pump Compressor State', 'configured name set for the drill-in view');
assert.strictEqual(part('boost').chars.On.value, true);
assert.strictEqual(updated.length, 1, 'saved to the cache once');
assert.strictEqual(part('compressor').primary, true, 'compressor state is the front of the tile');
assert(!a.services.some((s) => s.subtype !== 'compressor' && s.primary), 'nothing else is primary');

p.apply({ ...state, faults: ['F.22 Low pressure'], running: false, dhw: [{ index: 0, boost: false }] }, true);
assert.strictEqual(registered.length, 1, 'no duplicates on a second poll');
assert.strictEqual(a.services.filter((s) => s.subtype === 'outdoor').length, 1, 'parts are reused, not added again');
assert.strictEqual(part('fault').chars.Leak.value, 1);
assert.strictEqual(part('compressor').chars.On.value, false);
p.apply(state, false);
assert.strictEqual(part('outdoor').chars.Fault.value, 1, 'cloud down shows as a fault on the parts');

// a removed zone and a turned-off boost switch drop their parts
const q = mk({ allowControl: false });
q.apply(state, true);
const qa = registered[1];
assert(!qa.services.some((s) => s.subtype === 'boost'), 'no boost switch unless asked for');
q.apply({ ...state, zones: [] }, true);
assert(!qa.services.some((s) => s.subtype === 'zone0'), 'a removed zone drops its part');

// the 0.1.x one-accessory-per-reading tiles are removed once the new one is live
const oldAcc = new Acc('Vaillant Outdoor Temperature', 'old-uuid');
const r = mk({}); r.accessories.set('old-uuid', oldAcc);
r.client = { homes: async () => [{ systemId: 'SYS1' }], system: async () => ({ state: { system: { outdoorTemperature: 5 } } }), troubleCodes: async () => [], mpc: async () => ({}), rts: async () => ({}), currentSystem: async () => ({}), buckets: async () => ({}) };
(async () => {
  await r.start(); clearInterval(r.timer); clearInterval(r.etimer);
  assert(unregistered.includes(oldAcc), 'old per-reading accessory unregistered');
  assert.deepStrictEqual(part('compressor').chars.On.props.perms, ['pr', 'ev'], 'compressor state is read-only (no write permission)');
  await part('boost').chars.On.sets(true);
  assert.deepStrictEqual(calls, [['SYS1', 0, true]]);
  console.log('platform checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
