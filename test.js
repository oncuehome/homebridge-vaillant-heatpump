'use strict';
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { VaillantApi, realmOf, pkce, solveAltcha } = require('./api.js');
const M = require('./mapper.js');

let n = 0; const ok = (name) => console.log(`ok ${++n} - ${name}`);

// --- pure bits
assert.strictEqual(realmOf('vaillant', 'unitedkingdom'), 'vaillant-unitedkingdom-b2c');
assert.strictEqual(realmOf('bulex'), 'bulex-b2c'); ok('realm names');
const k = pkce();
assert.strictEqual(k.verifier.length, 128);
assert.strictEqual(k.challenge, crypto.createHash('sha256').update(k.verifier).digest('base64url')); ok('PKCE challenge');

{ // altcha: find a counter, then check the answer verifies
  const nonce = 'aabbccdd', salt = '0102030405060708';
  const target = crypto.pbkdf2Sync(Buffer.concat([Buffer.from(nonce, 'hex'), Buffer.from([0, 0, 0, 37])]), Buffer.from(salt, 'hex'), 50, 32, 'sha256');
  const prefix = target.subarray(0, 1).toString('hex');
  const out = JSON.parse(Buffer.from(solveAltcha({ parameters: { algorithm: 'PBKDF2/SHA-256', nonce, salt, cost: 50, keyLength: 32, keyPrefix: prefix }, signature: 'sig' }), 'base64'));
  const key = crypto.pbkdf2Sync(Buffer.concat([Buffer.from(nonce, 'hex'), Buffer.from([0, 0, 0, out.solution.counter])]), Buffer.from(salt, 'hex'), 50, 32, 'sha256');
  assert.strictEqual(key.toString('hex'), out.solution.derivedKey);
  assert(out.solution.derivedKey.startsWith(prefix)); assert.strictEqual(out.challenge.signature, 'sig'); ok('altcha proof of work');
}

// --- mapper
const doc = {
  state: {
    system: { outdoorTemperature: 7.5, systemFlowTemperature: 33.2, systemWaterPressure: 1.6, cylinderTemperatureSensorTopDHW: 48.5 },
    zones: [{ index: 0, currentRoomTemperature: 20.4, desiredRoomTemperatureSetpoint: 21, heatingState: 'IDLE', isActive: true }, { index: 1, isActive: false }],
    dhw: [{ index: 0, currentDhwTemperature: 47, currentSpecialFunction: 'CYLINDER_BOOST' }],
    circuits: [{ index: 0, circuitState: 'HEATING', currentCircuitFlowTemperature: 33.2 }],
  },
  configuration: { zones: [{ index: 0, general: { name: 'Downstairs' }, heating: { operationModeHeating: 'TIME_CONTROLLED' } }], dhw: [{ index: 0, tappingSetpoint: 50, operationModeDhw: 'TIME_CONTROLLED' }] },
};
const s = M.readSystem(doc);
assert.strictEqual(s.outdoorC, 7.5); assert.strictEqual(s.cylinderTopC, 48.5);
assert.strictEqual(s.zones.length, 1); assert.strictEqual(s.zones[0].name, 'Downstairs'); assert.strictEqual(s.zones[0].mode, 'TIME_CONTROLLED');
assert.strictEqual(s.dhw[0].boost, true); assert.strictEqual(s.dhw[0].setpointC, 50); ok('system readings (zones, hot water, boost)');
assert.strictEqual(M.readSystem({ state: { system: { cylinderTemperatureSensorTopDhw: 40 } } }).cylinderTopC, 40); ok('key spelling variants');
assert.deepStrictEqual(M.readSystem({}).zones, []); ok('empty document does not throw');
assert.deepStrictEqual(M.readFaults([]), []);
assert.deepStrictEqual(M.readFaults([{ serialNumber: 'x', codes: [{ code: 'F.22', description: 'Low pressure' }, 'F.75'] }]), ['F.22 Low pressure', 'F.75']); ok('fault codes');
assert.strictEqual(M.readPower({ devices: [{ currentPower: 850 }, { currentPower: 50 }] }, {}).watts, 900);
assert.strictEqual(M.readPower({}, { statistics: [{ currentPowerConsumption: 30, onOffCycles: 5, operationTime: 100 }] }).watts, 30); ok('power fallback');
const devs = M.readDevices({ primaryHeatGenerator: { deviceUuid: 'u1', productName: 'aroTHERM', data: [{ operationMode: 'HEATING', valueType: 'CONSUMED_ELECTRICAL_ENERGY' }, { operationMode: 'HEATING' }] }, secondaryHeatGenerators: [{ deviceUuid: 'u2' }] });
assert.strictEqual(devs.length, 2); assert.strictEqual(devs[0].series.length, 1); ok('devices and energy series');
assert.strictEqual(M.sumBuckets({ data: [{ value: 1000 }, { value: 2500 }] }), 3500);
assert.strictEqual(M.copOf({ 'CONSUMED_ELECTRICAL_ENERGY/HEATING': 2000, 'HEAT_GENERATED/HEATING': 7000 }), 3.5);
assert.strictEqual(M.copOf({ 'CONSUMED_ELECTRICAL_ENERGY/HEATING': 2000 }), undefined); ok('sum and COP');

