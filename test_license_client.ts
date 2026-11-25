/**
 * test_license_client.ts - Self-contained verification suite for Picture Perfect LicenseClient & MoR adapters.
 */

import * as crypto from 'crypto';

// In-memory localStorage polyfill for Node.js test runner
const store: Record<string, string> = {};
globalThis.localStorage = {
  getItem: (key: string) => store[key] || null,
  setItem: (key: string, val: string) => { store[key] = String(val); },
  removeItem: (key: string) => { delete store[key]; },
  clear: () => { Object.keys(store).forEach(k => delete store[k]); },
  key: (i: number) => Object.keys(store)[i] || null,
  length: 0,
} as any;

function generateEphemeralEd25519Keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const pubHex = spkiDer.subarray(-32).toString('hex');
  return { privateKey, pubHex };
}

function mintEphemeralPP1Token(privateKey: crypto.KeyObject, overrides: Record<string, any> = {}): string {
  const payload = {
    customer_email: 'owner@pictureperfect.click',
    customer_name: 'VIP Master Owner',
    expires_at: null,
    issued_at: '2026-11-03T00:00:00Z',
    license_id: 'vip_master_test',
    max_version: 1,
    plan: 'vip',
    product: 'picture-perfect',
    seats: 999,
    updates_until: '2099-12-31T23:59:59Z',
    ...overrides,
  };
  const sortedObj: Record<string, any> = {};
  for (const k of Object.keys(payload).sort()) sortedObj[k] = (payload as any)[k];
  const canonicalJson = JSON.stringify(sortedObj);
  const sig = crypto.sign(null, Buffer.from(canonicalJson), privateKey);
  const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `PP1.${b64url(Buffer.from(canonicalJson))}.${b64url(sig)}`;
}

