import { processResponse, globalLogger } from '../platform';
import { initAuth, getAccessToken, forceRefresh, AuthRevokedError } from './auth';
import type { BoschResponse, BoschWriteResponse, CloudConfig, DeviceInfo } from './types';

const API_ROOT = 'https://pointt-api.bosch-thermotechnology.com/pointt-api/api/v1';

// A CT200 (and compatible rrc2 devices) as listed by GET /gateways.
const GATEWAY_TYPE = 'rrc2';

let deviceId: string | undefined;
let discovering: Promise<string | undefined> | undefined;
// Set once the stored login is known to be unrecoverable; stops every request
// from re-hitting the backend until the user logs in again.
let authRevoked = false;

function errorMessage(error: unknown): string {
    return error instanceof Error ? (error.message || String(error)) : String(error);
}

/** The URL for a resource path such as "/zones/list" on the discovered gateway. */
function resourceUrl(endpoint: string): string {
    return API_ROOT + '/gateways/' + encodeURIComponent(deviceId as string) + '/resource' + endpoint;
}

/**
 * Initializes auth and discovers the gateway. Never throws: the backend is
 * regularly unreachable for short periods, and under Homebridge 2 an exiting
 * plugin turns into a bridge restart loop. Resource calls retry discovery
 * on demand if it did not succeed here.
 */
export async function connectAPI(config: CloudConfig): Promise<void> {
    authRevoked = false;
    deviceId = undefined;
    initAuth(config.refreshToken, config.storagePath);

    try {
        await ensureDevice();
        globalLogger.info('Connected to Bosch cloud (gateway discovered)');
    } catch (e) {
        handleAuthError(e);
        globalLogger.error('Initial Bosch cloud connection failed, will retry on next poll: ' + errorMessage(e));
    }
}

/** Nothing to tear down: the cloud transport holds no persistent connection. */
export async function disconnectAPI(): Promise<void> {
    deviceId = undefined;
}

export async function getEndpoint(endpoint: string): Promise<BoschResponse | undefined> {
    if (authRevoked) {
        return undefined;
    }
    try {
        await ensureDevice();
        const response = await request('GET', resourceUrl(endpoint));
        if (response.status !== 200) {
            globalLogger.debug('GET ' + endpoint + ' returned HTTP ' + response.status);
            return undefined;
        }
        const parsed = JSON.parse(response.text) as BoschResponse;
        // The backend echoes the resource path as `id`, but pin it to the
        // requested endpoint so processResponse's matching never depends on the
        // server's canonicalization.
        parsed.id = endpoint;
        processResponse(parsed);
        return parsed;
    } catch (e) {
        handleAuthError(e);
        globalLogger.error('GET ' + endpoint + ' failed: ' + errorMessage(e));
        return undefined;
    }
}

export async function setEndpoint(endpoint: string, value: string | number): Promise<BoschWriteResponse | undefined> {
    if (authRevoked) {
        return undefined;
    }
    const body = JSON.stringify({ value });
    globalLogger.debug('Setting', endpoint, 'to', body);
    try {
        await ensureDevice();
        const response = await request('PUT', resourceUrl(endpoint), body);
        if (response.status >= 200 && response.status < 300) {
            return { status: 'ok' };
        }
        globalLogger.error('PUT ' + endpoint + ' returned HTTP ' + response.status);
        return undefined;
    } catch (e) {
        handleAuthError(e);
        globalLogger.error('PUT ' + endpoint + ' failed: ' + errorMessage(e));
        return undefined;
    }
}

// The device-list root. Enumerated on its own (not via getEndpoint): each entry
// resolves to a `deviceArray` node whose shape doesn't fit the flat {value}
// resource model processResponse consumes.
const DEVICES_PATH = '/devices';

/** Decodes a base64 room label, falling back to the raw string if it isn't base64. */
function decodeName(raw: unknown): string {
    if (typeof raw !== 'string') {
        return '';
    }
    try {
        const decoded = Buffer.from(raw, 'base64').toString('utf8');
        if (/^[\x20-\x7e]+$/.test(decoded)) {
            return decoded;
        }
    } catch { /* fall through to the raw value */ }
    return raw;
}

/**
 * Enumerates the radiator valves (and the controller) paired to the gateway.
 * `GET /devices` returns a list of references; each reference resolves to a
 * node whose `value[0]` is the device descriptor. Only the non-identifying
 * fields are returned - the serial (`sgtin`) and link secret (`dlk`) present in
 * the payload are never read. Never throws; returns [] on any failure.
 */
