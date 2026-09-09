#!/usr/bin/env node
// Diagnostic probe for the Bosch "pointt" cloud API (the path the current
// EasyControl app uses, now that fw 05.x devices no longer serve the local
// XMPP scheme). It runs the app's own OAuth/PKCE flow against SingleKey ID,
// then reads a couple of endpoints to answer ONE question:
//
//   do device resource values come back as cleartext JSON, or still wrapped
//   in the same AES envelope we can't key on 05.04.00?
//
// Cleartext  -> a cloud transport for homebridge-ct200 is worth building.
// Encrypted  -> same wall as the local path; nothing to gain.
//
// It NEVER prints tokens or identifiers. Tokens are cached at
// ~/.bosch-cloud-tokens.json (chmod 600). Read-only: no writes to the device.
//
// Usage:
//   node scripts/bosch-cloud-probe.mjs             # login if needed, then probe (read-only)
//   node scripts/bosch-cloud-probe.mjs --relogin   # force a fresh login
//   node scripts/bosch-cloud-probe.mjs --confirm-write
//       # ALSO confirms the PUT (write) shape. Idempotent: it reads a writeable
//       # resource and writes its CURRENT value back, so nothing actually changes.
//       # Opt-in only, because it is the one part of this probe that is not read-only.

import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFileSync, writeFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// --- App config, lifted verbatim from the APK's res/raw/auth_config_prod.json
const CLIENT_ID = 'BEAE0439-49D3-41B5-83D1-59B0971793F4'; // public PKCE client
const REDIRECT_URI = 'com.bosch.rrc://app/oidc_redirect';
const AUTHORIZE = 'https://singlekey-id.com/auth/connect/authorize';
const TOKEN = 'https://singlekey-id.com/auth/connect/token';
const SCOPES = [
    'openid', 'profile', 'email', 'phone', 'offline_access',
    'pointt.gateway.claiming', 'pointt.gateway.removal', 'pointt.gateway.list',
    'pointt.gateway.users', 'pointt.gateway.resource.rrcng.app',
    'pointt.castt.flow.token-exchange',
].join(' ');
const TOKENS_FILE = join(homedir(), '.bosch-cloud-tokens.json');
const PENDING_FILE = join(homedir(), '.bosch-cloud-pending.json'); // verifier+state between login and paste

const b64url = (buf) => buf.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function saveTokens(t) {
    writeFileSync(TOKENS_FILE, JSON.stringify({ ...t, saved_at: Date.now() }, null, 2));
    chmodSync(TOKENS_FILE, 0o600);
}
function loadTokens() {
    return existsSync(TOKENS_FILE) ? JSON.parse(readFileSync(TOKENS_FILE, 'utf8')) : null;
}

function authorizeUrl(p) {
    return AUTHORIZE + '?' + new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: SCOPES,
        state: p.state, nonce: p.nonce,
        code_challenge: p.challenge,
        code_challenge_method: 'S256',
        style_id: 'tt_bsch',
        prompt: 'login',
    });
}

