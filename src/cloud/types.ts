/**
 * Shapes the plugin consumes from the Bosch backend. These used to come from
 * `bosch-xmpp`; the cloud (pointt-api) transport returns the same resource
 * model, so the plugin code above the transport is unchanged.
 */

/** A device resource document, e.g. what `GET …/resource/zones/list` returns. */
export interface BoschResponse {
    /** The resource path, e.g. "/zones/list". Matched against the EP_* constants. */
    id: string;
    value: unknown;
    type?: string;
    writeable?: number;
    recordable?: number;
}

/** Result of a write: `{status: 'ok'}` for a successful (204) PUT. */
export interface BoschWriteResponse {
    status?: string;
}

/**
 * A radiator valve / controller as enumerated from `GET /devices`. Only the
 * non-identifying fields are kept: the raw payload also carries `sgtin` (serial)
 * and `dlk` (a device link secret), which must never be stored or logged.
 */
export interface DeviceInfo {
    /** The heating zone this device belongs to (1 = the CT200 controller itself). */
    zone: number;
    /** Battery level enum, e.g. "ok" / "low" / "unknown". */
    battery: string;
    /** RF signal strength, 0-100 (diagnostic only). */
    signal: number;
    /** Device type, e.g. "thermostat" (controller) or "thermostat_valve" (eTRV). */
    type: string;
    /** Decoded room label. */
    name: string;
}

/** What `connectAPI` needs to reach the cloud: a refresh token and where to cache it. */
export interface CloudConfig {
    refreshToken: string;
    storagePath: string;
}