// --- login and requests against a fake Vaillant
(async () => {
  const realm = 'vaillant-unitedkingdom-b2c';
  const seen = { auth: 0, login: 0, token: 0, refresh: 0, api: [], form: null, tokenForm: null };
  let challengeParams = null, verifierChallenge = null, expiresIn = 300;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (u.pathname === `/auth/realms/${realm}/protocol/openid-connect/auth`) {
        seen.auth++; verifierChallenge = u.searchParams.get('code_challenge');
        assert.strictEqual(u.searchParams.get('client_id'), 'myvaillant');
        res.writeHead(200, { 'Set-Cookie': ['AUTH_SESSION_ID=abc; Path=/; HttpOnly', 'KC_RESTART=def; Path=/'] });
        return res.end(`<form action="http://127.0.0.1:${srv.address().port}/auth/realms/${realm}/login-actions/authenticate?session_code=1&amp;execution=2&amp;tab_id=3" method="post">`);
      }
      if (u.pathname === '/api/altcha/challenge') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ parameters: challengeParams, signature: 'sig' }));
      }
      if (u.pathname === `/auth/realms/${realm}/login-actions/authenticate`) {
        seen.login++; seen.form = new URLSearchParams(body);
        assert.strictEqual(u.searchParams.get('session_code'), '1'); assert.strictEqual(u.searchParams.get('tab_id'), '3');
        assert(String(req.headers.cookie).includes('AUTH_SESSION_ID=abc'), 'cookies sent back');
        if (seen.form.get('password') !== 'right') { res.writeHead(200); return res.end('bad login page'); }
        res.writeHead(302, { Location: 'enduservaillant.page.link://login?code=THECODE&state=x' }); return res.end();
      }
      if (u.pathname === `/auth/realms/${realm}/protocol/openid-connect/token`) {
        const f = new URLSearchParams(body);
        if (f.get('grant_type') === 'refresh_token') { seen.refresh++; assert.strictEqual(f.get('refresh_token'), 'R1'); }
        else {
          seen.token++; seen.tokenForm = f;
          assert.strictEqual(f.get('code'), 'THECODE');
          assert.strictEqual(crypto.createHash('sha256').update(f.get('code_verifier')).digest('base64url'), verifierChallenge, 'verifier matches challenge');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ access_token: `T${seen.token}${seen.refresh}`, refresh_token: 'R1', expires_in: expiresIn }));
      }
      seen.api.push({ m: req.method, p: u.pathname, auth: req.headers.authorization, key: req.headers['ocp-apim-subscription-key'], ua: req.headers['user-agent'] });
      if (u.pathname.endsWith('/homes')) { res.writeHead(200); return res.end(JSON.stringify([{ systemId: 'SYS1' }])); }
      if (u.pathname.endsWith('/control-identifier')) { res.writeHead(200); return res.end(JSON.stringify({ controlIdentifier: 'TLI' })); }
      if (u.pathname.endsWith('/tli')) { res.writeHead(200); return res.end(JSON.stringify({ state: { dhw: [{ index: 0 }] }, configuration: {} }).replace('"dhw"', '"domesticHotWater"')); }
      if (u.pathname.endsWith('/boost')) { res.writeHead(202); return res.end(''); }
      if (u.pathname.endsWith('/401')) { res.writeHead(401); return res.end('no'); }
      res.writeHead(404); res.end('nope');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const mk = (pw) => new VaillantApi({ username: 'me@example.com', password: pw, identityBase: base, apiBase: `${base}/api`, timeoutMs: 5000 });

  challengeParams = { algorithm: 'PBKDF2/SHA-256', nonce: '0a', salt: '0b', cost: 20, keyLength: 32, keyPrefix: '' };
  const a = mk('right');
  await a.login();
  assert.strictEqual(seen.form.get('username'), 'me@example.com'); assert(seen.form.get('altcha'), 'altcha sent'); assert.strictEqual(seen.form.get('credentialId'), '');
  ok('login: cookies, form, altcha, PKCE verifier all line up');

  const homes = await a.homes();
  assert.strictEqual(homes[0].systemId, 'SYS1');
  assert(seen.api[0].auth.startsWith('Bearer T')); assert.strictEqual(seen.api[0].key.length, 32); assert.strictEqual(seen.api[0].ua, 'okhttp/4.9.2'); ok('API headers');
  assert.strictEqual(await a.controlIdentifier('SYS1'), 'tli');
  const sys = await a.system('SYS1');
  assert(sys.state.dhw, 'hot water name unified'); ok('control type and system read; hot water naming unified');
  await a.setBoost('SYS1', 0, true); await a.setBoost('SYS1', 0, false).catch(() => {});
  assert(seen.api.some((x) => x.m === 'POST' && x.p.endsWith('/domestic-hot-water/0/boost')));
  assert(seen.api.some((x) => x.m === 'DELETE' && x.p.endsWith('/domestic-hot-water/0/boost'))); ok('boost on (POST) and off (DELETE)');

  a.token.expiresAt = Date.now() - 1; await a.homes();
  assert.strictEqual(seen.refresh, 1); ok('token refresh when about to expire');

  const before = seen.token; a.token.access_token = 'stale';
  await assert.rejects(() => a.request('GET', `${base}/api/401`), /404|401/);
  assert(seen.token > before, 'logged in again after a 401'); ok('401 triggers a fresh login once');

  await assert.rejects(() => mk('wrong').login(), /login failed/); ok('wrong password gives a clear error');
  srv.close();
  console.log(`\n${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
