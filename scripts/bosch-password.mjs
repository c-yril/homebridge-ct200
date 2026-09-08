// Finds which device password the CT200 is actually encrypting with.
//
// The XMPP login only uses the serial number and the access key, so a
// successful connection says nothing about the password: it is used solely to
// derive the AES key (MD5(accessKey||MAGIC) ++ MD5(MAGIC||password)). A wrong
// one therefore surfaces much later, as a reply that decrypts to noise and
// fails to parse as JSON - which reads like a broken device rather than like
// wrong credentials.
//
// So: fetch one encrypted reply from the device (a single request; the backend
// tolerates only one client at a time), then try candidate passwords against
// that ciphertext offline. A candidate is right when the plaintext parses as
// JSON. Candidates are typed at a hidden prompt and are never printed, written
// to disk or passed as an argument - only their length and the verdict show up.
import { createHash, createDecipheriv } from 'node:crypto';
import { EasyControlClient } from 'bosch-xmpp';

const MAGIC = Buffer.from('1d86b2631b02f2c7978b41e8a3ae609b0b2afbfd30ff386da60c586a827408e4', 'hex');
const ENDPOINT = '/gateway/versionFirmware';

const CTRL_C = '\u0003';
const BACKSPACE = '\u007f';

/** Drops the dashes and spaces the keys are printed with. */
function withoutSeparators(value) {
    return String(value ?? '').replace(/[\s-]/g, '');
}

/** The key bosch-xmpp derives, for an arbitrary password. */
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

function isCorrect(ciphertext, accessKey, password) {
    try {
        JSON.parse(decrypt(ciphertext, encryptionKey(accessKey, password)));
        return true;
    } catch {
        return false;
    }
}

/**
 * Grabs the raw, still-encrypted body of one reply. bosch-xmpp decrypts inside
 * get(), so the ciphertext is intercepted by replacing decrypt() on the
 * instance; the connection itself does not depend on the password.
 */
async function fetchCiphertext(serialNumber, accessKey) {
    const client = EasyControlClient({ serialNumber, accessKey, password: 'placeholder' });
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

const serialNumber = withoutSeparators(process.env.BOSCH_XMPP_SERIAL_NUMBER);
const accessKey = withoutSeparators(process.env.BOSCH_XMPP_ACCESS_KEY);

if (!serialNumber || !accessKey) {
    console.error('Set BOSCH_XMPP_SERIAL_NUMBER and BOSCH_XMPP_ACCESS_KEY (in .env) first.');
    process.exit(1);
}

console.log('Fetching one encrypted reply from the CT200 (stop Homebridge first if this hangs)...');
const ciphertext = await fetchCiphertext(serialNumber, accessKey);
console.log('Got it. Candidates are tested locally from here on, the device is not contacted again.\n');

// The value already in the environment is worth testing first: it says whether
// the env file delivers what the user thinks it does.
const fromEnv = process.env.BOSCH_XMPP_PASSWORD;
if (fromEnv && isCorrect(ciphertext, accessKey, fromEnv)) {
    console.log('BOSCH_XMPP_PASSWORD from the environment is CORRECT (length ' + fromEnv.length + ').');
    process.exit(0);
} else if (fromEnv) {
    console.log('BOSCH_XMPP_PASSWORD from the environment is wrong (length ' + fromEnv.length + ').');
}

for (;;) {
    const candidate = await askHidden('Password to try (empty to quit): ');
    if (candidate === '') {
        console.log('Nothing matched. The password is the personal one set in the EasyControl app '
            + '(Menu -> Settings -> Personal), not the Bosch SingleKey ID password. Set a new one '
            + 'there and try it.');
        break;
    }

    if (isCorrect(ciphertext, accessKey, candidate)) {
        console.log('MATCH - that is the device password (length ' + candidate.length + '). '
            + 'Put it in .env between single quotes, as BOSCH_XMPP_PASSWORD=\'...\'');
        break;
    }
    console.log('No - length ' + candidate.length + ', ' + Buffer.byteLength(candidate) + ' bytes.');
}
