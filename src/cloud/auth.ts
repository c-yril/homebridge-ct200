import { readFileSync, writeFileSync, existsSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { globalLogger } from '../platform';

// SingleKey ID OAuth2, lifted from the EasyControl app's auth_config_prod.json.
// Public PKCE client: the client_id is not a secret and there is no client secret.
const CLIENT_ID = 'BEAE0439-49D3-41B5-83D1-59B0971793F4';
const TOKEN_URL = 'https://singlekey-id.com/auth/connect/token';

// Refresh a little before the access token actually expires, so an in-flight
// request never races the expiry.
const EXPIRY_SKEW_MS = 60 * 1000;

/**
 * A refresh token that the authorization server has rejected outright
 * (`invalid_grant`): revoked, expired, or superseded. Recoverable only by the
 * user logging in again, never by retrying, so it is surfaced distinctly.
 */
export class AuthRevokedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AuthRevokedError';
    }
}

interface StoredTokens {
    refresh_token: string;
    access_token?: string;
    expires_at?: number; // epoch ms
    // A sha256 hash of the config refresh token this cache was seeded from. A
    // change means the user pasted a new token / logged in again, so the cache
    // is discarded. Hashed, not stored verbatim, to avoid a second copy of the
    // secret on disk.
    seed: string;
}

/** Fingerprints the config refresh token for cache-invalidation comparisons. */
function seedHash(refreshToken: string): string {
    return createHash('sha256').update(refreshToken).digest('hex');
}

let TOKEN_FILE = '';
let tokens: StoredTokens | undefined;
let refreshing: Promise<string> | undefined;

function persist(): void {
    if (!tokens) {
        return;
    }
    // Write owner-only to a temp file, then atomically rename into place, so a
    // concurrent reader never sees a world-readable or half-written token file.
    const tmp = TOKEN_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    try {
        chmodSync(tmp, 0o600);
    } catch {
        // Best effort: some filesystems (e.g. on Windows) don't support chmod.
    }
    renameSync(tmp, TOKEN_FILE);
}

/**
 * Loads the cached tokens, (re)seeding from the config refresh token whenever
 * the cache is missing or was seeded from a different token. Call once before
 * {@link getAccessToken}.
 */
export function initAuth(refreshToken: string, storagePath: string): void {
    TOKEN_FILE = join(storagePath, 'ct200-cloud-tokens.json');

    let cached: StoredTokens | undefined;
    if (existsSync(TOKEN_FILE)) {
        try {
            cached = JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) as StoredTokens;
        } catch {
            cached = undefined;
        }
    }

    if (cached && cached.seed === seedHash(refreshToken) && cached.refresh_token) {
        tokens = cached;
    } else {
        // Fresh login or no usable cache: start from the config token.
        tokens = { refresh_token: refreshToken, seed: seedHash(refreshToken) };
        persist();
    }
}

/**
 * Returns a valid access token, refreshing it if the cached one is missing or
 * about to expire. Concurrent callers share a single refresh request.
 *
 * Throws {@link AuthRevokedError} if the refresh token is no longer accepted
 * (the user must log in again); throws a plain Error for transient failures.
 */
export async function getAccessToken(): Promise<string> {
    if (!tokens) {
        throw new Error('Auth not initialized');
    }

    if (tokens.access_token && tokens.expires_at && tokens.expires_at - EXPIRY_SKEW_MS > Date.now()) {
        return tokens.access_token;
    }

    if (!refreshing) {
        refreshing = refresh().finally(() => {
            refreshing = undefined;
        });
    }
    return refreshing;
}

/** Forces a refresh regardless of the cached token's expiry (used after a 401). */
export async function forceRefresh(): Promise<string> {
    if (!refreshing) {
        refreshing = refresh().finally(() => {
            refreshing = undefined;
        });
    }
    return refreshing;
}

async function refresh(): Promise<string> {
    if (!tokens) {
        throw new Error('Auth not initialized');
    }

    const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: tokens.refresh_token,
            client_id: CLIENT_ID,
        }),
    });

    const body = await response.text();
    if (!response.ok) {
        let error = '';
        try {
            error = (JSON.parse(body) as { error?: string }).error || '';
        } catch {
            // non-JSON error body
        }
        if (error === 'invalid_grant') {
            throw new AuthRevokedError(
                'Bosch rejected the stored login (refresh token expired or revoked). '
                + 'Open the plugin settings and log in again.');
        }
        throw new Error('Token refresh failed: HTTP ' + response.status + (error ? ' (' + error + ')' : ''));
    }

    const fresh = JSON.parse(body) as { access_token: string; expires_in?: number; refresh_token?: string };
    tokens.access_token = fresh.access_token;
    tokens.expires_at = Date.now() + (fresh.expires_in ?? 3600) * 1000;
    // SingleKey ID rotates the refresh token; keep the new one, fall back to the old.
    if (fresh.refresh_token) {
        tokens.refresh_token = fresh.refresh_token;
    }
    persist();
    globalLogger.debug('Refreshed Bosch access token');
    return tokens.access_token;
}
