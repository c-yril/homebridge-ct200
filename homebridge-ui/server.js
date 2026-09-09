const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const crypto = require('node:crypto');

// SingleKey ID OAuth2/OIDC, lifted from the EasyControl app's auth_config_prod.json.
// Public PKCE client: the client_id is not a secret and there is no client secret.
// These MUST match src/cloud/auth.ts (same client, same token endpoint).
const CLIENT_ID = 'BEAE0439-49D3-41B5-83D1-59B0971793F4';
const AUTHORIZE_URL = 'https://singlekey-id.com/auth/connect/authorize';
const TOKEN_URL = 'https://singlekey-id.com/auth/connect/token';
// A custom app scheme: Bosch fixed it, so the browser cannot hand the redirect
// back to us automatically. This is the one unavoidable copy-paste in the flow.
const REDIRECT_URI = 'com.bosch.rrc://app/oidc_redirect';
const SCOPE = [
    'openid',
    'profile',
    'email',
    'phone',
    'offline_access',
    'pointt.gateway.claiming',
    'pointt.gateway.removal',
    'pointt.gateway.list',
    'pointt.gateway.users',
    'pointt.gateway.resource.rrcng.app',
    'pointt.castt.flow.token-exchange',
].join(' ');

function base64url(buffer) {
    return buffer.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

class UiServer extends HomebridgePluginUiServer {
    constructor() {
        super();

        // Per-login PKCE state, held in memory for the life of the settings panel.
        this.pkce = undefined;

        this.onRequest('/auth-url', this.authUrl.bind(this));
        this.onRequest('/exchange', this.exchange.bind(this));

        this.ready();
    }

    /**
     * Builds a fresh PKCE challenge and returns the SingleKey ID authorize URL
     * the user should open. The verifier and state are kept server-side and
     * consumed by {@link exchange}.
     */
    async authUrl() {
        const verifier = base64url(crypto.randomBytes(32));
        const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
        const state = base64url(crypto.randomBytes(16));

        this.pkce = { verifier, state };

        const params = new URLSearchParams({
            client_id: CLIENT_ID,
            redirect_uri: REDIRECT_URI,
            response_type: 'code',
            scope: SCOPE,
            state,
            code_challenge: challenge,
            code_challenge_method: 'S256',
        });

        return { url: `${AUTHORIZE_URL}?${params.toString()}` };
    }

    /**
     * Exchanges the pasted redirect URL for a refresh token. Expects
     * `{ redirectUrl }` — the full `com.bosch.rrc://...` URL the browser landed
     * on after login. Verifies the state, POSTs the authorization code with the
     * stored verifier, and returns `{ refreshToken, scope }`.
     */
    async exchange(payload) {
        if (!this.pkce) {
            throw new RequestError('No login in progress. Click "Log in with Bosch" first.', { status: 400 });
        }

        const redirectUrl = (payload && payload.redirectUrl ? String(payload.redirectUrl) : '').trim();
        if (!redirectUrl) {
            throw new RequestError('Paste the full redirect URL you were sent to after logging in.', { status: 400 });
        }

        const { code, state, error } = parseRedirect(redirectUrl);
        if (error) {
            throw new RequestError(`Bosch returned an error: ${error}`, { status: 400 });
        }
        if (!code) {
            throw new RequestError(
                'That URL has no authorization code. Copy the whole address you were redirected to '
                + '(it starts with "com.bosch.rrc://").',
                { status: 400 });
        }
        if (!state || state !== this.pkce.state) {
            throw new RequestError(
                'Login state mismatch. Start the login again with "Log in with Bosch".',
                { status: 400 });
        }

        const verifier = this.pkce.verifier;
        // One-shot: an authorization code cannot be replayed.
        this.pkce = undefined;

        const response = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: REDIRECT_URI,
                client_id: CLIENT_ID,
                code_verifier: verifier,
            }),
        });

        const body = await response.text();
        if (!response.ok) {
            let detail = '';
            try {
                detail = JSON.parse(body).error || '';
            } catch {
                // non-JSON error body
            }
            throw new RequestError(
                `Token exchange failed: HTTP ${response.status}${detail ? ` (${detail})` : ''}. `
                + 'The code may have expired — try logging in again.',
                { status: 502 });
        }

        const tokens = JSON.parse(body);
        if (!tokens.refresh_token) {
            throw new RequestError(
                'Bosch did not return a refresh token. Make sure you granted all requested permissions.',
                { status: 502 });
        }

        return { refreshToken: tokens.refresh_token, scope: tokens.scope };
    }
}

/**
 * Extracts the OAuth code/state/error from a redirect URL. The custom
 * `com.bosch.rrc://` scheme is non-special to the WHATWG URL parser, so fall
 * back to a query-string regex if searchParams comes up empty.
 */
function parseRedirect(redirectUrl) {
    try {
        const parsed = new URL(redirectUrl);
        const code = parsed.searchParams.get('code');
        if (code) {
            return {
                code,
                state: parsed.searchParams.get('state') || undefined,
                error: parsed.searchParams.get('error') || undefined,
            };
        }
    } catch {
        // Fall through to regex parsing below.
    }

    const query = redirectUrl.includes('?') ? redirectUrl.slice(redirectUrl.indexOf('?') + 1) : redirectUrl;
    const params = new URLSearchParams(query);
    return {
        code: params.get('code') || undefined,
        state: params.get('state') || undefined,
        error: params.get('error') || undefined,
    };
}

(() => new UiServer())();
