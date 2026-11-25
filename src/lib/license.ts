/**
 * Commercial Licensing & License Vault Engine for Picture Perfect.
 * Owns DPAPI safeStorage encryption, Web Crypto HMAC-SHA256 fallback,
 * 7-day sliding Offline Grace Period, clock-tamper guard, and Ed25519 PP1 verification,
 * delegating online Merchant of Record calls across a swappable adapter seam.
 */

import { createMorAdapterFromEnv, MerchantOfRecordAdapter } from './morAdapters';

export type { MerchantOfRecordAdapter } from './morAdapters';
export {
  PolarLicenseAdapter,
  DodoLicenseAdapter,
  LemonSqueezyLicenseAdapter,
  MockMorAdapter,
  createMorAdapterFromEnv,
} from './morAdapters';

export type LicenseState =
  | 'LICENSED_ONLINE'
  | 'LICENSED_OFFLINE_GRACE'
  | 'UNLICENSED'
  | 'EXPIRED'
  | 'DISABLED'
  | 'GRACE_EXPIRED'
  | 'CLOCK_TAMPERED';

export interface CachedLicenseData {
  license_key: string;
  instance_id: string;
  instance_name: string;
  customer_email?: string;
  customer_name?: string;
  product_id?: string | number;
  store_id?: string | number;
  status: string;
  expires_at?: string | null;
  last_validated_at: string;
  last_observed_timestamp: number;
  offline_permanent?: boolean;
  plan?: string;
  seats?: number;
}

export interface LicenseStatus {
  valid: boolean;
  state: LicenseState;
  status: 'active' | 'trial' | 'expired' | 'disabled';
  plan: string;
  key_masked: string | null;
  instance_id: string | null;
  customer_email?: string | null;
  expires_at?: string | null;
  grace_days_left: number;
  checkout_url: string;
  portal_url: string;
  merchant_name: string;
}

export interface EntitlementStatus {
  valid: boolean;
  status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'inactive';
  tier?: string;
  customerId?: string;
  licenseKey?: string;
  message?: string;
}

const OFFLINE_GRACE_DAYS = 7;
const OFFLINE_GRACE_MS = OFFLINE_GRACE_DAYS * 24 * 60 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 12 * 60 * 60 * 1000;

export function isDemoKeyAllowed(): boolean {
  const viteEnv = (import.meta as any).env || {};
  if (viteEnv.DEV === true || viteEnv.VITE_ALLOW_DEMO_KEY === 'true') {
    return true;
  }
  if (typeof process !== 'undefined' && process.env) {
    if (process.env.NODE_ENV === 'development' || process.env.ALLOW_DEMO_KEY === 'true') {
      return true;
    }
  }
  return false;
}

export const EMBEDDED_PUBLIC_KEY_HEX = '209850db3e18e6840d4a357cc82562ff0e7f05645d6c7020becd237cf6b6972b';

export function extractPP1Token(rawInput: string): string | null {
  if (!rawInput || typeof rawInput !== 'string') return null;
  const match = rawInput.match(/PP1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/);
  return match ? match[0] : null;
}

