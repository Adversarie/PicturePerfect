/**
 * Zero-Server Commercial Licensing Engine for Picture Perfect
 * Powered by Lemon Squeezy Public License API, Electron safeStorage DPAPI encryption,
 * and Web Crypto HMAC-SHA256 fallback with 7-day sliding offline grace.
 */

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
  product_id?: number;
  store_id?: number;
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
}

export interface EntitlementStatus {
  valid: boolean;
  status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'inactive';
  tier?: string;
  customerId?: string;
  licenseKey?: string;
  message?: string;
}

const API_BASE_URL = 'https://api.lemonsqueezy.com/v1/licenses';
const OFFLINE_GRACE_DAYS = 7;
const OFFLINE_GRACE_MS = OFFLINE_GRACE_DAYS * 24 * 60 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours

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

// --- Asymmetric Ed25519 Master Offline / Air-Gapped Configuration ---
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

  // 1. Asymmetric Ed25519 Cryptographic Verification
  try {
    const pubBytes = new Uint8Array(
      publicKeyHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16))
    );

    const subtle = (globalThis as any).crypto?.subtle;
    if (!subtle) {
      return { valid: false, message: 'Web Crypto subtle API is not available in runtime.' };
    }

    const key = await subtle.importKey(
      'raw',
      pubBytes,
      { name: 'Ed25519' },
      false,
      ['verify']
    );

    const isValid = await subtle.verify('Ed25519', key, signatureBytes, payloadBytes);
    if (!isValid) {
      return { valid: false, message: 'Cryptographic signature verification failed (tampered key or invalid signature).' };
    }
  } catch (err: any) {
    return { valid: false, message: `Ed25519 cryptographic verification error: ${err?.message || err}` };
  }

  // 2. Parse JSON payload
  let payload: any;
  try {
    const text = new TextDecoder().decode(payloadBytes);
    payload = JSON.parse(text);
  } catch {
    return { valid: false, message: 'Corrupted license payload data.' };
  }

  // 3. Product Integrity Check
  if (payload.product !== 'picture-perfect') {
    return {
      valid: false,
      message: `License was issued for '${payload.product}', not Picture Perfect.`,
      payload
    };
  }

  // 4. Optional Expiration Check
  if (payload.expires_at) {
    try {
      const expDate = new Date(payload.expires_at).getTime();
      if (Date.now() > expDate) {
        return {
          valid: false,
          message: `License expired on ${payload.expires_at}.`,
          payload
        };
      }
    } catch {
      return { valid: false, message: 'Malformed expires_at date in license.', payload };
    }
  }

  return {
    valid: true,
    message: 'Master VIP / Air-Gapped license valid and active.',
    payload
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

  if (typeof process !== 'undefined' && process.env) {
    if (process.env.PICTURE_PERFECT_LICENSE_KEY) {
      const k = process.env.PICTURE_PERFECT_LICENSE_KEY.trim();
      if (k) return k;
    }
  }

  return null;
}

// --- Electron IPC Helper ---
function getElectronIpc(): any {
  if (typeof window !== 'undefined') {
    try {
      if ((window as any).require) {
        const { ipcRenderer } = (window as any).require('electron');
        return ipcRenderer;
      }
    } catch {
      // Running in standard web browser
    }
  }
  return null;
}

// --- Machine & Browser Fingerprint for HMAC Integrity ---
function getMachineFingerprint(): string {
  if (typeof window === 'undefined') return 'headless_node_runtime';
  const parts = [
    typeof navigator !== 'undefined' ? navigator.userAgent : '',
    typeof navigator !== 'undefined' ? navigator.language : '',
    typeof screen !== 'undefined' ? `${screen.width}x${screen.height}x${screen.colorDepth}` : '',
    typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : ''
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

// --- Encrypted Storage ---
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

  // Web Crypto HMAC fallback
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
      if (decrypted) {
        return JSON.parse(decrypted);
      }
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
      } else {
        console.warn('[LicenseClient] License cache HMAC mismatch! File was tampered with or moved.');
      }
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

// --- HTTP Communication ---
async function postLicenseApi(
  endpoint: 'activate' | 'validate' | 'deactivate',
  params: Record<string, string>
): Promise<{ status: number; data: any }> {
  const url = `${API_BASE_URL}/${endpoint}`;
  const formBody = Object.keys(params)
    .map(key => encodeURIComponent(key) + '=' + encodeURIComponent(params[key]))
    .join('&');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formBody,
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data };
  } catch (err: any) {
    return { status: 0, data: { network_error: err?.message || 'Network unreachable' } };
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
  } else {
    return { state: 'GRACE_EXPIRED', graceDaysLeft: 0 };
  }
}

