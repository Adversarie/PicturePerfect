/**
 * test_license_client.ts - Verification suite for Picture Perfect zero-server LicenseClient.
 */

import * as fs from 'fs';
import * as path from 'path';
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

async function runTests() {
  // Enable demo key for tests 1-6
  process.env.ALLOW_DEMO_KEY = 'true';
  const { LicenseClient, validateSubscriptionEntitlement, isDemoKeyAllowed } = await import('./src/lib/license');

  console.log('[TEST] 1. Initial Unlicensed State...');
  const client = new LicenseClient();
  await client.init();
  const initStatus = client.getStatus();
  console.log('  Status:', initStatus);
  if (initStatus.valid !== false || initStatus.status !== 'trial') {
    throw new Error('Initial state must be trial/unlicensed');
  }
  console.log('  -> Passed.');

  console.log('\n[TEST] 2. Activating DEMO-KEY-123 in dev/test mode...');
  const actRes = await client.activate('DEMO-KEY-123', 'Studio-MacBook-Pro');
  console.log('  Activation:', actRes);
  if (!actRes.success || !actRes.status.valid) {
    throw new Error('Demo key activation must succeed when ALLOW_DEMO_KEY=true');
  }
  if (actRes.status.key_masked !== 'DEMO...-123') {
    throw new Error(`Expected masked key DEMO...-123, got: ${actRes.status.key_masked}`);
  }
  if (!client.isAuthorized()) {
    throw new Error('Client should report isAuthorized() === true');
  }
  console.log('  -> Passed.');

  console.log('\n[TEST] 3. Verifying Encrypted/HMAC Vault Persistence...');
  const webVault = globalThis.localStorage.getItem('pictureperfect_license_vault_web');
  if (!webVault) {
    throw new Error('Web vault envelope must be stored in localStorage');
  }
  const parsedVault = JSON.parse(webVault);
  if (!parsedVault.sig || !parsedVault.payload) {
    throw new Error('Vault envelope must have sig and payload');
  }
  console.log('  Vault Signature:', parsedVault.sig.slice(0, 16) + '...');
  console.log('  -> Passed.');

  console.log('\n[TEST] 4. New Client Instance Rehydrates From Cache...');
  const rehydrated = new LicenseClient();
  await rehydrated.init();
  const rehydratedStatus = rehydrated.getStatus();
  if (!rehydratedStatus.valid || rehydratedStatus.status !== 'active') {
    throw new Error('Rehydrated client must load active state from vault');
  }
  console.log('  Rehydrated Plan:', rehydratedStatus.plan);
  console.log('  -> Passed.');

  console.log('\n[TEST] 5. Backwards Compatibility Wrapper...');
  const entitlement = await validateSubscriptionEntitlement('DEMO-KEY-123');
  if (!entitlement.valid || entitlement.tier !== 'pro') {
    throw new Error('Compatibility wrapper failed to activate demo entitlement');
  }
  console.log('  Entitlement:', entitlement);
  console.log('  -> Passed.');

  console.log('\n[TEST] 6. Deactivation & Seat Release...');
  const deactRes = await client.deactivate();
  console.log('  Deactivation:', deactRes);
  if (deactRes.status.valid !== false || deactRes.status.status !== 'trial') {
    throw new Error('Deactivation must return to unlicensed state');
  }
  if (globalThis.localStorage.getItem('pictureperfect_license_vault_web')) {
    throw new Error('Cache vault must be cleared after deactivation');
  }
  console.log('  -> Passed.');

  console.log('\n[TEST] 7. Production Mode Rejects DEMO-KEY-123...');
  delete process.env.ALLOW_DEMO_KEY;
  process.env.NODE_ENV = 'production';
  if (isDemoKeyAllowed()) {
    throw new Error('isDemoKeyAllowed() must return false in production');
  }
  const prodClient = new LicenseClient();
  await prodClient.init();
  const prodAct = await prodClient.activate('DEMO-KEY-123', 'Prod-Workstation');
  console.log('  Production Activation Result:', prodAct);
  if (prodAct.success || prodAct.status.valid) {
    throw new Error('Production build must reject DEMO-KEY-123!');
  }
  console.log('  -> Passed.');

  // Helper to mint valid Ed25519 PP1 tokens using local production private key
  function mintTestPP1Token(overrides: Record<string, any> = {}): string {
    let privHex = '';
    const secretPath = path.resolve('../PDF Portfolio App/.secrets/production_ed25519_private_key.txt');
    if (fs.existsSync(secretPath)) {
      const text = fs.readFileSync(secretPath, 'utf8');
      const m = text.match(/ED25519_PRIVATE_KEY_HEX=([0-9a-f]+)/i);
      if (m) privHex = m[1].trim();
    }
    if (!privHex) {
      throw new Error('Missing production private key for test token minting');
    }

    const pkcs8Der = Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.from(privHex, 'hex')
    ]);
    const privateKey = crypto.createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });

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
      ...overrides
    };

    const sortedKeys = Object.keys(payload).sort();
    const sortedObj: any = {};
    for (const k of sortedKeys) sortedObj[k] = (payload as any)[k];
    const canonicalJson = JSON.stringify(sortedObj);

    const sig = crypto.sign(null, Buffer.from(canonicalJson), privateKey);

    function b64url(buf: Buffer) {
      return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    return 'PP1.' + b64url(Buffer.from(canonicalJson)) + '.' + b64url(sig);
  }

  console.log('\n[TEST] 8. Offline/Air-Gapped (PP1.) Activation with Zero Network Calls...');
  const validPP1 = mintTestPP1Token();
  const armoredPP1 = `
    -----BEGIN PICTURE PERFECT LICENSE KEY-----
    ${validPP1}
    -----END PICTURE PERFECT LICENSE KEY-----
  `;

  let fetchCallCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCallCount++;
    throw new Error('Network call should not occur during PP1 offline activation!');
  }) as any;

  const airgapClient = new LicenseClient();
  await airgapClient.init();
  const pp1Act = await airgapClient.activate(armoredPP1, 'Air-Gapped-Studio');
  console.log('  PP1 Activation Result:', pp1Act);
  if (!pp1Act.success || !pp1Act.status.valid) {
    throw new Error('Valid PP1 token must activate successfully offline!');
  }
  if (fetchCallCount !== 0) {
    throw new Error(`Expected 0 fetch calls during PP1 activation, got: ${fetchCallCount}`);
  }
  if (airgapClient.state !== 'LICENSED_ONLINE') {
    throw new Error(`Expected LICENSED_ONLINE state, got: ${airgapClient.state}`);
  }
  globalThis.fetch = originalFetch;
  console.log('  -> Passed.');

  console.log('\n[TEST] 9. Rejection of Tampered PP1. License Tokens...');
  await airgapClient.deactivate();
  const tamperedPP1 = validPP1.slice(0, -4) + 'AAAA';
  const tamperedAct = await airgapClient.activate(tamperedPP1);
  console.log('  Tampered Activation Result:', tamperedAct);
  if (tamperedAct.success || tamperedAct.status.valid) {
    throw new Error('Tampered PP1 token must be rejected!');
  }
  console.log('  -> Passed.');

  console.log('\n[TEST] 10. Permanent Offline Validation Beyond 7-day Grace (>400 days)...');
  // Re-activate valid PP1 token
  await airgapClient.activate(validPP1);
  // Age the cache artificially by >400 days
  if (airgapClient.cachedLicense) {
    airgapClient.cachedLicense.last_validated_at = '2024-01-01T00:00:00Z';
    airgapClient.cachedLicense.last_observed_timestamp = Date.now();
  }
  // Disable network completely
  globalThis.fetch = (async () => {
    throw new Error('No internet connection in air-gapped studio!');
  }) as any;

  const validStatus = await airgapClient.validate();
  console.log('  Aged PP1 Validation Status:', validStatus);
  if (!validStatus.valid || validStatus.state !== 'LICENSED_ONLINE') {
    throw new Error('Master PP1 license must remain permanently valid regardless of elapsed time offline');
  }
  if (validStatus.grace_days_left <= 7) {
    throw new Error(`Expected permanent grace days for master key, got: ${validStatus.grace_days_left}`);
  }
  globalThis.fetch = originalFetch;
  console.log('  -> Passed.');

  console.log('\n[TEST] 11. Zero-Touch Custom Workflow Auto-Provisioning Hook...');
  await airgapClient.deactivate();
  // Simulate setting environment variable in automated workflow
  process.env.PICTURE_PERFECT_LICENSE_KEY = validPP1;

  const autoClient = new LicenseClient();
  await autoClient.init();
  const autoStatus = autoClient.getStatus();
  console.log('  Auto-Provisioned Status:', autoStatus);
  if (!autoStatus.valid || !autoClient.isAuthorized()) {
    throw new Error('Auto-provisioned license from environment variable failed to activate');
  }
  delete process.env.PICTURE_PERFECT_LICENSE_KEY;
  console.log('  -> Passed.');

  console.log('\n[SUCCESS] All 11 LicenseClient tests passed cleanly!');
  process.exit(0);
}

runTests().catch(err => {
  console.error('\n[FAILED]', err);
  process.exit(1);
});