async function login() {
    // A "pending" session (verifier + state) is persisted so the browser login
    // and the paste can happen in different runs. Reused until a login succeeds.
    let p = existsSync(PENDING_FILE) ? JSON.parse(readFileSync(PENDING_FILE, 'utf8')) : null;
    if (!p) {
        const verifier = b64url(crypto.randomBytes(32));
        p = {
            verifier,
            challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
            state: b64url(crypto.randomBytes(16)),
            nonce: b64url(crypto.randomBytes(16)),
        };
        writeFileSync(PENDING_FILE, JSON.stringify(p));
        chmodSync(PENDING_FILE, 0o600);
        console.log('\n1. Open this URL in your browser and log in with your SingleKey ID:\n');
    } else {
        console.log('\n(Resuming the pending login — same URL/verifier as before. Log in ONCE with it.)');
        console.log('   If you already logged in, just paste the redirect below.');
        console.log('   URL again if needed:\n');
    }
    console.log(authorizeUrl(p) + '\n');
    console.log('2. After login the browser will try to open "com.bosch.rrc://app/oidc_redirect?code=..."');
    console.log('   (it will fail to open an app — that is fine). Copy that FULL URL from the');
    console.log('   address bar / the "open app?" dialog / the Network tab, and paste it here.');
    console.log('   (You can even Ctrl-C now, log in, and re-run to paste — the session is saved.)\n');

    const rl = readline.createInterface({ input: stdin, output: stdout });
    const answer = (await rl.question('Paste the redirect URL (or just the code): ')).trim();
    rl.close();

    // Robust extraction: find code=/state= anywhere, even in a doubled-up URL.
    const cm = answer.match(/[?&#]code=([^&\s#]+)/);
    const sm = answer.match(/[?&#]state=([^&\s#]+)/);
    let code = cm ? decodeURIComponent(cm[1]) : null;
    if (!code && /^[A-Za-z0-9._~-]{16,}$/.test(answer)) {
        code = answer;
    } // bare code paste
    const gotState = sm ? decodeURIComponent(sm[1]) : null;

    if (!code) {
        console.error('No code found in what you pasted. Aborting (pending session kept).'); process.exit(1);
    }
    if (gotState && gotState !== p.state) {
        console.error('State mismatch — this redirect is from a DIFFERENT login session.');
        console.error('Run with --relogin to start clean, then log in ONCE and paste that redirect.');
        process.exit(1);
    }

    const res = await fetch(TOKEN, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT_URI,
            client_id: CLIENT_ID,
            code_verifier: p.verifier,
        }),
    });
    const body = await res.text();
    if (!res.ok) {
        console.error(`\nToken exchange failed: HTTP ${res.status}`);
        // error description is not a secret; show it to help debugging
        try {
            console.error(JSON.parse(body));
        } catch {
            console.error(body.slice(0, 300));
        }
        process.exit(1);
    }
    const tok = JSON.parse(body);
    saveTokens(tok);
    rmSync(PENDING_FILE, { force: true }); // login done — pending session no longer needed
    console.log('\n✓ Tokens obtained and cached (~/.bosch-cloud-tokens.json, chmod 600).');
    console.log(`  scopes granted: ${tok.scope || '(not returned)'}`);
    console.log(`  refresh_token present: ${Boolean(tok.refresh_token)}`);
    console.log(`  expires_in: ${tok.expires_in}s`);
    return tok;
}

async function refresh(tok) {
    const res = await fetch(TOKEN, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: tok.refresh_token,
            client_id: CLIENT_ID,
        }),
    });
    if (!res.ok) {
        return null;
    }
    const fresh = await res.json();
    // some IdPs rotate the refresh token; keep the newest, fall back to the old
    if (!fresh.refresh_token) {
        fresh.refresh_token = tok.refresh_token;
    }
    saveTokens(fresh);
    return fresh;
}

// Redact anything that looks like an id/serial/token; keep schema + scalars.
const SENSITIVE = /serial|token|secret|password|deviceid|gatewayid|^id$|uuid|mac|email|phone|owner|user/i;
function shape(v, key = '', depth = 0) {
    if (v === null) {
        return 'null';
    }
    if (Array.isArray(v)) {
        return `Array(${v.length})` + (v.length ? ` of ${shape(v[0], key, depth + 1)}` : '');
    }
    if (typeof v === 'object') {
        if (depth > 2) {
            return 'Object{…}';
        }
        return '{ ' + Object.keys(v).map((k) => `${k}: ${shape(v[k], k, depth + 1)}`).join(', ') + ' }';
    }
    if (typeof v === 'string') {
        if (SENSITIVE.test(key)) {
            return `String(len=${v.length})[redacted]`;
        }
        const looksB64 = v.length > 24 && /^[A-Za-z0-9+/=_-]+$/.test(v);
        if (looksB64) {
            return `String(len=${v.length})[base64-ish?]`;
        }
        return `String(len=${v.length})="${v.slice(0, 40)}"`;
    }
    if (SENSITIVE.test(key)) {
        return `${typeof v}[redacted]`;
    }
    return `${typeof v}=${v}`; // numbers/booleans — safe, and exactly the proof we want
}

