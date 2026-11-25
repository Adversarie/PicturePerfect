export type MorProviderId = 'polar' | 'dodo' | 'lemonsqueezy' | 'mock';

export interface MorActivateResult {
  activated: boolean;
  licenseKey: string;
  instanceId?: string;
  instanceName?: string;
  customerEmail?: string;
  customerName?: string;
  productId?: string;
  storeId?: string;
  status?: string;
  expiresAt?: string | null;
  error?: string;
  networkError?: string;
}

export interface MorValidateResult {
  valid: boolean;
  notFound?: boolean;
  status?: 'active' | 'disabled' | 'expired' | 'invalid';
  expiresAt?: string | null;
  error?: string;
  networkError?: string;
}

export interface MorDeactivateResult {
  deactivated: boolean;
  networkError?: string;
}

export interface MerchantOfRecordAdapter {
  readonly providerId: MorProviderId;
  readonly merchantName: string;
  readonly checkoutUrl: string;
  readonly portalUrl: string;
  activate(licenseKey: string, instanceName: string): Promise<MorActivateResult>;
  validate(licenseKey: string, instanceId?: string): Promise<MorValidateResult>;
  deactivate(licenseKey: string, instanceId: string): Promise<MorDeactivateResult>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function parseAllowlist(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function isPastIso(iso?: string | null): boolean {
  if (!iso) return false;
  const ts = Date.parse(iso);
  return !Number.isNaN(ts) && Date.now() > ts;
}

async function postJson(
  fetchImpl: FetchLike,
  url: string,
  payload: Record<string, unknown>
): Promise<{ status: number; data: any }> {
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } catch (err: any) {
    return { status: 0, data: { network_error: err?.message || 'Network unreachable' } };
  }
}

export interface PolarAdapterConfig {
  organizationId: string;
  expectedBenefitIds?: string[];
  checkoutUrl?: string;
  portalUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: FetchLike;
}

export class PolarLicenseAdapter implements MerchantOfRecordAdapter {
  public readonly providerId: MorProviderId = 'polar';
  public readonly merchantName = 'Polar';
  public readonly checkoutUrl: string;
  public readonly portalUrl: string;
  private readonly organizationId: string;
  private readonly expectedBenefitIds: string[];
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: PolarAdapterConfig) {
    this.organizationId = config.organizationId.trim();
    this.expectedBenefitIds = config.expectedBenefitIds || [];
    this.checkoutUrl = config.checkoutUrl || 'https://buy.polar.sh/checkout';
    this.portalUrl = config.portalUrl || 'https://polar.sh/pictureperfect/portal';
    this.apiBaseUrl = (config.apiBaseUrl || 'https://api.polar.sh/v1/customer-portal/license-keys').replace(/\/$/, '');
    this.fetchImpl = config.fetchImpl || ((input, init) => fetch(input, init));
  }

  public async activate(licenseKey: string, instanceName: string): Promise<MorActivateResult> {
    if (!this.organizationId) {
      return { activated: false, licenseKey, error: 'Polar organization_id is not configured.' };
    }
    const { status, data } = await postJson(this.fetchImpl, `${this.apiBaseUrl}/activate`, {
      key: licenseKey,
      organization_id: this.organizationId,
      label: instanceName,
    });
    if (status === 0) {
      return { activated: false, licenseKey, networkError: data.network_error || 'Network error' };
    }
    if (status < 200 || status >= 300) {
      return {
        activated: false,
        licenseKey,
        error: data?.detail || data?.error || `Activation failed (HTTP ${status}).`,
      };
    }

    const licObj = data.license_key || {};
    const benefitId = String(licObj.benefit_id || '');
    if (this.expectedBenefitIds.length > 0 && benefitId && !this.expectedBenefitIds.includes(benefitId)) {
      return {
        activated: false,
        licenseKey,
        error: 'This license key is valid for a different product, not Picture Perfect.',
      };
    }

    const keyStatus = String(licObj.status || 'granted').toLowerCase();
    if (keyStatus === 'disabled' || keyStatus === 'revoked') {
      return { activated: false, licenseKey, error: 'This license key has been disabled or revoked.' };
    }
    if (isPastIso(licObj.expires_at)) {
      return { activated: false, licenseKey, error: 'This license key has expired.' };
    }

    return {
      activated: true,
      licenseKey: String(licObj.key || licenseKey),
      instanceId: String(data.id || ''),
      instanceName: String(data.label || instanceName),
      productId: benefitId || undefined,
      storeId: String(licObj.organization_id || this.organizationId),
      status: 'active',
      expiresAt: licObj.expires_at || null,
    };
  }