function b64urlDecode(str: string): Uint8Array {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export interface PP1VerificationResult {
  valid: boolean;
  message: string;
  payload?: any;
}

export async function verifyPP1TokenOffline(
  tokenOrBlock: string,
  publicKeyHex: string = EMBEDDED_PUBLIC_KEY_HEX
): Promise<PP1VerificationResult> {
  const token = extractPP1Token(tokenOrBlock);
  if (!token) {
    return { valid: false, message: 'Missing PP1 prefix or malformed token structure.' };
  }

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'PP1') {
    return { valid: false, message: 'Invalid PP1 token segments.' };
  }

  let payloadBytes: Uint8Array;
  let signatureBytes: Uint8Array;
  try {
    payloadBytes = b64urlDecode(parts[1]);
    signatureBytes = b64urlDecode(parts[2]);
  } catch {
    return { valid: false, message: 'Failed to decode Base64URL token.' };
  }

  if (signatureBytes.length !== 64) {
    return { valid: false, message: `Invalid signature length (${signatureBytes.length} bytes; expected 64).` };
  }

  try {
    const pubBytes = new Uint8Array(
      publicKeyHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16))
    );
    const subtle = (globalThis as any).crypto?.subtle;
    if (!subtle) {
      return { valid: false, message: 'Web Crypto subtle API is not available in runtime.' };
    }

    const key = await subtle.importKey('raw', pubBytes, { name: 'Ed25519' }, false, ['verify']);
    const isValid = await subtle.verify('Ed25519', key, signatureBytes, payloadBytes);
    if (!isValid) {
      return {
        valid: false,
        message: 'Cryptographic signature verification failed (tampered key or invalid signature).',
      };
    }
  } catch (err: any) {
    return { valid: false, message: `Ed25519 cryptographic verification error: ${err?.message || err}` };
  }

  let payload: any;
  try {
    const text = new TextDecoder().decode(payloadBytes);
    payload = JSON.parse(text);
  } catch {
    return { valid: false, message: 'Corrupted license payload data.' };
  }

  if (payload.product !== 'picture-perfect') {
    return {
      valid: false,
      message: `License was issued for '${payload.product}', not Picture Perfect.`,
      payload,
    };
  }

  if (payload.expires_at) {
    try {
      const expDate = new Date(payload.expires_at).getTime();
      if (Date.now() > expDate) {
        return { valid: false, message: `License expired on ${payload.expires_at}.`, payload };
      }
    } catch {
      return { valid: false, message: 'Malformed expires_at date in license.', payload };
    }
  }

  return {
    valid: true,
    message: 'Master VIP / Air-Gapped license valid and active.',
    payload,
  };
}

export async function getAutoProvisionedKey(): Promise<string | null> {
  const ipc = getElectronIpc();
  if (ipc) {
    try {
      const key = await ipc.invoke('license:getAutoProvisionedKey');
      if (key && typeof key === 'string' && key.trim()) {
        return key.trim();
      }
    } catch {}
  }

  if (typeof process !== 'undefined' && process.env?.PICTURE_PERFECT_LICENSE_KEY) {
    const k = process.env.PICTURE_PERFECT_LICENSE_KEY.trim();
    if (k) return k;
  }

  return null;
}

function getElectronIpc(): any {
  if (typeof window !== 'undefined') {
    try {
      if ((window as any).require) {
        const { ipcRenderer } = (window as any).require('electron');
        return ipcRenderer;
      }
    } catch {}
  }
  return null;
}

function getMachineFingerprint(): string {
  if (typeof window === 'undefined') return 'headless_node_runtime';
  const parts = [
    typeof navigator !== 'undefined' ? navigator.userAgent : '',
    typeof navigator !== 'undefined' ? navigator.language : '',
    typeof screen !== 'undefined' ? `${screen.width}x${screen.height}x${screen.colorDepth}` : '',
    typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : '',
  ];
  return parts.join('|');
}