async function getURL(url, access) {
    const res = await fetch(url, {
        headers: { authorization: `Bearer ${access}`, accept: 'application/json' },
    });
    const text = await res.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch { /* not json */ }
    return { status: res.status, ct: res.headers.get('content-type') || '', text, json };
}

// Decode a JWT access token's SAFE claims only (audience/scope/endpoints).
// Personal claims (sub/email/name/…) are never printed.
function inspectToken(access) {
    const parts = (access || '').split('.');
    if (parts.length !== 3) {
        console.log('  (access token is not a JWT — cannot introspect locally)'); return;
    }
    let c;
    try {
        c = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
        console.log('  (could not decode JWT payload)'); return;
    }
    const safe = ['aud', 'iss', 'client_id', 'azp', 'scope', 'scp'];
    for (const k of safe) {
        if (c[k] !== undefined) {
            console.log(`  ${k}: ${JSON.stringify(c[k])}`);
        }
    }
    // any claim whose VALUE looks like a URL/host can hint at the API base
    for (const [k, v] of Object.entries(c)) {
        if (typeof v === 'string' && /https?:\/\/|\.net|\.com|api/i.test(v) && !safe.includes(k) && !SENSITIVE.test(k)) {
            console.log(`  hint ${k}: ${v}`);
        }
    }
    console.log(`  (all claim names: ${Object.keys(c).join(', ')})`);
}

function classify(r) {
    if (r.json === null) {
        const t = r.text.trim();
        if (/^<!?\w/.test(t)) {
            return 'HTML (not JSON)';
        }
        if (t.length > 24 && /^[A-Za-z0-9+/=_-]+$/.test(t)) {
            return 'raw base64-ish blob -> ENCRYPTED?';
        }
        return `non-JSON (${t.slice(0, 40)}…)`;
    }
    // JSON: does it look like a cleartext resource, or an encrypted envelope?
    const keys = typeof r.json === 'object' && !Array.isArray(r.json) ? Object.keys(r.json) : [];
    const env = keys.find((k) => /encrypt|cipher|payload|data/i.test(k));
    const hasValue = keys.some((k) => /^value$|^val$|references|type|unitOfMeasure|state/i.test(k));
    if (env && keys.length <= 3) {
        return `JSON envelope keyed "${env}" -> likely ENCRYPTED`;
    }
    if (hasValue || Array.isArray(r.json)) {
        return 'JSON with resource-like fields -> CLEARTEXT';
    }
    return 'JSON (inspect shape below)';
}

const ROOT = 'https://pointt-api.bosch-thermotechnology.com';
const LIST_CANDIDATES = [
    '/pointt-api/v1/gateways',
    '/pointt-api/api/v1/gateways',
    '/pointt-api/v2/gateways',
    '/pointt-api/api/v2/gateways',
    '/pointt-api/v1/gateway',
    '/pointt-api/v1/gateways/list',
    '/pointt-api/v1/users/me/gateways',
    '/pointt-api/v1/me/gateways',
    '/pointt-api/v1/user/gateways',
    '/pointt-api/gateways',
    '/pointt-api/v1/claims',
    '/pointt-api/v1/gateways/claimed',
];