// --- LicenseClient ---
export class LicenseClient {
  public state: LicenseState = 'UNLICENSED';
  public cachedLicense: CachedLicenseData | null = null;
  private expectedStoreId: number;
  private expectedProductId: number;
  private heartbeatTimer: any = null;
  private initialized: boolean = false;
  private initPromise: Promise<void> | null = null;

  constructor() {
    const env = (import.meta as any).env || {};
    this.expectedStoreId = Number(env.VITE_LEMON_SQUEEZY_STORE_ID) || 0;
    this.expectedProductId = Number(env.VITE_LEMON_SQUEEZY_PRODUCT_ID) || 0;
    this.init();
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
          const verifyRes = await verifyPP1TokenOffline(this.cachedLicense.license_key);
          if (verifyRes.valid) {
            this.state = 'LICENSED_ONLINE';
          } else {
            this.state = 'EXPIRED';
          }
        } else {
          const grace = evaluateOfflineGrace(this.cachedLicense);
          this.state = grace.state;
        }
        if (this.cachedLicense && this.isAuthorized()) {
          this.startBackgroundHeartbeat();
        }
      } else {
        this.state = 'UNLICENSED';
      }

      this.initialized = true;

      // Zero-Touch Auto Provisioning check if not authorized
      if (!this.isAuthorized()) {
        try {
          const autoKey = await getAutoProvisionedKey();
          if (autoKey) {
            const actRes = await this.activate(autoKey);
            if (actRes.success) {
              console.log('[LicenseClient] Zero-touch auto-provisioned key activated successfully.');
            }
          }
        } catch (err) {
          // Auto-provisioning skipped or failed
        }
      }
    })();

    return this.initPromise;
  }

  public getCheckoutUrl(): string {
    const env = (import.meta as any).env || {};
    return env.VITE_LEMON_SQUEEZY_CHECKOUT_URL || 'https://lemonsqueezy.com';
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

    const defaultPlan = (this.cachedLicense?.offline_permanent || key.startsWith('PP1.'))
      ? 'Pro Subscriber (Air-Gapped Master)'
      : 'Pro Subscriber';

    return {
      valid: isAuth,
      state: this.state,
      status: isAuth ? 'active' : (this.state === 'UNLICENSED' ? 'trial' : 'expired'),
      plan: isAuth ? (this.cachedLicense?.plan || defaultPlan) : 'Trial Mode',
      key_masked: maskedKey,
      instance_id: this.cachedLicense?.instance_id || null,
      customer_email: this.cachedLicense?.customer_email || null,
      expires_at: this.cachedLicense?.expires_at || null,
      grace_days_left: graceDays,
      checkout_url: this.getCheckoutUrl(),
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

    // Developer demo bypass (restricted to development/test environments)
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
        product_id: this.expectedProductId || 45200,
        store_id: this.expectedStoreId || 81234,
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

    // Offline/Air-Gapped Ed25519 PP1 Master Key bypass (zero network calls)
    const pp1Token = extractPP1Token(cleanKey);
    if (pp1Token) {
      const pp1Res = await verifyPP1TokenOffline(pp1Token);
      if (!pp1Res.valid) {
        return {
          success: false,
          message: pp1Res.message,
          status: this.getStatus(),
        };
      }

      const p = pp1Res.payload || {};
      const cached: CachedLicenseData = {
        license_key: pp1Token,
        instance_id: p.license_id || 'vip_master_seat',
        instance_name: instanceName || 'Air-Gapped-Workstation',
        customer_email: p.customer_email || 'owner@pictureperfect.click',
        customer_name: p.customer_name || 'VIP Master Licensee',
        product_id: this.expectedProductId || 45200,
        store_id: this.expectedStoreId || 81234,
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

    const { status, data } = await postLicenseApi('activate', {
      license_key: cleanKey,
      instance_name: instName,
    });

    if (status === 0) {
      return {
        success: false,
        message: `Network error: ${data.network_error || 'Could not connect to activation server.'}`,
        status: this.getStatus(),
      };
    }

    if (!data.activated) {
      const err = data.error || 'License activation failed.';
      return { success: false, message: err, status: this.getStatus() };
    }

    // Cross-product check
    const meta = data.meta || {};
    if (this.expectedProductId && meta.product_id && meta.product_id !== this.expectedProductId) {
      return {
        success: false,
        message: 'This license key is valid for a different product, not Picture Perfect.',
        status: this.getStatus(),
      };
    }
    if (this.expectedStoreId && meta.store_id && meta.store_id !== this.expectedStoreId) {
      return {
        success: false,
        message: 'This license key belongs to a different store.',
        status: this.getStatus(),
      };
    }

    const licObj = data.license_key || {};
    const instObj = data.instance || {};

    const cached: CachedLicenseData = {
      license_key: licObj.key || cleanKey,
      instance_id: instObj.id || 'inst_' + Math.random().toString(36).substring(2, 10),
      instance_name: instObj.name || instName,
      customer_email: meta.customer_email,
      customer_name: meta.customer_name,
      product_id: meta.product_id,
      store_id: meta.store_id,
      status: licObj.status || 'active',
      expires_at: licObj.expires_at || null,
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

    // Offline / Air-Gapped Ed25519 PP1 verification (zero network requests, immune to grace expiry)
    if (this.cachedLicense.offline_permanent || this.cachedLicense.license_key.startsWith('PP1.')) {
      const pp1Res = await verifyPP1TokenOffline(this.cachedLicense.license_key);
      if (pp1Res.valid) {
        this.state = 'LICENSED_ONLINE';
        this.cachedLicense.last_validated_at = new Date().toISOString();
        this.cachedLicense.last_observed_timestamp = Date.now();
        await saveEncryptedCache(this.cachedLicense);
        return this.getStatus();
      } else {
        this.state = 'EXPIRED';
        return this.getStatus();
      }
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

    const params: Record<string, string> = {
      license_key: this.cachedLicense.license_key,
    };
    if (this.cachedLicense.instance_id) {
      params.instance_id = this.cachedLicense.instance_id;
    }

    const { status, data } = await postLicenseApi('validate', params);

    // Offline resilience
    if (status === 0) {
      const grace = evaluateOfflineGrace(this.cachedLicense);
      this.state = grace.state;
      return this.getStatus();
    }

    if (status === 404) {
      clearEncryptedCache();
      this.cachedLicense = null;
      this.state = 'UNLICENSED';
      return this.getStatus();
    }

    if (data.valid === true) {
      const licObj = data.license_key || {};
      this.cachedLicense.status = licObj.status || 'active';
      this.cachedLicense.expires_at = licObj.expires_at || null;
      this.cachedLicense.last_validated_at = new Date().toISOString();
      await saveEncryptedCache(this.cachedLicense);
      this.state = 'LICENSED_ONLINE';
      return this.getStatus();
    }

    const licStatus = data.license_key?.status || '';
    const errorMsg = data.error || '';

    if (licStatus === 'disabled' || errorMsg.includes('disabled')) {
      this.state = 'DISABLED';
    } else if (licStatus === 'expired' || errorMsg.includes('expired')) {
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

    const { license_key, instance_id } = this.cachedLicense;
    if (
      instance_id &&
      license_key !== 'DEMO-KEY-123' &&
      !license_key.startsWith('PP1.') &&
      !this.cachedLicense.offline_permanent
    ) {
      await postLicenseApi('deactivate', { license_key, instance_id });
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
    const url = this.getCheckoutUrl();
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
    const portalUrl = 'https://app.lemonsqueezy.com/my-orders';
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

// Global Singleton Export
export const licenseClient = new LicenseClient();

// --- Backwards Compatibility Wrappers for Existing Codebase ---

export async function validateSubscriptionEntitlement(
  identifier?: string
): Promise<EntitlementStatus> {
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