async function runTests() {
  process.env.ALLOW_DEMO_KEY = 'true';
  const {
    LicenseClient,
    MockMorAdapter,
    PolarLicenseAdapter,
    DodoLicenseAdapter,
    validateSubscriptionEntitlement,
    isDemoKeyAllowed,
  } = await import('./src/lib/license');

  const { privateKey, pubHex } = generateEphemeralEd25519Keypair();

  console.log('[TEST] 1. Initial Unlicensed State...');
  const mockAdapter = new MockMorAdapter('pp_pro');
  mockAdapter.registerKey('PP-LIVE-0001', { maxSeats: 2, productId: 'pp_pro' });
  mockAdapter.registerKey('TWITCH-OTHER-01', { maxSeats: 2, productId: 'twitch_pro' });

  const client = new LicenseClient({ adapter: mockAdapter, publicKeyHex: pubHex });
  await client.init();
  const initStatus = client.getStatus();
  if (initStatus.valid !== false || initStatus.status !== 'trial') {
    throw new Error('Initial state must be trial/unlicensed');
  }
  console.log('  -> Passed.');

  console.log('\n[TEST] 2. Activating DEMO-KEY-123 in dev/test mode...');
  const actRes = await client.activate('DEMO-KEY-123', 'Studio-MacBook-Pro');
  if (!actRes.success || !actRes.status.valid || actRes.status.key_masked !== 'DEMO...-123') {
    throw new Error('Demo key activation must succeed when ALLOW_DEMO_KEY=true');
  }
  console.log('  -> Passed.');

  console.log('\n[TEST] 3. Encrypted/HMAC Vault Persistence & Rehydration...');
  const webVault = globalThis.localStorage.getItem('pictureperfect_license_vault_web');
  if (!webVault) throw new Error('Web vault envelope must be stored in localStorage');
  const rehydrated = new LicenseClient({ adapter: mockAdapter, publicKeyHex: pubHex });
  await rehydrated.init();
  if (!rehydrated.getStatus().valid) throw new Error('Rehydrated client must load active state from vault');
  await client.deactivate();
  if (globalThis.localStorage.getItem('pictureperfect_license_vault_web')) {
    throw new Error('Cache vault must be cleared after deactivation');
  }
  console.log('  -> Passed.');

  console.log('\n[TEST] 4. Production Mode Rejects DEMO-KEY-123...');
  delete process.env.ALLOW_DEMO_KEY;
  process.env.NODE_ENV = 'production';
  if (isDemoKeyAllowed()) throw new Error('isDemoKeyAllowed() must return false in production');
  const prodClient = new LicenseClient({ adapter: mockAdapter, publicKeyHex: pubHex });
  await prodClient.init();
  const prodAct = await prodClient.activate('DEMO-KEY-123', 'Prod-Workstation');
  if (prodAct.success || prodAct.status.valid) throw new Error('Production build must reject DEMO-KEY-123!');
  console.log('  -> Passed.');

  console.log('\n[TEST] 5. MockMorAdapter 2-Seat Cap, Cross-App Rejection & Offline Grace...');
  const seat1 = new LicenseClient({ adapter: mockAdapter, publicKeyHex: pubHex });
  await seat1.init();
  const r1 = await seat1.activate('PP-LIVE-0001', 'Desktop-1');
  if (!r1.success) throw new Error('Seat 1 must activate');

  const badProduct = new LicenseClient({ adapter: mockAdapter, publicKeyHex: pubHex });
  await badProduct.init();
  const rWrong = await badProduct.activate('TWITCH-OTHER-01', 'Desktop-Wrong');
  if (rWrong.success) throw new Error('Wrong product key must be rejected');

  const r2 = await mockAdapter.activate('PP-LIVE-0001', 'Laptop-2');
  if (!r2.activated) throw new Error('Seat 2 must activate');
  const r3 = await mockAdapter.activate('PP-LIVE-0001', 'Extra-3');
  if (r3.activated) throw new Error('Seat 3 must exceed 2-seat cap');

  mockAdapter.simulateOffline = true;
  const graceStatus = await seat1.validate();
  if (!graceStatus.valid || graceStatus.state !== 'LICENSED_OFFLINE_GRACE') {
    throw new Error(`Expected LICENSED_OFFLINE_GRACE when network unreachable, got ${graceStatus.state}`);
  }
  mockAdapter.simulateOffline = false;
  mockAdapter.setKeyStatus('PP-LIVE-0001', 'disabled');
  const disabledStatus = await seat1.validate();
  if (disabledStatus.valid || disabledStatus.state !== 'DISABLED') {
    throw new Error(`Expected DISABLED after revocation, got ${disabledStatus.state}`);
  }
  await seat1.deactivate();
  console.log('  -> Passed.');

  console.log('\n[TEST] 6. Polar & Dodo Adapter Wire-Format Verification...');
  const polarCalls: Array<{ url: string; body: any }> = [];
  const polarAdapter = new PolarLicenseAdapter({
    organizationId: 'org_123',
    expectedBenefitIds: ['ben_pp'],
    fetchImpl: async (url, init) => {
      const body = JSON.parse(String(init?.body || '{}'));
      polarCalls.push({ url, body });
      if (url.endsWith('/activate')) {
        return new Response(
          JSON.stringify({
            id: 'act_polar_1',
            label: body.label,
            license_key: { key: body.key, status: 'granted', benefit_id: 'ben_pp', expires_at: null },
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ status: 'granted', expires_at: null }), { status: 200 });
    },
  });
  const pAct = await polarAdapter.activate('POLAR-KEY-1', 'Workstation');
  if (!pAct.activated || pAct.instanceId !== 'act_polar_1' || polarCalls[0].body.organization_id !== 'org_123') {
    throw new Error('Polar activate wire mapping failed');
  }
  const pVal = await polarAdapter.validate('POLAR-KEY-1', 'act_polar_1');
  if (!pVal.valid) throw new Error('Polar validate wire mapping failed');

  const dodoAdapter = new DodoLicenseAdapter({
    businessId: 'bus_1',
    expectedProductIds: ['pdt_pp'],
    fetchImpl: async url => {
      if (url.endsWith('/activate')) {
        return new Response(
          JSON.stringify({
            id: 'lki_dodo_1',
            business_id: 'bus_1',
            product: { product_id: 'pdt_pp', name: 'Picture Perfect Pro' },
            customer: { email: 'dodo@example.com', name: 'Dodo User' },
            expires_at: null,
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ valid: true }), { status: 200 });
    },
  });
  const dAct = await dodoAdapter.activate('DODO-KEY-1', 'Workstation');
  if (!dAct.activated || dAct.instanceId !== 'lki_dodo_1') {
    throw new Error('Dodo activate wire mapping failed');
  }
  const dVal = await dodoAdapter.validate('DODO-KEY-1', 'lki_dodo_1');
  if (!dVal.valid) throw new Error('Dodo validate wire mapping failed');
  console.log('  -> Passed.');

  console.log('\n[TEST] 7. Self-Contained Ephemeral Ed25519 (PP1.) Offline Activation & Tamper Rejection...');
  const validPP1 = mintEphemeralPP1Token(privateKey);
  const armoredPP1 = `\n-----BEGIN PICTURE PERFECT LICENSE KEY-----\n${validPP1}\n-----END PICTURE PERFECT LICENSE KEY-----\n`;

  let fetchCallCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCallCount++;
    throw new Error('Network call must not occur during PP1 offline activation!');
  }) as any;

  const airgapClient = new LicenseClient({ adapter: mockAdapter, publicKeyHex: pubHex });
  await airgapClient.init();
  const pp1Act = await airgapClient.activate(armoredPP1, 'Air-Gapped-Studio');
  if (!pp1Act.success || !pp1Act.status.valid || fetchCallCount !== 0 || airgapClient.state !== 'LICENSED_ONLINE') {
    throw new Error('Valid PP1 token must activate offline with 0 network calls');
  }

  await airgapClient.deactivate();
  const tamperedPP1 = validPP1.slice(0, -4) + 'AAAA';
  const tamperedAct = await airgapClient.activate(tamperedPP1);
  if (tamperedAct.success || tamperedAct.status.valid) {
    throw new Error('Tampered PP1 token must be rejected');
  }

  await airgapClient.activate(validPP1);
  if (airgapClient.cachedLicense) {
    airgapClient.cachedLicense.last_validated_at = '2024-01-01T00:00:00Z';
    airgapClient.cachedLicense.last_observed_timestamp = Date.now();
  }
  const agedStatus = await airgapClient.validate();
  if (!agedStatus.valid || agedStatus.state !== 'LICENSED_ONLINE' || agedStatus.grace_days_left <= 7) {
    throw new Error('Master PP1 license must remain permanently valid offline');
  }

  await airgapClient.deactivate();
  process.env.PICTURE_PERFECT_LICENSE_KEY = validPP1;
  const autoClient = new LicenseClient({ adapter: mockAdapter, publicKeyHex: pubHex });
  await autoClient.init();
  if (!autoClient.getStatus().valid) {
    throw new Error('Auto-provisioned license from PICTURE_PERFECT_LICENSE_KEY failed');
  }
  delete process.env.PICTURE_PERFECT_LICENSE_KEY;
  globalThis.fetch = originalFetch;

  process.env.ALLOW_DEMO_KEY = 'true';
  const compat = await validateSubscriptionEntitlement('DEMO-KEY-123');
  if (!compat.valid || compat.tier !== 'pro') {
    throw new Error('Backwards-compatibility wrapper failed');
  }
  console.log('  -> Passed.');

  console.log('\n[SUCCESS] All Picture Perfect licensing & MoR adapter tests passed!');
  process.exit(0);
}

runTests().catch(err => {
  console.error('\n[FAILED]', err);
  process.exit(1);
});