export async function getDevices(): Promise<DeviceInfo[]> {
    if (authRevoked) {
        return [];
    }
    try {
        await ensureDevice();
        const root = await request('GET', resourceUrl(DEVICES_PATH));
        if (root.status !== 200) {
            globalLogger.debug('GET ' + DEVICES_PATH + ' returned HTTP ' + root.status);
            return [];
        }

        const parsed = JSON.parse(root.text) as { references?: Array<{ id?: string }>; value?: Array<{ id?: string }> };
        const refs = Array.isArray(parsed.references) ? parsed.references
            : Array.isArray(parsed.value) ? parsed.value : [];

        const devices: DeviceInfo[] = [];
        for (const ref of refs) {
            if (!ref || typeof ref !== 'object' || !ref.id) {
                continue;
            }
            let path = String(ref.id);
            if (!path.startsWith('/')) {
                path = DEVICES_PATH + '/' + path;
            }

            const node = await request('GET', resourceUrl(path));
            if (node.status !== 200) {
                continue;
            }
            const nodeJson = JSON.parse(node.text) as { value?: unknown };
            const descriptor = Array.isArray(nodeJson.value) ? nodeJson.value[0] : nodeJson.value;
            if (!descriptor || typeof descriptor !== 'object') {
                continue;
            }

            const d = descriptor as Record<string, unknown>;
            // A real valve/controller carries a numeric zone; sub-collections don't.
            if (typeof d.zone !== 'number') {
                continue;
            }
            devices.push({
                zone: d.zone,
                battery: typeof d.battery === 'string' ? d.battery : 'unknown',
                signal: typeof d.signal === 'number' ? d.signal : 0,
                type: typeof d.type === 'string' ? d.type : '',
                name: decodeName(d.name),
            });
        }
        return devices;
    } catch (e) {
        handleAuthError(e);
        globalLogger.error('GET ' + DEVICES_PATH + ' failed: ' + errorMessage(e));
        return [];
    }
}

interface RawResponse {
    status: number;
    text: string;
}

/**
 * Issues an authenticated request, refreshing the access token once and
 * retrying if the backend answers 401 (the token expired mid-flight).
 */
async function request(method: string, url: string, body?: string): Promise<RawResponse> {
    let access = await getAccessToken();
    let response = await send(method, url, access, body);
    if (response.status === 401) {
        // A concurrent request may already have refreshed the token while this
        // one was in flight; reuse that instead of forcing another (rotating)
        // refresh. Only if the token is unchanged do we force one.
        const current = await getAccessToken();
        access = current !== access ? current : await forceRefresh();
        response = await send(method, url, access, body);
    }
    return response;
}

async function send(method: string, url: string, access: string, body?: string): Promise<RawResponse> {
    const headers: Record<string, string> = {
        authorization: 'Bearer ' + access,
        accept: 'application/json',
    };
    if (body !== undefined) {
        headers['content-type'] = 'application/json';
    }
    const response = await fetch(url, { method, headers, body });
    return { status: response.status, text: await response.text() };
}

/** Discovers (and caches) the gateway id. Concurrent callers share one attempt. */
async function ensureDevice(): Promise<string | undefined> {
    if (deviceId) {
        return deviceId;
    }
    if (!discovering) {
        discovering = discoverDevice().finally(() => {
            discovering = undefined;
        });
    }
    return discovering;
}

async function discoverDevice(): Promise<string | undefined> {
    const response = await request('GET', API_ROOT + '/gateways');
    if (response.status !== 200) {
        throw new Error('Gateway list returned HTTP ' + response.status);
    }

    const gateways = JSON.parse(response.text) as Array<{ deviceId: string; deviceType: string }>;
    const matches = gateways.filter(gateway => gateway.deviceType === GATEWAY_TYPE);
    const chosen = matches[0] ?? gateways[0];
    if (!chosen) {
        throw new Error('No gateways found on this Bosch account');
    }
    if (matches.length > 1) {
        globalLogger.warn('Multiple Bosch gateways on this account; using the first. '
            + 'Per-gateway selection is not yet configurable.');
    }

    deviceId = chosen.deviceId;
    return deviceId;
}

/** Latches the revoked state so the noisy error is logged once, not every poll. */
function handleAuthError(error: unknown): void {
    if (error instanceof AuthRevokedError && !authRevoked) {
        authRevoked = true;
        globalLogger.error(error.message);
    }
}
