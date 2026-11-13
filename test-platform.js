'use strict';
// Runs the platform against a minimal stand-in for Homebridge and a fake client.
const assert = require('assert');
const plugin = require('./index.js');
const { VaillantHeatPumpPlatform } = plugin;

class Char { constructor() { this.value = undefined; this.sets = null; }
  setProps() { return this; } updateValue(v) { this.value = v; return this; } onSet(f) { this.sets = f; return this; } }
class Svc { constructor(t, n) { this.t = t; this.n = n; this.chars = {}; }
  getCharacteristic(c) { return (this.chars[c.id] ||= new Char()); }
  setCharacteristic(c, v) { this.getCharacteristic(c).value = v; return this; }
  updateCharacteristic(c, v) { this.getCharacteristic(c).value = v; return this; } }
const mkChar = (id, extra = {}) => Object.assign({ id }, extra);
const C = {
  Name: mkChar('Name'), CurrentTemperature: mkChar('Temp'), LeakDetected: mkChar('Leak', { LEAK_NOT_DETECTED: 0, LEAK_DETECTED: 1 }),
  OccupancyDetected: mkChar('Occ', { OCCUPANCY_DETECTED: 1, OCCUPANCY_NOT_DETECTED: 0 }), On: mkChar('On'),
  StatusFault: mkChar('Fault', { NO_FAULT: 0, GENERAL_FAULT: 1 }), Manufacturer: mkChar('Mf'), Model: mkChar('Mo'), SerialNumber: mkChar('Sn'),
};
const S = { TemperatureSensor: { id: 'TS' }, LeakSensor: { id: 'LS' }, ContactSensor: { id: 'CS' }, OccupancySensor: { id: 'OS' }, Switch: { id: 'SW' }, AccessoryInformation: { id: 'AI' } };
class Acc { constructor(n, u) { this.displayName = n; this.UUID = u; this.s = {}; }
  getService(t) { return this.s[t.id]; } removeService(sv) { for (const k of Object.keys(this.s)) if (this.s[k] === sv) delete this.s[k]; } addService(t, n) { return (this.s[t.id] = new Svc(t, n)); } }
const registered = [];
const api = {
  hap: { Service: S, Characteristic: C, uuid: { generate: (x) => x }, HapStatusError: class extends Error {}, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 } },
  platformAccessory: Acc, on() {}, user: { storagePath: () => require('os').tmpdir() },
  registerPlatformAccessories: (_p, _n, a) => registered.push(...a), unregisterPlatformAccessories() {},
};
const log = Object.assign(() => {}, { info() {}, warn() {}, error(m) { throw new Error(m); }, debug() {} });

const p = new VaillantHeatPumpPlatform(log, { username: 'a', password: 'b', allowControl: true, namePrefix: 'HP' }, api);
const calls = [];
p.client = { setBoost: async (...a) => calls.push(a) };
p.systemId = 'SYS1'; p.statusFile = require('path').join(require('os').tmpdir(), 'vhp-test.json');
const state = { outdoorC: 7.5, flowC: 33, cylinderTopC: 48, zones: [{ index: 0, name: 'Downstairs', roomC: 20.4 }], dhw: [{ index: 0, boost: true }], faults: [], running: true };
p.apply(state, true);
const names = registered.map((a) => a.displayName).sort();
assert.deepStrictEqual(names, ['HP Downstairs Temperature', 'HP Heat Pump Running', 'HP Heating Flow Temperature', 'HP Hot Water Boost', 'HP Hot Water Temperature', 'HP Outdoor Temperature', 'HP Vaillant Heat Pump Fault Sensor']);
const by = (n) => registered.find((a) => a.displayName === n);
assert.strictEqual(by('HP Outdoor Temperature').s.TS.chars.Temp.value, 7.5);
assert.strictEqual(by('HP Vaillant Heat Pump Fault Sensor').s.LS.chars.Leak.value, 0);
assert.strictEqual(by('HP Hot Water Boost').s.SW.chars.On.value, true);
p.apply({ ...state, faults: ['F.22 Low pressure'], running: false, dhw: [{ index: 0, boost: false }] }, true);
assert.strictEqual(registered.length, 7, 'no duplicates on second poll');
assert.strictEqual(by('HP Vaillant Heat Pump Fault Sensor').s.LS.chars.Leak.value, 1);
assert.strictEqual(by('HP Heat Pump Running').s.OS.chars.Occ.value, 0);
p.apply(state, false);
assert.strictEqual(by('HP Outdoor Temperature').s.TS.chars.Fault.value, 1, 'cloud down shows as fault on tiles');
{ // a 0.1.0 cached accessory with a contact sensor gets it replaced
  const old = new Acc('x', 'u'); old.addService(S.ContactSensor, 'old'); const q2 = new VaillantHeatPumpPlatform(log, { username: 'a', password: 'b' }, { ...api, registerPlatformAccessories() {} });
  q2.systemId = 'S'; const uuid = api.hap.uuid.generate('homebridge-vaillant-heatpump:S:fault'); old.UUID = uuid; q2.accessories.set(uuid, old); q2.apply(state, true);
  assert(!old.s.CS && old.s.LS, 'contact sensor removed, leak sensor added');
}
(async () => {
  await by('HP Hot Water Boost').s.SW.chars.On.sets(true);
  assert.deepStrictEqual(calls, [['SYS1', 0, true]]);
  // controls off by default: no switch
  const reg2 = []; const api2 = { ...api, registerPlatformAccessories: (_p, _n, a) => reg2.push(...a) };
  const q = new VaillantHeatPumpPlatform(log, { username: 'a', password: 'b' }, api2); q.systemId = 'S'; q.apply(state, true);
  assert(!reg2.some((a) => /Boost/.test(a.displayName)));
  console.log('platform checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
