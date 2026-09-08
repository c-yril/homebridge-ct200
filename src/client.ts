import { EasyControlClient } from 'bosch-xmpp';
import type { BoschResponse, BoschWriteResponse, Client } from 'bosch-xmpp';
import { processResponse, globalLogger } from './platform';

interface Credentials {
    serialNumber: string;
    accessKey: string;
    password: string;
}

// How long to wait before retrying a failed (re)connect.
const RETRY_DELAY_MS = 30 * 1000;

// Minimum spacing between two client rebuilds, so a burst of stream errors
// doesn't turn into a reconnect storm against the Bosch backend.
const RECONNECT_COOLDOWN_MS = 15 * 1000;

let XMPP_CLIENT: Client | undefined;
let CREDENTIALS: Credentials | undefined;
let CONNECTING: Promise<void> | undefined;
let LAST_CONNECT_AT = 0;
let SHUTTING_DOWN = false;

// The client this module owns right now, set as soon as it is built. XMPP_CLIENT
// only becomes that same instance once it is connected and usable for requests,
// so the two differ for the length of a connect attempt.
let CURRENT_CLIENT: Client | undefined;

// The Bosch backend only tolerates one in-flight request at a time, so every
// GET/PUT is appended to this chain rather than issued concurrently.
let QUEUE: Promise<unknown> = Promise.resolve();

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds).unref());
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message || String(error);
    }
    return String(error);
}

/**
 * Connects to the Bosch backend, retrying until it succeeds.
 *
 * Resolves once connected. A failure here must never terminate the process:
 * the backend is regularly unreachable for short periods, and under
 * Homebridge 2 an exiting plugin turns into a (child) bridge restart loop.
 */
export async function connectAPI(serialNumber: string, accessKey: string, password: string): Promise<void> {
    CREDENTIALS = { serialNumber, accessKey, password };
    SHUTTING_DOWN = false;
    return ensureConnected('initial connection');
}

/** Tears the client down for a Homebridge shutdown. */
export async function disconnectAPI(): Promise<void> {
    SHUTTING_DOWN = true;
    const client = CURRENT_CLIENT;
    XMPP_CLIENT = undefined;
    CURRENT_CLIENT = undefined;
    await stopClient(client);
}

export async function getEndpoint(endpoint: string): Promise<BoschResponse | undefined> {
    return enqueue('GET', endpoint, async (client) => {
        const response = await client.get(endpoint);
        processResponse(response);
        return response;
    });
}

export async function setEndpoint(endpoint: string, value: string): Promise<BoschWriteResponse | undefined> {
    const command = '{"value":' + value + '}';
    globalLogger.debug('Setting', endpoint, 'to', command);

    return enqueue('PUT', endpoint, (client) => client.put(endpoint, command));
}

function enqueue<T>(action: string, endpoint: string, operation: (client: Client) => Promise<T>): Promise<T | undefined> {
    const run = async (): Promise<T | undefined> => {
        if (!XMPP_CLIENT) {
            globalLogger.debug('Skipping ' + action + ' ' + endpoint + ': not connected yet');
            return undefined;
        }

        try {
            return await operation(XMPP_CLIENT);
        } catch (e) {
            logRequestError(e);
            if (shouldReconnect(e)) {
                ensureConnected(action + ' ' + endpoint + ': ' + errorMessage(e))
                    .catch(error => globalLogger.error('Reconnect failed: ' + errorMessage(error)));
            }
            return undefined;
        }
    };

    // `then(run, run)` keeps the chain going even when a previous entry rejected.
    const next = QUEUE.then(run, run);
    QUEUE = next;
    return next;
}

/**
 * Builds a client (replacing any existing one) and keeps retrying until one is
 * connected. Concurrent callers share a single attempt.
 */
function ensureConnected(reason: string): Promise<void> {
    if (!CONNECTING) {
        CONNECTING = (async () => {
            const sinceLastConnect = Date.now() - LAST_CONNECT_AT;
            if (LAST_CONNECT_AT !== 0 && sinceLastConnect < RECONNECT_COOLDOWN_MS) {
                await delay(RECONNECT_COOLDOWN_MS - sinceLastConnect);
            }

            globalLogger.debug('Building CT200 client after ' + reason);
            XMPP_CLIENT = undefined;

            while (!SHUTTING_DOWN) {
                LAST_CONNECT_AT = Date.now();
                try {
                    await buildClient();
                    return;
                } catch (e) {
                    globalLogger.error('Failed to connect client, retrying in '
                        + (RETRY_DELAY_MS / 1000) + 's: ' + errorMessage(e));
                    await delay(RETRY_DELAY_MS);
                }
            }
        })().finally(() => {
            CONNECTING = undefined;
        });
    }

    return CONNECTING;
}