async function computeHmacSha256(keyStr: string, dataStr: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(keyStr);
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(dataStr));
    return Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
  let hash = 0;
  for (let i = 0; i < dataStr.length; i++) {
    hash = (hash << 5) - hash + dataStr.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

async function saveEncryptedCache(data: CachedLicenseData): Promise<void> {
  const jsonStr = JSON.stringify(data);
  const ipc = getElectronIpc();

  if (ipc) {
    try {
      const isAvailable = await ipc.invoke('license:isSafeStorageAvailable');
      if (isAvailable) {
        const encryptedBase64 = await ipc.invoke('license:encrypt', jsonStr);
        if (encryptedBase64) {
          localStorage.setItem('pictureperfect_license_vault_secure', encryptedBase64);
          localStorage.removeItem('pictureperfect_license_vault_web');
          return;
        }
      }
    } catch (e) {
      console.warn('[LicenseClient] Electron safeStorage failed, falling back to Web Crypto HMAC:', e);
    }
  }

  try {
    const fingerprint = getMachineFingerprint();
    const sig = await computeHmacSha256(fingerprint, jsonStr);
    const envelope = JSON.stringify({ sig, payload: jsonStr });
    localStorage.setItem('pictureperfect_license_vault_web', envelope);
    localStorage.removeItem('pictureperfect_license_vault_secure');
  } catch (e) {
    console.error('[LicenseClient] Failed to persist license cache:', e);
  }
}

async function loadEncryptedCache(): Promise<CachedLicenseData | null> {
  if (typeof localStorage === 'undefined') return null;

  const ipc = getElectronIpc();
  const secureCipher = localStorage.getItem('pictureperfect_license_vault_secure');
  if (secureCipher && ipc) {
    try {
      const decrypted = await ipc.invoke('license:decrypt', secureCipher);
      if (decrypted) return JSON.parse(decrypted);
    } catch (e) {
      console.warn('[LicenseClient] Failed to decrypt safeStorage cache:', e);
    }
  }

  const webEnvelopeStr = localStorage.getItem('pictureperfect_license_vault_web');
  if (webEnvelopeStr) {
    try {
      const envelope = JSON.parse(webEnvelopeStr);
      const fingerprint = getMachineFingerprint();
      const expectedSig = await computeHmacSha256(fingerprint, envelope.payload);
      if (envelope.sig === expectedSig) {
        return JSON.parse(envelope.payload);
      }
      console.warn('[LicenseClient] License cache HMAC mismatch! File was tampered with or moved.');
    } catch (e) {
      console.warn('[LicenseClient] Failed to verify web license vault:', e);
    }
  }

  return null;
}

function clearEncryptedCache(): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('pictureperfect_license_vault_secure');
    localStorage.removeItem('pictureperfect_license_vault_web');
    localStorage.removeItem('pictureperfect_pro_entitlement');
  }
}

function evaluateOfflineGrace(cached: CachedLicenseData): { state: LicenseState; graceDaysLeft: number } {
  const now = Date.now();
  if (now < cached.last_observed_timestamp - 3600000) {
    return { state: 'CLOCK_TAMPERED', graceDaysLeft: 0 };
  }

  const lastValidated = new Date(cached.last_validated_at).getTime();
  const elapsed = now - lastValidated;
  const remainingMs = OFFLINE_GRACE_MS - elapsed;

  if (remainingMs > 0) {
    const daysLeft = Math.max(0, Math.round((remainingMs / (24 * 60 * 60 * 1000)) * 10) / 10);
    return { state: 'LICENSED_OFFLINE_GRACE', graceDaysLeft: daysLeft };
  }
  return { state: 'GRACE_EXPIRED', graceDaysLeft: 0 };
}

export interface LicenseClientOptions {
  adapter?: MerchantOfRecordAdapter;
  publicKeyHex?: string;
}

export class LicenseClient {
  public state: LicenseState = 'UNLICENSED';
  public cachedLicense: CachedLicenseData | null = null;
  private readonly adapter: MerchantOfRecordAdapter;
  private readonly publicKeyHex: string;
  private heartbeatTimer: any = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(options: LicenseClientOptions = {}) {
    const env = (import.meta as any).env || {};
    this.adapter = options.adapter || createMorAdapterFromEnv(env);
    this.publicKeyHex = options.publicKeyHex || EMBEDDED_PUBLIC_KEY_HEX;
  }

  public async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      this.cachedLicense = await loadEncryptedCache();