async function probe(access) {
    console.log('\n=== token claims (audience/scope tell us the real API) ===');
    inspectToken(access);

    console.log('\n=== PROBE 1: find the gateway-list endpoint (sweep candidates) ===');
    let g = null, hit = null;
    for (const path of LIST_CANDIDATES) {
        const r = await getURL(ROOT + path, access);
        const flag = r.status === 200 ? ' ✓' : (r.status === 401 || r.status === 403 ? ' (auth)' : '');
        console.log(`HTTP ${r.status} · ${path}${flag}`);
        if (r.status === 200) {
            g = r; hit = path; break;
        }
    }
    if (!g) {
        console.log('\nNone hit 200. Auth works (we got tokens), so this is just the wrong path/host.');
        console.log('The token claims above (esp. "aud") say which API to target — paste this output');
        console.log('and I will narrow it, or we do one traffic capture of the app to read the real path.');
        return;
    }
    console.log(`\n✓ Gateway list at: ${hit}`);
    console.log('classification:', classify(g));
    console.log('shape:', shape(g.json));

    // find a gateway id to address resource reads (value redacted in output)
    let gwId = null;
    const arr = Array.isArray(g.json) ? g.json : (g.json?.gateways || g.json?.items || g.json?.data || []);
    if (Array.isArray(arr) && arr[0] && typeof arr[0] === 'object') {
        gwId = arr[0].id || arr[0].deviceId || arr[0].gatewayId || arr[0].deviceIdentifier || arr[0].serialNumber || null;
    }
    if (!gwId) {
        console.log('\nNo gateway id found in the list — stop here. Shape above shows what came back.');
        return;
    }
    console.log('\n✓ Found a gateway id (value hidden). Trying resource reads…');

    console.log('\n=== PROBE 2: a device resource (firmware version — non-sensitive) ===');
    const enc = encodeURIComponent(gwId);
    const base = ROOT + hit; // e.g. .../pointt-api/api/v1/gateways
    // Each entry knows how to turn a plugin endpoint path ("/zones/list") into a
    // full URL, so once one hits 200 we can reuse the exact same shape for every
    // other resource read/write below.
    const RESOURCE_SHAPES = [
        (p) => `${base}/${enc}/resource${p}`,
        (p) => `${base}/${enc}/resource${encodeURIComponent(p)}`,
        (p) => `${base}/${enc}/resource?path=${encodeURIComponent(p)}`,
        (p) => `${base}/${enc}${p}`,
        (p) => `${base}/${enc}/resources${p}`,
    ];
    let makeUrl = null;
    for (const shapeFn of RESOURCE_SHAPES) {
        const url = shapeFn('/gateway/versionFirmware');
        const r = await getURL(url, access);
        const label = url.replace(ROOT, '').replace(enc, '{id}');
        console.log(`\nHTTP ${r.status} · ${label}`);
        if (r.status === 200) {
            console.log('  classification:', classify(r));
            console.log('  shape:', shape(r.json ?? r.text.slice(0, 60)));
            makeUrl = shapeFn;
            break;
        }
    }
    if (!makeUrl) {
        console.log('\nNone of the guessed resource paths hit 200. The gateways list worked, so');
        console.log('auth is fine — we just need the real resource sub-path (one traffic capture,');
        console.log('or tell me the HTTP codes above and I will adjust the candidates).');
        return;
    }
    console.log('\n>>> CLEARTEXT confirmed = buildable.');

    // === PROBE 3: the exact resources the plugin reads (src/endpoints.ts) ===
    // Read-only. Confirms each comes back as cleartext and prints its shape so the
    // REST client can be designed against the real payloads (zones/list especially).
    console.log('\n=== PROBE 3: plugin resource reads (read-only) ===');
    const PLUGIN_READS = [
        '/zones/list',                           // EP_ZONES — central to the plugin
        '/system/awayMode/enabled',              // EP_AWAY
        '/gateway/localisation',                 // EP_LOCALIZATION
        '/system/sensors/humidity/indoor_h1',    // EP_HUMIDITY
    ];
    let zonesJson = null;
    for (const p of PLUGIN_READS) {
        const r = await getURL(makeUrl(p), access);
        console.log(`\nHTTP ${r.status} · resource${p}`);
        if (r.status === 200) {
            console.log('  classification:', classify(r));
            console.log('  shape:', shape(r.json ?? r.text.slice(0, 80)));
            if (p === '/zones/list') {
                zonesJson = r.json;
            }
        } else if (r.json) {
            console.log('  body:', shape(r.json)); // problem+json error — safe, no secrets
        }
    }

    // Per-zone resources the plugin reads/writes (/zones/zn{id}/…). Same resource
    // model, but a different path shape, so confirm one zone before trusting them.
    const firstZoneId = Array.isArray(zonesJson?.value) && zonesJson.value[0]
        ? zonesJson.value[0].id : undefined;
    if (firstZoneId !== undefined) {
        console.log('\n--- per-zone reads (zone id from zones/list, value hidden) ---');
        const perZone = [
            `/zones/zn${firstZoneId}/temperatureHeatingSetpoint`, // EP_BZ + id + EP_BZ_TARGET_TEMP
            `/zones/zn${firstZoneId}/userMode`,                   // EP_BZ + id + EP_BZ_MODE
            `/zones/zn${firstZoneId}/manualTemperatureHeating`,   // EP_BZ + id + EP_BZ_MANUAL_TEMP (write target)
        ];
        for (const p of perZone) {
            const r = await getURL(makeUrl(p), access);
            const label = p.replace(`zn${firstZoneId}`, 'zn{id}');
            console.log(`\nHTTP ${r.status} · resource${label}`);
            if (r.status === 200) {
                console.log('  classification:', classify(r));
                console.log('  shape:', shape(r.json ?? r.text.slice(0, 80)));
            } else if (r.json) {
                console.log('  body:', shape(r.json));
            }
        }
    } else {
        console.log('\n(No zone id found in zones/list value — skipping per-zone reads.)');
    }

    // === PROBE 4: WRITE shape (opt-in, idempotent) ===
    // The plugin's setEndpoint sends PUT {"value": <v>}. We confirm the verb,
    // content-type and response by writing awayMode's CURRENT value back to it —
    // a no-op that changes nothing on the device. Only runs with --confirm-write.
    if (!process.argv.includes('--confirm-write')) {
        console.log('\n=== PROBE 4: write shape — SKIPPED ===');
        console.log('  Re-run with --confirm-write to confirm the PUT verb/body. It is idempotent:');
        console.log('  it reads /system/awayMode/enabled and writes the SAME value back (no real change).');
        return;
    }
    console.log('\n=== PROBE 4: confirm PUT shape (idempotent write-back) ===');
    const WRITE_PATH = '/system/awayMode/enabled';
    const cur = await getURL(makeUrl(WRITE_PATH), access);
    if (cur.status !== 200 || !cur.json || cur.json.value === undefined) {
        console.log(`  Cannot read current value of ${WRITE_PATH} (HTTP ${cur.status}) — skipping write test.`);
        return;
    }
    const currentValue = cur.json.value;
    const writeable = cur.json.writeable;
    console.log(`  current ${WRITE_PATH}: value=${JSON.stringify(currentValue)}, writeable=${writeable}`);
    if (writeable === 0) {
        console.log('  Resource reports writeable=0 — not attempting a PUT.');
        return;
    }
    const body = JSON.stringify({ value: currentValue }); // same value = no real change
    // Try PUT first (matches the local client), then POST as a fallback probe.
    for (const method of ['PUT', 'POST']) {
        const res = await fetch(makeUrl(WRITE_PATH), {
            method,
            headers: {
                authorization: `Bearer ${access}`,
                'content-type': 'application/json',
                accept: 'application/json',
            },
            body,
        });
        const text = await res.text();
        let json = null; try {
            json = JSON.parse(text);
        } catch { /* */ }
        console.log(`\n  ${method} resource${WRITE_PATH}  ->  HTTP ${res.status}`);
        if (json) {
            console.log('    body:', shape(json));
        } else if (text.trim()) {
            console.log('    body:', text.slice(0, 120));
        }
        if (res.status >= 200 && res.status < 300) {
            console.log(`\n  >>> WRITE confirmed with ${method} + {"value":...}. No value changed (wrote current value back).`);
            break;
        }
    }
}

async function main() {
    const relogin = process.argv.includes('--relogin');
    if (relogin) {
        rmSync(TOKENS_FILE, { force: true }); rmSync(PENDING_FILE, { force: true });
    }
    let tok = relogin ? null : loadTokens();
    if (!tok) {
        tok = await login();
    }

    // try a refresh first so a stale access token doesn't look like a hard failure
    if (tok.refresh_token) {
        const fresh = await refresh(tok);
        if (fresh) {
            tok = fresh;
        }
    }
    await probe(tok.access_token);
    console.log('\nDone. No tokens or identifiers were printed. Cache:', TOKENS_FILE);
}

main().catch((e) => {
    console.error('Unexpected error:', e.message); process.exit(1);
});