  public async validate(licenseKey: string, instanceId?: string): Promise<MorValidateResult> {
    if (!this.organizationId) {
      return { valid: false, status: 'invalid', error: 'Polar organization_id is not configured.' };
    }
    const payload: Record<string, unknown> = {
      key: licenseKey,
      organization_id: this.organizationId,
    };
    if (instanceId) payload.activation_id = instanceId;
    if (this.expectedBenefitIds.length === 1) payload.benefit_id = this.expectedBenefitIds[0];

    const { status, data } = await postJson(this.fetchImpl, `${this.apiBaseUrl}/validate`, payload);
    if (status === 0) {
      return { valid: false, networkError: data.network_error || 'Network error' };
    }
    if (status === 404) {
      return { valid: false, notFound: true, status: 'invalid' };
    }
    if (status < 200 || status >= 300) {
      return { valid: false, status: 'invalid', error: data?.detail || data?.error };
    }

    const keyStatus = String(data.status || 'granted').toLowerCase();
    const expiresAt = data.expires_at || null;
    if (keyStatus === 'disabled' || keyStatus === 'revoked') {
      return { valid: false, status: 'disabled', expiresAt };
    }
    if (isPastIso(expiresAt)) {
      return { valid: false, status: 'expired', expiresAt };
    }
    if (keyStatus === 'granted') {
      return { valid: true, status: 'active', expiresAt };
    }
    return { valid: false, status: 'invalid', expiresAt };
  }

  public async deactivate(licenseKey: string, instanceId: string): Promise<MorDeactivateResult> {
    if (!this.organizationId || !instanceId) return { deactivated: true };
    const { status, data } = await postJson(this.fetchImpl, `${this.apiBaseUrl}/deactivate`, {
      key: licenseKey,
      organization_id: this.organizationId,
      activation_id: instanceId,
    });
    if (status === 0) {
      return { deactivated: false, networkError: data.network_error };
    }
    return { deactivated: status >= 200 && status < 300 };
  }
}

export interface DodoAdapterConfig {
  businessId?: string;
  expectedProductIds?: string[];
  checkoutUrl?: string;
  portalUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: FetchLike;
}