      if (this.cachedLicense?.license_key) {
        if (this.cachedLicense.license_key === 'DEMO-KEY-123') {
          if (isDemoKeyAllowed()) {
            this.state = 'LICENSED_ONLINE';
          } else {
            clearEncryptedCache();
            this.cachedLicense = null;
            this.state = 'UNLICENSED';
          }
        } else if (this.cachedLicense.offline_permanent || this.cachedLicense.license_key.startsWith('PP1.')) {
          const verifyRes = await verifyPP1TokenOffline(this.cachedLicense.license_key, this.publicKeyHex);
          this.state = verifyRes.valid ? 'LICENSED_ONLINE' : 'EXPIRED';
        } else {
          this.state = evaluateOfflineGrace(this.cachedLicense).state;
        }
        if (this.cachedLicense && this.isAuthorized()) {
          this.startBackgroundHeartbeat();
        }
      } else {
        this.state = 'UNLICENSED';
      }

      this.initialized = true;

      if (!this.isAuthorized()) {
        try {
          const autoKey = await getAutoProvisionedKey();
          if (autoKey) {
            await this.activate(autoKey);
          }
        } catch {}
      }
    })();

    return this.initPromise;
  }

  public getCheckoutUrl(): string {
    return this.adapter.checkoutUrl;
  }

  public getPortalUrl(): string {
    return this.adapter.portalUrl;
  }

  public getMerchantName(): string {
    return this.adapter.merchantName;
  }

  public isAuthorized(): boolean {
    return this.state === 'LICENSED_ONLINE' || this.state === 'LICENSED_OFFLINE_GRACE';
  }

  public getStatus(): LicenseStatus {
    const isAuth = this.isAuthorized();
    const key = this.cachedLicense?.license_key || '';
    const maskedKey = key.length >= 12 ? `${key.slice(0, 4)}...${key.slice(-4)}` : key || null;

    let graceDays = 0;
    if (this.cachedLicense?.offline_permanent || key.startsWith('PP1.')) {
      graceDays = 99999;
    } else if (this.state === 'LICENSED_OFFLINE_GRACE' && this.cachedLicense) {
      graceDays = evaluateOfflineGrace(this.cachedLicense).graceDaysLeft;
    }

    const defaultPlan =
      this.cachedLicense?.offline_permanent || key.startsWith('PP1.')
        ? 'Pro Subscriber (Air-Gapped Master)'
        : 'Pro Subscriber';

    return {
      valid: isAuth,
      state: this.state,
      status: isAuth ? 'active' : this.state === 'UNLICENSED' ? 'trial' : 'expired',
      plan: isAuth ? this.cachedLicense?.plan || defaultPlan : 'Trial Mode',
      key_masked: maskedKey,
      instance_id: this.cachedLicense?.instance_id || null,
      customer_email: this.cachedLicense?.customer_email || null,
      expires_at: this.cachedLicense?.expires_at || null,
      grace_days_left: graceDays,
      checkout_url: this.adapter.checkoutUrl,
      portal_url: this.adapter.portalUrl,
      merchant_name: this.adapter.merchantName,
    };
  }

  public async activate(
    licenseKey: string,
    instanceName?: string
  ): Promise<{ success: boolean; message: string; status: LicenseStatus }> {
    if (!this.initialized) {
      await this.init();
    }
    const cleanKey = licenseKey?.trim() || '';
    if (!cleanKey) {
      return { success: false, message: 'License key cannot be empty.', status: this.getStatus() };
    }

    if (cleanKey === 'DEMO-KEY-123') {
      if (!isDemoKeyAllowed()) {
        return {
          success: false,
          message: 'Invalid license key. Developer demo keys are disabled in production builds.',
          status: this.getStatus(),
        };
      }
      const cached: CachedLicenseData = {
        license_key: 'DEMO-KEY-123',
        instance_id: 'demo-pictureperfect-uuid',
        instance_name: instanceName || 'Demo-Studio-Workstation',
        customer_email: 'demo@pictureperfect.click',
        customer_name: 'Demo Photographer',
        product_id: 'demo',
        store_id: 'demo',
        status: 'active',
        expires_at: '2099-01-01T00:00:00Z',
        last_validated_at: new Date().toISOString(),
        last_observed_timestamp: Date.now(),
      };
      await saveEncryptedCache(cached);
      this.cachedLicense = cached;
      this.state = 'LICENSED_ONLINE';
      return { success: true, message: 'Demo license activated successfully!', status: this.getStatus() };
    }

    const pp1Token = extractPP1Token(cleanKey);
    if (pp1Token) {
      const pp1Res = await verifyPP1TokenOffline(pp1Token, this.publicKeyHex);
      if (!pp1Res.valid) {
        return { success: false, message: pp1Res.message, status: this.getStatus() };
      }

      const p = pp1Res.payload || {};
      const cached: CachedLicenseData = {
        license_key: pp1Token,
        instance_id: p.license_id || 'vip_master_seat',
        instance_name: instanceName || 'Air-Gapped-Workstation',
        customer_email: p.customer_email || 'owner@pictureperfect.click',
        customer_name: p.customer_name || 'VIP Master Licensee',
        product_id: 'picture-perfect',
        store_id: 'offline-ed25519',
        status: 'active',
        expires_at: p.expires_at || null,
        last_validated_at: new Date().toISOString(),
        last_observed_timestamp: Date.now(),
        offline_permanent: true,
        plan: p.plan === 'vip' ? 'VIP Master Edition' : 'Pro Subscriber',
        seats: p.seats || 999,
      };

      await saveEncryptedCache(cached);
      this.cachedLicense = cached;
      this.state = 'LICENSED_ONLINE';
      return {
        success: true,
        message: 'Master VIP / Air-Gapped license activated successfully!',
        status: this.getStatus(),
      };
    }

    const instName =
      instanceName?.trim() ||
      (typeof navigator !== 'undefined'
        ? `PicturePerfect-${navigator.platform || 'Workstation'}`
        : 'PicturePerfect-Workstation');

    const res = await this.adapter.activate(cleanKey, instName);
    if (res.networkError) {
      return {
        success: false,
        message: `Network error: ${res.networkError}`,
        status: this.getStatus(),
      };
    }
    if (!res.activated) {
      return {
        success: false,
        message: res.error || 'License activation failed.',
        status: this.getStatus(),
      };
    }

    const cached: CachedLicenseData = {
      license_key: res.licenseKey || cleanKey,
      instance_id: res.instanceId || 'inst_' + Math.random().toString(36).substring(2, 10),
      instance_name: res.instanceName || instName,
      customer_email: res.customerEmail,
      customer_name: res.customerName,
      product_id: res.productId,
      store_id: res.storeId,
      status: res.status || 'active',
      expires_at: res.expiresAt || null,
      last_validated_at: new Date().toISOString(),
      last_observed_timestamp: Date.now(),
    };

    await saveEncryptedCache(cached);
    this.cachedLicense = cached;
    this.state = 'LICENSED_ONLINE';
    this.startBackgroundHeartbeat();

    return { success: true, message: 'License activated successfully!', status: this.getStatus() };
  }

  public async validate(): Promise<LicenseStatus> {
    await this.init();
    if (!this.cachedLicense?.license_key) {
      this.state = 'UNLICENSED';
      return this.getStatus();
    }

    if (this.cachedLicense.license_key === 'DEMO-KEY-123') {
      if (isDemoKeyAllowed()) {
        this.state = 'LICENSED_ONLINE';
      } else {
        clearEncryptedCache();
        this.cachedLicense = null;
        this.state = 'UNLICENSED';
      }
      return this.getStatus();
    }

    if (this.cachedLicense.offline_permanent || this.cachedLicense.license_key.startsWith('PP1.')) {
      const pp1Res = await verifyPP1TokenOffline(this.cachedLicense.license_key, this.publicKeyHex);
      if (pp1Res.valid) {
        this.state = 'LICENSED_ONLINE';
        this.cachedLicense.last_validated_at = new Date().toISOString();
        this.cachedLicense.last_observed_timestamp = Date.now();
        await saveEncryptedCache(this.cachedLicense);
        return this.getStatus();
      }
      this.state = 'EXPIRED';
      return this.getStatus();
    }

    const currentNow = Date.now();
    if (currentNow < this.cachedLicense.last_observed_timestamp - 3600000) {
      this.state = 'CLOCK_TAMPERED';
      return this.getStatus();
    }
    this.cachedLicense.last_observed_timestamp = Math.max(
      this.cachedLicense.last_observed_timestamp,
      currentNow
    );

    const res = await this.adapter.validate(this.cachedLicense.license_key, this.cachedLicense.instance_id);
    if (res.networkError) {
      this.state = evaluateOfflineGrace(this.cachedLicense).state;
      return this.getStatus();
    }

    if (res.notFound) {
      clearEncryptedCache();
      this.cachedLicense = null;
      this.state = 'UNLICENSED';
      return this.getStatus();
    }

    if (res.valid) {
      this.cachedLicense.status = 'active';
      if (res.expiresAt !== undefined) {
        this.cachedLicense.expires_at = res.expiresAt;
      }
      this.cachedLicense.last_validated_at = new Date().toISOString();
      await saveEncryptedCache(this.cachedLicense);
      this.state = 'LICENSED_ONLINE';
      return this.getStatus();
    }

    if (res.status === 'disabled') {
      this.state = 'DISABLED';
    } else if (res.status === 'expired') {
      this.state = 'EXPIRED';
    } else {
      this.state = 'UNLICENSED';
    }
    return this.getStatus();
  }

  public async deactivate(): Promise<{ success: boolean; message: string; status: LicenseStatus }> {
    await this.init();
    if (!this.cachedLicense?.license_key) {
      this.state = 'UNLICENSED';
      return { success: true, message: 'No active license to deactivate.', status: this.getStatus() };
    }

    const { license_key, instance_id, offline_permanent } = this.cachedLicense;
    if (instance_id && license_key !== 'DEMO-KEY-123' && !license_key.startsWith('PP1.') && !offline_permanent) {
      await this.adapter.deactivate(license_key, instance_id);
    }

    clearEncryptedCache();
    this.cachedLicense = null;
    this.state = 'UNLICENSED';
    this.stopBackgroundHeartbeat();

    return {
      success: true,
      message: 'License deactivated and cleared.',
      status: this.getStatus(),
    };
  }

  public startCheckout(_tier?: string): void {
    const url = this.adapter.checkoutUrl;
    const ipc = getElectronIpc();
    if (ipc) {
      ipc.invoke('open-external', url).catch(() => {
        if (typeof window !== 'undefined') window.open(url, '_blank');
      });
    } else if (typeof window !== 'undefined') {
      window.open(url, '_blank');
    }
  }

  public openCustomerPortal(): void {
    const portalUrl = this.adapter.portalUrl;
    const ipc = getElectronIpc();
    if (ipc) {
      ipc.invoke('open-external', portalUrl).catch(() => {
        if (typeof window !== 'undefined') window.open(portalUrl, '_blank');
      });
    } else if (typeof window !== 'undefined') {
      window.open(portalUrl, '_blank');
    }
  }

  public startBackgroundHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      this.validate().catch(err => {
        console.warn('[LicenseClient] Background heartbeat failed:', err);
      });
    }, HEARTBEAT_INTERVAL_MS);
    if (this.heartbeatTimer && typeof this.heartbeatTimer.unref === 'function') {
      this.heartbeatTimer.unref();
    }
  }

  public stopBackgroundHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

export const licenseClient = new LicenseClient();

export async function validateSubscriptionEntitlement(identifier?: string): Promise<EntitlementStatus> {
  const clean = identifier?.trim();
  if (clean) {
    const res = await licenseClient.activate(clean);
    return {
      valid: res.success,
      status: res.success ? 'active' : 'inactive',
      tier: res.success ? 'pro' : undefined,
      licenseKey: clean,
      message: res.message,
    };
  }

  const status = await licenseClient.validate();
  return {
    valid: status.valid,
    status: status.valid ? 'active' : 'inactive',
    tier: status.valid ? 'pro' : undefined,
    licenseKey: status.key_masked || undefined,
  };
}
