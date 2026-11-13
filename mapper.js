'use strict';
// Turns the cloud's JSON into plain readings. Pure functions, no network, so they can be tested.
// Key matching ignores case and punctuation, because the cloud's spelling varies (…TopDHW, …TopDhw).

const flat = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

function pick(obj, ...names) {
  if (!obj || typeof obj !== 'object') return undefined;
  const want = names.map(flat);
  for (const k of Object.keys(obj)) if (want.includes(flat(k))) return obj[k];
  return undefined;
}
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const list = (obj, ...names) => { const v = pick(obj, ...names); return Array.isArray(v) ? v : []; };
const byIndex = (arr, i) => arr.find((x) => Number(pick(x, 'index')) === i) || {};

function readSystem(doc) {
  const state = pick(doc, 'state') || {};
  const conf = pick(doc, 'configuration') || {};
  const sys = pick(state, 'system') || {};
  const out = {
    outdoorC: num(pick(sys, 'outdoorTemperature')),
    outdoorAvg24C: num(pick(sys, 'outdoorTemperatureAverage24h')),
    flowC: num(pick(sys, 'systemFlowTemperature')),
    pressureBar: num(pick(sys, 'systemWaterPressure')),
    cylinderTopC: num(pick(sys, 'cylinderTemperatureSensorTopDHW')),
    cylinderBottomC: num(pick(sys, 'cylinderTemperatureSensorBottomDHW')),
    zones: [], dhw: [], circuits: [],
  };
  const zs = list(state, 'zones');
  const zc = list(conf, 'zones');
  for (const z of zs) {
    const i = Number(pick(z, 'index'));
    const c = byIndex(zc, i);
    if (pick(z, 'isActive') === false || pick(c, 'isActive') === false) continue;
    const heating = pick(c, 'heating') || {};
    out.zones.push({
      index: i,
      name: pick(pick(c, 'general') || {}, 'name') || `Zone ${i + 1}`,
      roomC: num(pick(z, 'currentRoomTemperature')),
      setpointC: num(pick(z, 'desiredRoomTemperatureSetpoint', 'desiredRoomTemperatureSetpointHeating')),
      mode: pick(heating, 'operationModeHeating', 'operationMode') || pick(c, 'operationModeHeating'),
      heatingState: pick(z, 'heatingState'),
      special: pick(z, 'currentSpecialFunction'),
    });
  }
  for (const d of list(state, 'dhw')) {
    const i = Number(pick(d, 'index'));
    const c = byIndex(list(conf, 'dhw'), i);
    const special = String(pick(d, 'currentSpecialFunction') || '');
    out.dhw.push({
      index: i,
      tempC: num(pick(d, 'currentDhwTemperature')),
      setpointC: num(pick(c, 'tappingSetpoint')),
      mode: pick(c, 'operationModeDhw', 'operationMode'),
      boost: /boost/i.test(special),
      special,
    });
  }
  for (const c of list(state, 'circuits')) {
    out.circuits.push({
      index: Number(pick(c, 'index')),
      state: pick(c, 'circuitState'),
      flowC: num(pick(c, 'currentCircuitFlowTemperature')),
      flowSetpointC: num(pick(c, 'heatingCircuitFlowSetpoint')),
    });
  }
  if (out.flowC === undefined && out.circuits[0]) out.flowC = out.circuits[0].flowC;
  if (out.cylinderTopC === undefined && out.dhw[0]) out.cylinderTopC = out.dhw[0].tempC;
  return out;
}

// Fault codes from /diagnostic-trouble-codes: a list of { serialNumber, codes: [...] }.
function readFaults(dtc) {
  const rows = Array.isArray(dtc) ? dtc : list(dtc, 'diagnosticTroubleCodes', 'codes');
  const codes = [];
  for (const r of rows) {
    const cs = Array.isArray(r) ? r : list(r, 'codes');
    for (const c of cs) {
      if (typeof c === 'string' || typeof c === 'number') { codes.push(String(c)); continue; }
      const code = pick(c, 'code', 'diagnosticTroubleCode', 'errorCode', 'id');
      const text = pick(c, 'description', 'title', 'message');
      codes.push([code, text].filter(Boolean).join(' ') || JSON.stringify(c));
    }
  }
  return codes;
}

// Live electrical power: the hem/mpc endpoint, else the heat pump's rts statistics.
function readPower(mpc, rts) {
  let w;
  for (const d of list(mpc, 'devices')) {
    const p = num(pick(d, 'currentPower'));
    if (p !== undefined) w = (w || 0) + p;
  }
  if (w === undefined) {
    for (const s of list(rts, 'statistics')) {
      const p = num(pick(s, 'currentPowerConsumption'));
      if (p !== undefined) w = (w || 0) + p;
    }
  }
  const stats = list(rts, 'statistics')[0] || {};
  return { watts: w, onOffCycles: num(pick(stats, 'onOffCycles')), operationHours: num(pick(stats, 'operationTime')) };
}

// Heat pump devices out of /currentSystem, each with the energy series it offers.
function readDevices(cur) {
  const devices = [];
  const visit = (v) => {
    if (!v || typeof v !== 'object') return;
    if (pick(v, 'deviceUuid')) {
      devices.push({
        uuid: pick(v, 'deviceUuid'),
        name: pick(v, 'productName', 'name', 'deviceType') || 'Heat pump',
        series: list(v, 'data').map((d) => ({ operationMode: pick(d, 'operationMode'), energyType: pick(d, 'valueType') }))
          .filter((s) => s.operationMode && s.energyType),
      });
      return;
    }
    for (const x of Array.isArray(v) ? v : Object.values(v)) visit(x);
  };
  visit(cur);
  return devices;
}

// Daily energy: sum bucket values per series (watt-hours as the cloud reports them).
function sumBuckets(resp) {
  return list(resp, 'data').reduce((a, b) => a + (num(pick(b, 'value')) || 0), 0);
}

// COP = heat made / electricity used, using whichever series names say so. Names are logged at start-up
// so they can be checked against a real system.
function copOf(totals) {
  let used = 0, made = 0, haveUsed = false, haveMade = false;
  for (const [name, wh] of Object.entries(totals)) {
    if (/consum.*electr|electr.*consum/i.test(name)) { used += wh; haveUsed = true; }
    else if (/(heat.*generat|generat.*heat|heating.?energy|earned)/i.test(name) && !/environment/i.test(name)) { made += wh; haveMade = true; }
  }
  return haveUsed && haveMade && used > 0 ? Math.round((made / used) * 100) / 100 : undefined;
}

module.exports = { pick, flat, readSystem, readFaults, readPower, readDevices, sumBuckets, copOf };