async function buildClient(): Promise<void> {
    if (!CREDENTIALS) {
        throw new Error('CT200 credentials missing');
    }

    // A rejected connect() is cached by the client, so every attempt needs a
    // fresh instance, and the one it replaces has to be torn down first.
    await stopClient(CURRENT_CLIENT);
    CURRENT_CLIENT = undefined;

    const client = EasyControlClient({
        serialNumber: CREDENTIALS.serialNumber,
        accessKey: CREDENTIALS.accessKey,
        password: CREDENTIALS.password,
    });

    CURRENT_CLIENT = client;
    attachClientHandlers(client);
    await client.connect();

    // bosch-xmpp stops @xmpp/client's auto-reconnect before the first connect
    // and never re-enables it, which would leave a dropped connection offline
    // forever.
    client.client?.reconnect?.start();

    XMPP_CLIENT = client;
}

function attachClientHandlers(client: Client): void {
    // bosch-xmpp keeps no 'error' listener once connected. Without a permanent
    // one, any later socket/stream error is an unhandled 'error' event, which
    // takes the whole process down.
    client.on('error', ((e: unknown) => {
        // A client we already replaced, or one torn down on shutdown, keeps
        // emitting as its socket unwinds. Expected, not worth an error line.
        if (SHUTTING_DOWN || client !== CURRENT_CLIENT) {
            globalLogger.debug('Ignoring error from discarded XMPP client: ' + errorMessage(e));
            return;
        }

        // Still connecting: connect() rejects with the same failure, and
        // ensureConnected() is the one that reports and retries it.
        if (client !== XMPP_CLIENT) {
            globalLogger.debug('XMPP error while connecting: ' + errorMessage(e));
            return;
        }

        globalLogger.error('XMPP client error: ' + errorMessage(e));
        if (shouldReconnect(e)) {
            ensureConnected('async XMPP error: ' + errorMessage(e))
                .catch(error => globalLogger.error('Reconnect failed: ' + errorMessage(error)));
        }
    }) as (...args: never[]) => void);

    // Responses are matched against the full JID, whose resource part changes
    // on every reconnect; if it goes stale, every request times out.
    client.on('online', ((jid: unknown) => {
        client.jid = String(jid);
        globalLogger.info('XMPP client connected');
    }) as (...args: never[]) => void);

    client.on('disconnect', (() => {
        if (SHUTTING_DOWN || client !== CURRENT_CLIENT || client !== XMPP_CLIENT) {
            globalLogger.debug('Discarded XMPP client disconnected');
            return;
        }

        globalLogger.warn('XMPP client disconnected, waiting for automatic reconnect');
    }) as (...args: never[]) => void);
}

async function stopClient(client: Client | undefined): Promise<void> {
    if (!client) {
        return;
    }

    try {
        client.client?.reconnect?.stop();
    } catch (e) {
        globalLogger.debug('Failed to stop XMPP reconnect helper: ' + errorMessage(e));
    }

    try {
        await client.end();
    } catch (e) {
        globalLogger.debug('Failed to stop old XMPP client cleanly: ' + errorMessage(e));
    }
}

/** Errors that mean the stream is unusable and the client has to be rebuilt. */
function shouldReconnect(error: unknown): boolean {
    const message = errorMessage(error).toLowerCase();
    return message.includes('max_retries_reached')
        || message.includes('request_timeout')
        || message.includes('etimedout')
        || message.includes('stream was destroyed')
        || message.includes('econnreset')
        || message.includes('epipe')
        || message.includes('not connected')
        || message.includes('connection closed');
}

function logRequestError(error: unknown): void {
    if (error instanceof SyntaxError) {
        globalLogger.error('SyntaxError encountered while sending request! Double-check login details!');
    } else if (error instanceof Error && error.message === 'HTTP_TOO_MANY_REQUESTS') {
        globalLogger.warn('Spawning too many requests!');
    } else if (error instanceof Error) {
        globalLogger.error(error.stack || error.message);
    } else {
        globalLogger.error(String(error));
    }
}
