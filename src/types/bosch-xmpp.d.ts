/**
 * Type declarations for `bosch-xmpp`, which ships no types of its own.
 * Mirrors the public surface of `lib/base-client.js` as of bosch-xmpp v2.
 */
declare module 'bosch-xmpp' {
    /** A decoded JSON document as returned by the EasyControl HTTP-over-XMPP API. */
    export interface BoschResponse {
        id: string;
        value: unknown;
        type?: string;
        writeable?: number;
        recordable?: number;
    }

    /** Result of a PUT: `{status: 'ok'}` for an empty (204) response, the raw body otherwise. */
    export interface BoschWriteResponse {
        status?: string;
    }

    export interface ClientOptions {
        serialNumber: string;
        accessKey: string;
        password: string;
        host?: string;
        port?: number;
        pingInterval?: number;
        maxRetries?: number;
        retryTimeout?: number;
    }

    /**
     * The underlying `@xmpp/client` instance. bosch-xmpp exposes it as `.client`
     * without documenting it, but reaching into it is unavoidable: its
     * auto-reconnect helper is stopped before the first connect and never
     * restarted (see `Client.reconnect` below).
     */
    export interface XmppClient {
        reconnect?: {
            start(): void;
            stop(): void;
        };
        stop?(): Promise<void>;
    }

    export interface Client {
        /**
         * The full JID assigned by the server. bosch-xmpp routes incoming stanzas
         * by comparing them against this value, and the resource part changes on
         * every reconnect, so it must be refreshed from the `online` event.
         */
        jid?: string;
        client?: XmppClient;
        connect(): Promise<unknown>;
        end(): Promise<void>;
        get(uri: string): Promise<BoschResponse>;
        put(uri: string, data: string | object): Promise<BoschWriteResponse>;
        on(event: string, listener: (...args: never[]) => void): void;
    }

    export function EasyControlClient(opts: ClientOptions): Client;
    export function IVTClient(opts: ClientOptions): Client;
    export function NefitEasyClient(opts: ClientOptions): Client;
}
