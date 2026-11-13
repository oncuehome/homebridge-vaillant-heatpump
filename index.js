'use strict';

const fs = require('fs');
const path = require('path');
const { VaillantApi } = require('./api.js');
const M = require('./mapper.js');

const PLUGIN_NAME = 'homebridge-vaillant-heatpump';
const PLATFORM_NAME = 'VaillantHeatPump';
const RUNNING_WATTS = 100; // above this the compressor counts as running

class VaillantHeatPumpPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.accessories = new Map();
    this.live = new Set();
    this.last = null;
    this.energy = null;
    this.failures = 0;

    const c = this.config;
    if (!c.username || !c.password) {
      this.log.error('Set your myVAILLANT email and password in the plugin settings.');
      return;
    }
    this.pollMs = Math.max(60, Number(c.pollSeconds) || 120) * 1000;
    this.energyMs = Math.max(5, Number(c.energyMinutes) || 15) * 60 * 1000;
    this.allowControl = c.allowControl === true;
    this.client = new VaillantApi({
      username: c.username, password: c.password, brand: c.brand, country: c.country,
      log: (m) => this.log.debug(m),
    });
    this.statusFile = path.join(api.user.storagePath(), 'vaillant-heatpump-status.json');
    api.on('didFinishLaunching', () => this.start().catch((e) => this.log.error(`start-up failed: ${e.message}`)));
    api.on('shutdown', () => { clearInterval(this.timer); clearInterval(this.etimer); });
  }

  configureAccessory(accessory) { this.accessories.set(accessory.UUID, accessory); }

  async start() {
    const homes = await this.client.homes();
    const wanted = this.config.systemId;
    const home = (Array.isArray(homes) ? homes : []).find((h) => !wanted || (h.systemId || h.system_id) === wanted);
    this.systemId = home && (home.systemId || home.system_id);
    if (!this.systemId) throw new Error('no heating system found on this myVAILLANT account');
    this.log.info(`Found system ${this.systemId}${home.homeName ? ` (${home.homeName})` : ''}.`);
    await this.poll();
    await this.pollEnergy().catch((e) => this.log.warn(`energy not read: ${e.message}`));
    this.timer = setInterval(() => this.poll().catch(() => {}), this.pollMs);
    this.etimer = setInterval(() => this.pollEnergy().catch((e) => this.log.debug(`energy: ${e.message}`)), this.energyMs);
    // Remove accessories that are no longer in use (a zone removed, controls turned off).
    for (const [uuid, acc] of this.accessories) {
      if (!this.live.has(uuid)) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
        this.accessories.delete(uuid);
      }
    }
  }

  async poll() {
    try {
      const doc = await this.client.system(this.systemId);
      const [dtc, mpc, rts, cur] = await Promise.all([
        this.client.troubleCodes(this.systemId).catch(() => []),
        this.client.mpc(this.systemId).catch(() => ({})),
        this.client.rts(this.systemId).catch(() => ({})),
        this.devices ? null : this.client.currentSystem(this.systemId).catch(() => ({})),
      ]);
      if (cur) this.devices = M.readDevices(cur);
      const s = M.readSystem(doc);
      s.faults = M.readFaults(dtc);
      s.power = M.readPower(mpc, rts);
      s.running = s.power.watts !== undefined ? s.power.watts > RUNNING_WATTS : undefined;
      this.last = s;
      if (this.failures) this.log.info('Back in touch with the myVAILLANT cloud.');
      this.failures = 0;
      this.apply(s, true);
      this.writeStatus();
    } catch (e) {
      this.failures++;
      if (this.failures === 1 || this.failures % 30 === 0) this.log.warn(`myVAILLANT not reachable: ${e.message}`);
      if (this.last) this.apply(this.last, false);
    }
  }

  async pollEnergy() {
    if (!this.devices) return;
    const now = new Date();
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    const totals = {};
    for (const d of this.devices) {
      for (const s of d.series) {
        const r = await this.client.buckets(this.systemId, d.uuid, {
          resolution: 'DAY', operationMode: s.operationMode, energyType: s.energyType,
          start: start.toISOString(), end: now.toISOString(),
        }).catch(() => null);
        if (r) totals[`${s.energyType}/${s.operationMode}`] = M.sumBuckets(r);
      }
    }
    this.energy = { at: now.toISOString(), todayWh: totals, cop: M.copOf(totals) };
    if (!this.energyLogged) {
      this.energyLogged = true;
      this.log.info(`Energy series found: ${Object.keys(totals).join(', ') || 'none'}.`);
    }
    this.log.info(`Today so far: ${Object.entries(totals).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)} kWh`).join(', ') || 'no energy data'}${this.energy.cop ? `, COP ${this.energy.cop}` : ''}.`);
    this.writeStatus();
  }

  writeStatus() {
    try {
      const snap = { updated: new Date().toISOString(), systemId: this.systemId, ...this.last, energy: this.energy };
      fs.writeFileSync(this.statusFile + '.tmp', JSON.stringify(snap));
      fs.renameSync(this.statusFile + '.tmp', this.statusFile);
    } catch (e) { this.log.debug(`status file: ${e.message}`); }
  }

  // ---- accessories ----
  acc(id, name, setup) {
    const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${this.systemId}:${id}`);
    this.live.add(uuid);
    let a = this.accessories.get(uuid);
    if (!a) {
      a = new this.api.platformAccessory(name, uuid);
      setup(a);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [a]);
      this.accessories.set(uuid, a);
    }
    a.displayName = name;
    return a;
  }

  svc(a, type, name) {
    let s = a.getService(type);
    if (!s) { s = a.addService(type, name); }
    s.setCharacteristic(this.Characteristic.Name, name);
    return s;
  }

  info(a) {
    const i = a.getService(this.Service.AccessoryInformation) || a.addService(this.Service.AccessoryInformation);
    i.setCharacteristic(this.Characteristic.Manufacturer, 'Vaillant')
      .setCharacteristic(this.Characteristic.Model, 'myVAILLANT')
      .setCharacteristic(this.Characteristic.SerialNumber, String(this.systemId).slice(0, 16));
  }

  temp(id, name, c, ok) {
    const a = this.acc(id, name, () => {});
    this.info(a);
    const s = this.svc(a, this.Service.TemperatureSensor, name);
    const C = this.Characteristic;
    s.getCharacteristic(C.CurrentTemperature).setProps({ minValue: -50, maxValue: 100 });
    if (c !== undefined) s.updateCharacteristic(C.CurrentTemperature, Math.round(c * 10) / 10);
    s.updateCharacteristic(C.StatusFault, ok ? C.StatusFault.NO_FAULT : C.StatusFault.GENERAL_FAULT);
  }

  apply(s, ok) {
    const C = this.Characteristic;
    const pre = this.config.namePrefix ? `${this.config.namePrefix} ` : '';
    this.live.clear();
    if (s.outdoorC !== undefined) this.temp('outdoor', `${pre}Vaillant Outdoor Temperature`, s.outdoorC, ok);
    if (s.flowC !== undefined) this.temp('flow', `${pre}Vaillant Heating Flow Temperature`, s.flowC, ok);
    if (s.cylinderTopC !== undefined) this.temp('hotwater', `${pre}Vaillant Hot Water Temperature`, s.cylinderTopC, ok);
    for (const z of s.zones) if (z.roomC !== undefined) this.temp(`zone${z.index}`, `${pre}Vaillant ${z.name} Temperature`, z.roomC, ok);

    // Fault: an alarm (leak-type) sensor that trips when the heat pump reports any fault code,
    // so Apple Home sends an alarm notification, like the water plugin's leak sensors.
    {
      const name = `${pre}Vaillant Heat Pump Fault Sensor`;
      const a = this.acc('fault', name, () => {});
      this.info(a);
      const old = a.getService(this.Service.ContactSensor); // 0.1.0 used a contact sensor here
      if (old) a.removeService(old);
      const sv = this.svc(a, this.Service.LeakSensor, name);
      const fault = s.faults.length > 0;
      sv.updateCharacteristic(C.LeakDetected, fault ? C.LeakDetected.LEAK_DETECTED : C.LeakDetected.LEAK_NOT_DETECTED);
      sv.updateCharacteristic(C.StatusFault, ok ? C.StatusFault.NO_FAULT : C.StatusFault.GENERAL_FAULT);
      const key = s.faults.join('|');
      if (key !== this.lastFaults) {
        this.lastFaults = key;
        if (fault) this.log.warn(`Heat pump fault: ${s.faults.join('; ')}`);
        else if (this.faultSeen) this.log.info('Heat pump fault cleared.');
        if (fault) this.faultSeen = true;
      }
    }

    if (s.running !== undefined) {
      // A read-only switch: on while the compressor is drawing power. A tap flips straight back.
      const name = `${pre}Vaillant Heat Pump Compressor State`;
      const a = this.acc('running', name, () => {});
      this.info(a);
      const old = a.getService(this.Service.OccupancySensor); // 0.1.0 used an occupancy sensor here
      if (old) a.removeService(old);
      const sv = this.svc(a, this.Service.Switch, name);
      const on = sv.getCharacteristic(C.On);
      this.runningNow = s.running;
      if (!this.runningWired) {
        this.runningWired = true;
        on.onSet(() => { setTimeout(() => on.updateValue(this.runningNow), 300); });
      }
      on.updateValue(s.running);
      sv.updateCharacteristic(C.StatusFault, ok ? C.StatusFault.NO_FAULT : C.StatusFault.GENERAL_FAULT);
    }

    if (this.allowControl && s.dhw[0]) {
      const d = s.dhw[0];
      const name = `${pre}Vaillant Hot Water Boost`;
      const a = this.acc('boost', name, () => {});
      this.info(a);
      const sv = this.svc(a, this.Service.Switch, name);
      const on = sv.getCharacteristic(C.On);
      if (!this.boostWired) {
        this.boostWired = true;
        on.onSet(async (v) => {
          try {
            await this.client.setBoost(this.systemId, d.index, !!v);
            this.log.info(`Hot water boost ${v ? 'started' : 'cancelled'}.`);
          } catch (e) {
            this.log.error(`Hot water boost not changed: ${e.message}`);
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
          }
        });
      }
      on.updateValue(d.boost);
    }
  }
}

module.exports = (api) => { api.registerPlatform(PLATFORM_NAME, VaillantHeatPumpPlatform); };
module.exports.VaillantHeatPumpPlatform = VaillantHeatPumpPlatform;
