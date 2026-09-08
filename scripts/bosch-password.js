// Works out which credentials the CT200 is actually encrypting with.
//
// The XMPP login only proves the serial number and the access key are accepted
// as a username/password pair. The AES key is derived separately, from
// MD5(accessKey||MAGIC) ++ MD5(MAGIC||password), so a login can succeed while
// the replies still decrypt to noise - which surfaces as "is not valid JSON"
// and reads like a broken device rather than like wrong credentials. Two things
// cause it: the wrong device password (the one set in the EasyControl app, not
// the Bosch SingleKey ID one), or an access key whose letter case differs from
// what the device uses - the XMPP server may well not care about case, MD5 very
// much does.
//
// So: fetch one encrypted reply (a single request - the backend serves one
// client at a time), then try combinations against it offline. A combination is
// right when the plaintext parses as JSON. Candidates are typed at a hidden
// prompt and are never printed, written to disk or passed as an argument; only
// their length and the verdict are shown.
const { createHash, createDecipheriv } = require('node:crypto');
const { EasyControlClient } = require('bosch-xmpp');

const MAGIC = Buffer.from('1d86b2631b02f2c7978b41e8a3ae609b0b2afbfd30ff386da60c586a827408e4', 'hex');
const ENDPOINT = '/gateway/versionFirmware';

// The password never leaves the machine: it only feeds the local key
// derivation. Neither of the two connections below decrypts anything - one
// intercepts the ciphertext, the other only exercises the login - so the value
// handed to the client there is deliberately arbitrary.
const UNUSED_PASSWORD = 'not-used-for-these-connections';

const CTRL_C = '\u0003';
const BACKSPACE = '\u007f';

/** Drops the dashes and spaces the keys are printed with. */
function withoutSeparators(value) {
    return String(value ?? '').replace(/[\s-]/g, '');
}

/** The key bosch-xmpp derives, for arbitrary credentials. */
function encryptionKey(accessKey, password) {
    const hash1 = createHash('md5').update(Buffer.concat([Buffer.from(accessKey), MAGIC])).digest();
    const hash2 = createHash('md5').update(Buffer.concat([MAGIC, Buffer.from(password)])).digest();
    return Buffer.concat([hash1, hash2]);
}

function decrypt(ciphertext, key) {
    const decipher = createDecipheriv('aes-256-ecb', key, Buffer.alloc(0));
    decipher.setAutoPadding(false);
    const plain = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
    return plain.toString().replace(/\0*$/g, '');
}

/** The decrypted reply if these credentials are the device's, undefined otherwise. */
function tryDecrypt(ciphertext, accessKey, password) {
    try {
        return JSON.parse(decrypt(ciphertext, encryptionKey(accessKey, password)));
    } catch {
        return undefined;
    }
}

/**
 * What one set of credentials turns the reply into, rendered for a human. A
 * correct key yields readable JSON ({"id":"/gateway/...). AES-ECB is
 * all-or-nothing, so a wrong key gives uniformly random bytes with no
 * resemblance to JSON - there is no "almost right". Non-printable bytes are
 * shown as a middle dot so the terminal stays intact, and nothing here reveals
 * the password or the key.
 */
/**
 * Which of the two failure modes a set of credentials hits, named. Decryption
 * and JSON parsing fail for different reasons: a malformed reply body breaks
 * AES itself (a response problem), while a wrong key sails through AES and only
 * trips the JSON parse (a password problem). Returns '' when it actually works.
 */
function failureReason(ciphertext, accessKey, password) {
    let plain;
    try {
        plain = decrypt(ciphertext, encryptionKey(accessKey, password));
    } catch (e) {
        return 'AES decryption failed (' + (e.message || e) + ') - the reply body is malformed, '
            + 'not a password problem.';
    }
    try {
        JSON.parse(plain);
        return '';
    } catch (e) {
        return 'decrypted, but not JSON (' + e.constructor.name + ': ' + (e.message || e).split('\n')[0]
            + ') - the key is wrong, i.e. the password.';
    }
}

function previewDecrypt(ciphertext, accessKey, password) {
    let plain;
    try {
        plain = decrypt(ciphertext, encryptionKey(accessKey, password));
    } catch (e) {
        return '(could not decrypt at all: ' + (e.message || e) + ')';
    }
    const readable = plain.replace(/[^\x20-\x7e]/g, '\u00b7').slice(0, 72);
    const looksLikeJson = plain.trimStart().startsWith('{');
    return readable + (plain.length > 72 ? '...' : '')
        + (looksLikeJson ? '  <- starts like JSON, key is close' : '  <- random bytes, key is wrong');
}