export class DodoLicenseAdapter implements MerchantOfRecordAdapter {
  public readonly providerId: MorProviderId = 'dodo';
  public readonly merchantName = 'Dodo Payments';
  public readonly checkoutUrl: string;
  public readonly portalUrl: string;
  private readonly businessId: string;
  private readonly expectedProductIds: string[];
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: DodoAdapterConfig) {
    this.businessId = (config.businessId || '').trim();
    this.expectedProductIds = config.expectedProductIds || [];
    this.checkoutUrl = config.checkoutUrl || 'https://checkout.dodopayments.com/buy/checkout';
    this.portalUrl =
      config.portalUrl ||
      (this.businessId
        ? `https://customer.dodopayments.com/login/${this.businessId}`
        : 'https://customer.dodopayments.com');
    this.apiBaseUrl = (config.apiBaseUrl || 'https://live.dodopayments.com/licenses').replace(/\/$/, '');
    this.fetchImpl = config.fetchImpl || ((input, init) => fetch(input, init));
  }

  public async activate(licenseKey: string, instanceName: string): Promise<MorActivateResult> {
    const { status, data } = await postJson(this.fetchImpl, `${this.apiBaseUrl}/activate`, {
      license_key: licenseKey,
      name: instanceName,
    });
    if (status === 0) {
      return { activated: false, licenseKey, networkError: data.network_error || 'Network error' };
    }
    if (status < 200 || status >= 300 || !data.id) {
      return {
        activated: false,
        licenseKey,
        error: data?.message || data?.error || `License activation failed (HTTP ${status}).`,
      };
    }

    const productId = String(data.product?.product_id || data.product_id || '');
    const businessId = String(data.business_id || '');
    if (this.expectedProductIds.length > 0 && productId && !this.expectedProductIds.includes(productId)) {
      return {
        activated: false,
        licenseKey,
        error: 'This license key is valid for a different product, not Picture Perfect.',
      };
    }
    if (this.businessId && businessId && businessId !== this.businessId) {
      return { activated: false, licenseKey, error: 'This license key belongs to a different store.' };
    }
    if (isPastIso(data.expires_at)) {
      return { activated: false, licenseKey, error: 'This license key has expired.' };
    }

    return {
      activated: true,
      licenseKey,
      instanceId: String(data.id),
      instanceName: String(data.name || instanceName),
      customerEmail: data.customer?.email,
      customerName: data.customer?.name,
      productId: productId || undefined,
      storeId: businessId || undefined,
      status: 'active',
      expiresAt: data.expires_at || null,
    };
  }

  public async validate(licenseKey: string, instanceId?: string): Promise<MorValidateResult> {
    const payload: Record<string, unknown> = { license_key: licenseKey };
    if (instanceId) payload.license_key_instance_id = instanceId;

    const { status, data } = await postJson(this.fetchImpl, `${this.apiBaseUrl}/validate`, payload);
    if (status === 0) {
      return { valid: false, networkError: data.network_error || 'Network error' };
    }
    if (status === 404) {
      return { valid: false, notFound: true, status: 'invalid' };
    }
    if (data?.valid === true) {
      return { valid: true, status: 'active' };
    }
    return { valid: false, status: 'expired', error: data?.message || data?.error };
  }

  public async deactivate(licenseKey: string, instanceId: string): Promise<MorDeactivateResult> {
    const { status, data } = await postJson(this.fetchImpl, `${this.apiBaseUrl}/deactivate`, {
      license_key: licenseKey,
      license_key_instance_id: instanceId,
    });
    if (status === 0) {
      return { deactivated: false, networkError: data.network_error };
    }
    return { deactivated: status >= 200 && status < 300 };
  }
}

export interface LemonSqueezyAdapterConfig {
  storeId?: string;
  expectedProductIds?: string[];
  checkoutUrl?: string;
  portalUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: FetchLike;
}

