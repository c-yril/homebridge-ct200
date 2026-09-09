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

/** What `connectAPI` needs to reach the cloud: a refresh token and where to cache it. */
export interface CloudConfig {
    refreshToken: string;
    storagePath: string;
}
