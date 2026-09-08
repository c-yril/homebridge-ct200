// Wrapper around the bosch-xmpp CLI, used by `npm run bosch` / `npm run zones`.
//
// The serial number and access key are printed in dash-separated groups on the
// back of the CT200, and the plugin itself accepts them either way. The CLI
// does not: a dash is part of the XMPP credentials it derives, so a value
// pasted as printed fails the login with "not-authorized", which reads as
// "wrong credentials" rather than "wrong formatting". Normalise the two keys
// so both forms work. The password is left alone: it is user-chosen, and a
// dash in it is a real character.
import { spawnSync } from 'node:child_process';

for (const name of ['BOSCH_XMPP_SERIAL_NUMBER', 'BOSCH_XMPP_ACCESS_KEY']) {
    const value = process.env[name];
    if (value) {
        process.env[name] = value.replace(/[\s-]/g, '');
    }
}

const { status, error } = spawnSync('bosch-xmpp', ['easycontrol', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
});

if (error) {
    throw error;
}

process.exit(status ?? 1);