/** The password with its first character recased; unchanged when empty. */
function withFirstLetter(password, transform) {
    return password ? transform(password[0]) + password.slice(1) : password;
}

/**
 * Every plausible reading of one typed password, so that a run can answer
 * "wrong password" instead of "wrong password, unless you typed it right and
 * something mangled it on the way". Each variant is one specific hypothesis
 * about what differs between what was typed and what the device stored.
 */
function combinations(accessKey, password) {
    const accessKeys = [
        { label: '', value: accessKey },
        { label: ', access key lowercased', value: accessKey.toLowerCase() },
        { label: ', access key uppercased', value: accessKey.toUpperCase() },
    ];
    const readings = [
        { label: 'as typed', value: password },
        { label: 'without surrounding spaces', value: password.trim() },
        // Accented characters have two valid UTF-8 spellings and macOS hands out
        // the decomposed one; the device hashes bytes, so they are not the same.
        { label: 'unicode-normalised (NFC)', value: password.normalize('NFC') },
        { label: 'unicode-normalised (NFD)', value: password.normalize('NFD') },
        // Phone keyboards capitalise the first letter of a text field by
        // default, so the device may hold a capitalisation of what was typed
        // here - or the reverse, if it was set from a computer.
        { label: 'first letter capitalised', value: withFirstLetter(password, c => c.toUpperCase()) },
        { label: 'first letter lowercased', value: withFirstLetter(password, c => c.toLowerCase()) },
        // Password fields often cap length or drop symbols on save, so the
        // device can hold less than what was typed. These cover a device that
        // stored a trimmed form of the password entered in the app.
        { label: 'symbols removed', value: password.replace(/[^A-Za-z0-9]/g, '') },
        { label: 'cut at first symbol', value: (password.match(/^[A-Za-z0-9]*/) || [''])[0] },
        { label: 'truncated to 16', value: password.slice(0, 16) },
    ];

    // Each reading, then the same reading base64-encoded. bosch-xmpp briefly
    // base64-encoded passwords longer than 8 characters before hashing them
    // (commit 67a6693), then reverted it (0fe6b5f); the installed version hashes
    // the raw password. A device provisioned while the app used the other rule
    // expects the other key, which here decrypts to noise - exactly the "correct
    // password, nothing decrypts" symptom. The derivation is fixed, so at most
    // one spelling is right; trying both costs nothing offline.
    const passwords = readings.flatMap((reading) => {
        const variants = [reading];
        if (reading.value) {
            variants.push({
                label: reading.label + ', base64-encoded',
                value: Buffer.from(reading.value).toString('base64'),
            });
        }
        return variants;
    });

    const seen = new Set();
    const result = [];
    for (const key of accessKeys) {
        for (const candidate of passwords) {
            const signature = key.value + ' ' + candidate.value;
            if (seen.has(signature)) {
                continue;
            }
            seen.add(signature);
            result.push({
                label: candidate.label + key.label,
                accessKey: key.value,
                password: candidate.value,
            });
        }
    }
    return result;
}

/** The reading of a typed password that works, with the reply it decrypted. */
function check(ciphertext, accessKey, password) {
    for (const combination of combinations(accessKey, password)) {
        const reply = tryDecrypt(ciphertext, combination.accessKey, combination.password);
        if (reply !== undefined) {
            return { ...combination, reply };
        }
    }
    return undefined;
}

/**
 * Grabs the raw, still-encrypted body of one reply. bosch-xmpp decrypts inside
 * get(), so the ciphertext is intercepted by replacing decrypt() on the
 * instance; the connection itself does not depend on the password.
 */
async function fetchCiphertext(serialNumber, accessKey) {
    const client = EasyControlClient({ serialNumber, accessKey, password: UNUSED_PASSWORD });
    let ciphertext;
    client.decrypt = (data) => {
        ciphertext = data;
        return '{}';
    };

    try {
        await client.connect();
        await client.get(ENDPOINT);
    } finally {
        // bosch-xmpp's keepalive reschedules itself forever; replacing ping()
        // is what lets the process exit.
        client.ping = () => {};
        await client.end().catch(() => {});
    }

    if (!ciphertext) {
        throw new Error('The device replied without a body; nothing to test against.');
    }
    return ciphertext;
}