export class LemonSqueezyLicenseAdapter implements MerchantOfRecordAdapter {
  public readonly providerId: MorProviderId = 'lemonsqueezy';
  public readonly merchantName = 'Lemon Squeezy';
  public readonly checkoutUrl: string;
  public readonly portalUrl: string;
  private readonly storeId: string;
  private readonly expectedProductIds: string[];
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: LemonSqueezyAdapterConfig) {
    this.storeId = (config.storeId || '').trim();
    this.expectedProductIds = config.expectedProductIds || [];
    this.checkoutUrl = config.checkoutUrl || 'https://pictureperfect.lemonsqueezy.com/checkout';
    this.portalUrl = config.portalUrl || 'https://app.lemonsqueezy.com/my-orders';
    this.apiBaseUrl = (config.apiBaseUrl || 'https://api.lemonsqueezy.com/v1/licenses').replace(/\/$/, '');
    this.fetchImpl = config.fetchImpl || ((input, init) => fetch(input, init));
  }

  private async postForm(endpoint: string, params: Record<string, string>): Promise<{ status: number; data: any }> {
    const body = Object.keys(params)
      .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
      .join('&');
    try {
      const res = await this.fetchImpl(`${this.apiBaseUrl}/${endpoint}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
      const data = await res.json().catch(() => ({}));
      return { status: res.status, data };
    } catch (err: any) {
      return { status: 0, data: { network_error: err?.message || 'Network unreachable' } };
    }
  }

  public async activate(licenseKey: string, instanceName: string): Promise<MorActivateResult> {
    const { status, data } = await this.postForm('activate', {
      license_key: licenseKey,
      instance_name: instanceName,
    });
    if (status === 0) {
      return { activated: false, licenseKey, networkError: data.network_error || 'Network error' };
    }
    if (!data.activated) {
      return { activated: false, licenseKey, error: data.error || 'License activation failed.' };
    }
    const meta = data.meta || {};
    const productId = meta.product_id !== undefined ? String(meta.product_id) : '';
    const storeId = meta.store_id !== undefined ? String(meta.store_id) : '';
    if (this.expectedProductIds.length > 0 && productId && !this.expectedProductIds.includes(productId)) {
      return {
        activated: false,
        licenseKey,
        error: 'This license key is valid for a different product, not Picture Perfect.',
      };
    }
    if (this.storeId && this.storeId !== '0' && storeId && storeId !== this.storeId) {
      return { activated: false, licenseKey, error: 'This license key belongs to a different store.' };
    }

    const licObj = data.license_key || {};
    const instObj = data.instance || {};
    return {
      activated: true,
      licenseKey: String(licObj.key || licenseKey),
      instanceId: String(instObj.id || ''),
      instanceName: String(instObj.name || instanceName),
      customerEmail: meta.customer_email,
      customerName: meta.customer_name,
      productId: productId || undefined,
      storeId: storeId || undefined,
      status: String(licObj.status || 'active'),
      expiresAt: licObj.expires_at || null,
    };
  }

  public async validate(licenseKey: string, instanceId?: string): Promise<MorValidateResult> {
    const params: Record<string, string> = { license_key: licenseKey };
    if (instanceId) params.instance_id = instanceId;
    const { status, data } = await this.postForm('validate', params);
    if (status === 0) {
      return { valid: false, networkError: data.network_error || 'Network error' };
    }
    if (status === 404) {
      return { valid: false, notFound: true, status: 'invalid' };
    }
    if (data.valid === true) {
      return {
        valid: true,
        status: 'active',
        expiresAt: data.license_key?.expires_at || null,
      };
    }
    const licStatus = String(data.license_key?.status || '');
    const errMsg = String(data.error || '');
    if (licStatus === 'disabled' || errMsg.includes('disabled')) {
      return { valid: false, status: 'disabled', error: errMsg };
    }
    if (licStatus === 'expired' || errMsg.includes('expired')) {
      return { valid: false, status: 'expired', error: errMsg };
    }
    return { valid: false, status: 'invalid', error: errMsg };
  }

  public async deactivate(licenseKey: string, instanceId: string): Promise<MorDeactivateResult> {
    const { status, data } = await this.postForm('deactivate', {
      license_key: licenseKey,
      instance_id: instanceId,
    });
    if (status === 0) {
      return { deactivated: false, networkError: data.network_error };
    }
    return { deactivated: status >= 200 && status < 300 };
  }
}

export interface MockKeyRecord {
  productId: string;
  maxSeats: number;
  status: 'active' | 'disabled' | 'expired';
  expiresAt?: string | null;
  customerEmail?: string;
  customerName?: string;
  instances: Map<string, string>;
}

export class MockMorAdapter implements MerchantOfRecordAdapter {
  public readonly providerId: MorProviderId = 'mock';
  public readonly merchantName = 'Mock Merchant';
  public readonly checkoutUrl = 'https://mock.merchant.test/checkout';
  public readonly portalUrl = 'https://mock.merchant.test/portal';
  public simulateOffline = false;
  public expectedProductId: string;
  private keys = new Map<string, MockKeyRecord>();
  private seq = 1;

  constructor(expectedProductId = 'pp_pro') {
    this.expectedProductId = expectedProductId;
  }

  public registerKey(
    key: string,
    opts: {
      productId?: string;
      maxSeats?: number;
      status?: 'active' | 'disabled' | 'expired';
      expiresAt?: string | null;
      customerEmail?: string;
    } = {}
  ): void {
    this.keys.set(key, {
      productId: opts.productId ?? this.expectedProductId,
      maxSeats: opts.maxSeats ?? 2,
      status: opts.status ?? 'active',
      expiresAt: opts.expiresAt ?? null,
      customerEmail: opts.customerEmail ?? 'buyer@example.com',
      instances: new Map(),
    });
  }

  public setKeyStatus(key: string, status: 'active' | 'disabled' | 'expired'): void {
    const rec = this.keys.get(key);
    if (rec) rec.status = status;
  }

  public async activate(licenseKey: string, instanceName: string): Promise<MorActivateResult> {
    if (this.simulateOffline) {
      return { activated: false, licenseKey, networkError: 'Simulated offline mode' };
    }
    const rec = this.keys.get(licenseKey);
    if (!rec) {
      return { activated: false, licenseKey, error: 'License key not found.' };
    }
    if (rec.productId !== this.expectedProductId) {
      return {
        activated: false,
        licenseKey,
        error: 'This license key is valid for a different product, not Picture Perfect.',
      };
    }
    if (rec.status !== 'active') {
      return { activated: false, licenseKey, error: `License is ${rec.status}.` };
    }
    if (rec.instances.size >= rec.maxSeats) {
      return { activated: false, licenseKey, error: `Activation limit (${rec.maxSeats} seats) reached.` };
    }
    const instanceId = `mock_inst_${this.seq++}`;
    rec.instances.set(instanceId, instanceName);
    return {
      activated: true,
      licenseKey,
      instanceId,
      instanceName,
      customerEmail: rec.customerEmail,
      productId: rec.productId,
      storeId: 'mock_store',
      status: 'active',
      expiresAt: rec.expiresAt || null,
    };
  }

  public async validate(licenseKey: string, instanceId?: string): Promise<MorValidateResult> {
    if (this.simulateOffline) {
      return { valid: false, networkError: 'Simulated offline mode' };
    }
    const rec = this.keys.get(licenseKey);
    if (!rec) {
      return { valid: false, notFound: true, status: 'invalid' };
    }
    if (instanceId && !rec.instances.has(instanceId)) {
      return { valid: false, notFound: true, status: 'invalid' };
    }
    if (rec.status === 'disabled') return { valid: false, status: 'disabled', expiresAt: rec.expiresAt };
    if (rec.status === 'expired') return { valid: false, status: 'expired', expiresAt: rec.expiresAt };
    return { valid: true, status: 'active', expiresAt: rec.expiresAt || null };
  }

  public async deactivate(licenseKey: string, instanceId: string): Promise<MorDeactivateResult> {
    if (this.simulateOffline) {
      return { deactivated: false, networkError: 'Simulated offline mode' };
    }
    const rec = this.keys.get(licenseKey);
    if (rec) rec.instances.delete(instanceId);
    return { deactivated: true };
  }
}

export function createMorAdapterFromEnv(env: Record<string, any> = {}): MerchantOfRecordAdapter {
  const providerRaw = String(env.VITE_MOR_PROVIDER || 'polar').trim().toLowerCase();
  const orgId = String(env.VITE_MOR_ORG_ID || env.VITE_LEMON_SQUEEZY_STORE_ID || '').trim();
  const productIds = parseAllowlist(
    String(env.VITE_MOR_PRODUCT_IDS || env.VITE_LEMON_SQUEEZY_PRODUCT_ID || '')
  );
  const checkoutUrl = String(env.VITE_MOR_CHECKOUT_URL || env.VITE_LEMON_SQUEEZY_CHECKOUT_URL || '').trim();
  const portalUrl = String(env.VITE_MOR_PORTAL_URL || '').trim();

  if (providerRaw === 'dodo') {
    return new DodoLicenseAdapter({
      businessId: orgId,
      expectedProductIds: productIds,
      checkoutUrl: checkoutUrl || undefined,
      portalUrl: portalUrl || undefined,
    });
  }
  if (providerRaw === 'lemonsqueezy') {
    return new LemonSqueezyLicenseAdapter({
      storeId: orgId,
      expectedProductIds: productIds,
      checkoutUrl: checkoutUrl || undefined,
      portalUrl: portalUrl || undefined,
    });
  }
  return new PolarLicenseAdapter({
    organizationId: orgId,
    expectedBenefitIds: productIds,
    checkoutUrl: checkoutUrl || undefined,
    portalUrl: portalUrl || undefined,
  });
}
