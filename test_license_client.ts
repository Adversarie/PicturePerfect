/**
 * test_license_client.ts - Verification suite for Picture Perfect zero-server LicenseClient.
 */

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

  console.log('\n[SUCCESS] All 7 LicenseClient tests passed cleanly!');
  process.exit(0);
}

runTests().catch(err => {
  console.error('\n[FAILED]', err);
  process.exit(1);
});