/**
 * Whether the XMPP server actually checks the access key.
 *
 * This is the question that decides where to look. A login proves the serial
 * number is a known contact, since that is the username; the access key is only
 * the SASL password, and if the server took any password, a wrong access key
 * would produce exactly the symptom we are chasing - a working login and
 * undecryptable replies - while looking like a wrong device password.
 *
 * So log in once with an access key that cannot be right and watch what
 * happens. A refusal means the real one is verified, and the password is the
 * only remaining suspect.
 */
async function serverVerifiesAccessKey(serialNumber, accessKey) {
    // Same shape, different value: a wrong key that cannot be mistaken for a
    // malformed one, so a refusal is about the value rather than the format.
    let wrong = accessKey.split('').reverse().join('');
    if (wrong === accessKey) {
        wrong = accessKey.slice(0, -1) + (accessKey.endsWith('a') ? 'b' : 'a');
    }

    const client = EasyControlClient({ serialNumber, accessKey: wrong, password: UNUSED_PASSWORD });
    try {
        await client.connect();
        return false;
    } catch (e) {
        if (e && (e.condition === 'not-authorized' || String(e.message || e).includes('not-authorized'))) {
            return true;
        }
        // Anything else (a timeout, a dropped stream) says nothing either way.
        throw e;
    } finally {
        client.ping = () => {};
        await client.end().catch(() => {});
    }
}

/**
 * The probe's verdict, computed on first use and remembered: true when the
 * server rejects a wrong access key, false when it does not, null when the
 * question could not be answered.
 */
function accessKeyProbe(serialNumber, accessKey) {
    let verdict;
    return async () => {
        if (verdict === undefined) {
            try {
                verdict = await serverVerifiesAccessKey(serialNumber, accessKey);
            } catch (e) {
                console.log('Could not test whether the server checks the access key: ' + (e.message || e));
                verdict = null;
            }
        }
        return verdict;
    };
}

/** What is left to suspect once nothing has decrypted, given the probe. */
function whatIsLeft(verdict) {
    const password = 'the personal password set in the EasyControl app under Menu -> Settings -> '
        + 'Personal, never the Bosch SingleKey ID one';
    if (verdict === true) {
        return 'The server rejects a wrong access key, so yours is right and the password is the only '
            + 'thing left: ' + password + '. Set a fresh alphanumeric one in the app, check the app '
            + 'still drives the heating, then run this again.';
    }
    if (verdict === false) {
        return 'The server accepted a deliberately wrong access key, so the login never vouched for '
            + 'yours. Re-read the access key in the EasyControl app or on the device - it is half of '
            + 'the encryption key, and a wrong one looks exactly like a wrong password.';
    }
    return 'Two things are left to suspect, and the probe could not separate them: the device password '
        + '(' + password + ') and the access key. Re-read both in the app.';
}

/** Reads a line without echoing it, so the password stays out of the terminal. */
function askHidden(question) {
    return new Promise((resolve) => {
        process.stdout.write(question);
        const stdin = process.stdin;

        if (!stdin.isTTY) {
            let buffer = '';
            stdin.setEncoding('utf8');
            stdin.on('data', (chunk) => {
                buffer += chunk;
                const newline = buffer.indexOf('\n');
                if (newline !== -1) {
                    stdin.pause();
                    resolve(buffer.slice(0, newline));
                }
            });
            stdin.on('end', () => resolve(buffer));
            return;
        }

        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');

        let value = '';
        const onData = (chunk) => {
            for (const character of chunk) {
                if (character === '\r' || character === '\n') {
                    stdin.removeListener('data', onData);
                    stdin.setRawMode(false);
                    stdin.pause();
                    process.stdout.write('\n');
                    resolve(value);
                    return;
                }
                if (character === CTRL_C) {
                    process.stdout.write('\n');
                    process.exit(130);
                }
                if (character === BACKSPACE || character === '\b') {
                    value = value.slice(0, -1);
                } else if (character >= ' ') {
                    value += character;
                }
            }
        };
        stdin.on('data', onData);
    });
}

function reportMatch(match, typed, configuredAccessKey) {
    console.log('MATCH - length ' + typed.length + ', ' + Buffer.byteLength(typed) + ' bytes, ' + match.label + '.');
    // The decrypted reply is the proof, and it is device information rather
    // than anything secret: firmware version, not credentials.
    console.log('The device replied: ' + JSON.stringify(match.reply));
    console.log('Store the password in .env between single quotes: BOSCH_XMPP_PASSWORD=\'...\'');

    if (match.accessKey !== configuredAccessKey) {
        console.log('BOSCH_XMPP_ACCESS_KEY has to be written in that same case - the XMPP login '
            + 'accepts either, the encryption does not.');
    }
    if (match.password !== typed) {
        console.log('The password needed adjusting (' + match.label + '); store the adjusted form.');
    }
}

async function main() {
    const serialNumber = withoutSeparators(process.env.BOSCH_XMPP_SERIAL_NUMBER);
    const accessKey = withoutSeparators(process.env.BOSCH_XMPP_ACCESS_KEY);

    if (!serialNumber || !accessKey) {
        console.error('Set BOSCH_XMPP_SERIAL_NUMBER and BOSCH_XMPP_ACCESS_KEY (in .env) first.');
        process.exit(1);
    }

    console.log('Fetching one encrypted reply from the CT200 (stop Homebridge first if this hangs)...');
    const ciphertext = await fetchCiphertext(serialNumber, accessKey);
    const fingerprint = createHash('sha256').update(String(ciphertext)).digest('hex').slice(0, 12);
    console.log('Got it (reply fingerprint ' + fingerprint + '). Everything from here on is local, '
        + 'the device is not contacted again.');
    // The reply is encrypted with the device's current key, so the fingerprint
    // only changes when the device re-keys. Compare it across a password change:
    // unchanged means the app never pushed the new password to the device.
    console.log('If you just changed the password in the app and this fingerprint is the same as '
        + 'before, the device has not picked up the change yet.\n');

    // A successful login does not vouch for the access key. It proves the serial
    // number is a known contact - that is the XMPP username - but the access key is
    // only the SASL password, and nothing here establishes how strictly the server
    // checks it. Since it is also the first half of the AES key, a wrong one looks
    // exactly like a wrong device password. So it can be replaced for the session.
    const typedAccessKey = withoutSeparators(await askHidden(
        'Access key to test with (empty = the one from .env): '));
    const usable = typedAccessKey.length === accessKey.length;
    if (typedAccessKey && !usable) {
        // A part of a key decrypts nothing, so testing one would only produce a
        // confident-looking "no" about the password.
        console.log('That is ' + typedAccessKey.length + ' characters and the configured access key is '
            + accessKey.length + '; a partial key can only give a meaningless answer, so the '
            + 'configured one is used instead.');
    }
    const testAccessKey = usable ? typedAccessKey : accessKey;
    if (usable && typedAccessKey !== accessKey) {
        console.log('Using the access key you just typed.');
    }

    const probe = accessKeyProbe(serialNumber, testAccessKey);

    // The password already in the environment goes first: it says whether the env
    // file delivers what the user thinks it does.
    const fromEnv = process.env.BOSCH_XMPP_PASSWORD;
    if (fromEnv) {
        const match = check(ciphertext, testAccessKey, fromEnv);
        if (match) {
            console.log('BOSCH_XMPP_PASSWORD from the environment is the right one.');
            reportMatch(match, fromEnv, accessKey);
            process.exit(0);
        }
        console.log('BOSCH_XMPP_PASSWORD from the environment (length ' + fromEnv.length + ') does not '
            + 'decrypt the reply, in any casing of the access key.');
        console.log('  what it decrypts to: ' + previewDecrypt(ciphertext, testAccessKey, fromEnv));
        console.log('  error type: ' + failureReason(ciphertext, testAccessKey, fromEnv));

        // Worth one more connection: it tells the user which credential to go
        // and re-read, instead of leaving both under suspicion.
        console.log(whatIsLeft(await probe()) + '\n');
    }

    for (;;) {
        const candidate = await askHidden('Password to try (empty to quit): ');
        if (candidate === '') {
            console.log(whatIsLeft(await probe()));
            break;
        }

        const match = check(ciphertext, testAccessKey, candidate);
        if (match) {
            reportMatch(match, candidate, accessKey);
            break;
        }
        console.log('No - length ' + candidate.length + ', ' + Buffer.byteLength(candidate) + ' bytes.');
        console.log('  what it decrypts to: ' + previewDecrypt(ciphertext, testAccessKey, candidate));
        console.log('  error type: ' + failureReason(ciphertext, testAccessKey, candidate));
    }
}

main().catch((e) => {
    console.error(e.stack || String(e));
    process.exit(1);
});
