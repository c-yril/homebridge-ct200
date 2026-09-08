import {
    API,
    APIEvent,
    Characteristic,
    DynamicPlatformPlugin,
    Logging,
    PlatformAccessory,
    PlatformConfig,
    Service,
} from 'homebridge';
import type { BoschResponse } from 'bosch-xmpp';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { Thermostat } from './thermostat';
import { AwaySwitch } from './switch';
import { EP_ZONES, EP_LOCALIZATION, EP_HUMIDITY, EP_AWAY, EP_BZ, EP_BZ_MODE, EP_BZ_TARGET_TEMP } from './endpoints';
import { connectAPI, disconnectAPI, getEndpoint } from './client';

// All the info needed to describe a Zone
class Zone {
    id = 1;
    // Undefined until /zones/list reports a usable reading. Seeding it with a
    // number would publish an invented temperature to HomeKit, which reads as a
    // freezing room rather than as "no reading yet".
    currentTemp: number | undefined = undefined;
    wantedTemp = 10;
    state = 0;
    mode = 1;
    name = 'not initialized';
    accessory: PlatformAccessory;

    constructor(accessory: PlatformAccessory) {
        this.accessory = accessory;
        this.id = this.accessory.context.id;
        this.name = this.accessory.context.name;
    }
}

interface IAway {
    state: number;
    accessory?: PlatformAccessory;
}

// Global Bosch system status
class SystemStatus {
    zones: Map<number, Zone> = new Map();
    humidity = 0;
    away: IAway = {state: 0, accessory: undefined};
    localization = 0;
}

export const globalState = new SystemStatus();
export let globalLogger: Logging;

// The HAP definitions `processResponse` needs to push updates. They only become
// available once the platform is constructed, hence the module-level handles.
let hapService: typeof Service;
let hapCharacteristic: typeof Characteristic;

// Info returned by /zones/list
interface ResponseZone {
    id: number;
    name: string;
    icon: string;
    program: number;
    temp: number;
    status: string;
}

interface ConfigZone {
    index: number;
    name: string;
}

/** Coerces an API value to a number, or undefined when it isn't usable as one. */
function asNumber(value: unknown): number | undefined {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The Bosch API reports 1000 for a zone whose temperature it does not have -
 * a valve that has not reported yet, or a zone with no sensor bound to it.
 * Anything outside a plausible room temperature is that sentinel, not a
 * reading, and publishing it would trip HomeKit's own bounds.
 */
function isPlausibleTemperature(value: number): boolean {
    return Number.isFinite(value) && value > -50 && value < 100;
}

// Diagnostics are reported once rather than on every poll: the zone list is
// re-read every couple of minutes and a per-poll warning would bury the log.
let zoneListReported = false;
const zonesWithoutTemperature = new Set<number>();

/**
 * Logs what the CT200 actually exposes, and which configured zones do not
 * exist on it. A zone index that matches nothing is silent otherwise: the
 * accessory is created from the config alone, and simply never updates.
 */
function reportZoneList(zones: ResponseZone[]): void {
    if (zoneListReported) {
        return;
    }
    zoneListReported = true;

    globalLogger.info('Zones reported by the CT200: '
        + zones.map(zone => zone.id + ' = "' + zone.name + '" (' + zone.temp + ')').join(', '));

    const missing = [...globalState.zones.keys()].filter(id => !zones.some(zone => zone.id === id));
    if (missing.length > 0) {
        globalLogger.warn('Configured zone index ' + missing.join(', ') + ' does not exist on the CT200. '
            + 'Those accessories will never get a temperature - use one of the indexes listed above.');
    }
}

/** Drops the dashes and spaces a key is printed with. */
function withoutSeparators(value: unknown): string {
    return String(value).replace(/[\s-]/g, '');
}

export function processResponse(response: BoschResponse) {
    globalLogger.debug('Processing ' + response['id']);

    switch (response['id']) {
        case EP_ZONES: {
            const zones = response['value'] as ResponseZone[];
            reportZoneList(zones);

            zones.forEach((zone: ResponseZone) => {
                const savedZone = globalState.zones.get(zone.id);
                if (savedZone) {
                    const temperature = asNumber(zone.temp);
                    if (temperature !== undefined && isPlausibleTemperature(temperature)) {
                        savedZone.currentTemp = temperature;
                        zonesWithoutTemperature.delete(zone.id);
                    } else if (!zonesWithoutTemperature.has(zone.id)) {
                        zonesWithoutTemperature.add(zone.id);
                        globalLogger.warn('Zone ' + zone.id + ' ("' + zone.name + '") reports no usable '
                            + 'temperature (' + zone.temp + '). This is what the CT200 sends for a zone with '
                            + 'no thermostat or valve bound to it.');
                    }

                    savedZone.state = zone.status.includes('heat') ? 1 : 0;

                    const thermostat = savedZone.accessory.getService((hapService.Thermostat));
                    if (thermostat) {
                        if (savedZone.currentTemp !== undefined) {
                            thermostat.updateCharacteristic(hapCharacteristic.CurrentTemperature,
                                savedZone.currentTemp);
                        }

                        thermostat.updateCharacteristic(hapCharacteristic.CurrentHeatingCoolingState,
                            savedZone.state);
                    }
                    globalState.zones.set(zone.id, savedZone);
                }
            });

            break;
        }

        case EP_LOCALIZATION: {
            globalState.localization = response['value'] === 'Celsius' ? 0 : 1;
            globalState.zones.forEach((zone) => {
                const thermostat = zone.accessory.getService(hapService.Thermostat);
                if (thermostat) {
                    thermostat.updateCharacteristic(hapCharacteristic.TemperatureDisplayUnits, globalState.localization);
                }
            });

            break;
        }

        case EP_HUMIDITY: {
            const humidity = asNumber(response['value']);
            if (humidity === undefined) {
                globalLogger.debug('Ignoring unusable humidity value: ' + response['value']);
                break;
            }

            globalState.humidity = humidity;
            globalState.zones.forEach((zone) => {
                const thermostat = zone.accessory.getService(hapService.Thermostat);
                if (thermostat) {
                    thermostat.updateCharacteristic(hapCharacteristic.CurrentRelativeHumidity, globalState.humidity);
                }
            });
            break;
        }

        case EP_AWAY: {
            globalState.away.state = response['value'] === 'false' ? 0 : 1;
            if (globalState.away.accessory) {
                const modeSwitch = globalState.away.accessory.getService(hapService.Switch);
                if (modeSwitch) {
                    modeSwitch.updateCharacteristic(hapCharacteristic.On, globalState.away.state);
                }
            }
            break;
        }

        default: {
            const endpoint: string = response['id'];
            const id: number = parseInt(response['id'].replace(/[^0-9]/g, ''), 10);
            const savedZone = globalState.zones.get(id);
            if (savedZone) {
                const thermostat = savedZone.accessory.getService(hapService.Thermostat);
                if (thermostat) {
                    if (endpoint.includes(EP_BZ_MODE)) {
                        if (response['value'] === 'clock') {
                            savedZone.mode = 3;
                        } else {
                            savedZone.mode = 1;
                        }
                        thermostat.updateCharacteristic(hapCharacteristic.TargetHeatingCoolingState, savedZone.mode);
                    } else if (endpoint.includes(EP_BZ_TARGET_TEMP)) {
                        const wantedTemp = asNumber(response['value']);
                        if (wantedTemp === undefined) {
                            globalLogger.debug('Ignoring unusable target temperature: ' + response['value']);
                            break;
                        }
                        savedZone.wantedTemp = wantedTemp;
                        thermostat.updateCharacteristic(hapCharacteristic.TargetTemperature, savedZone.wantedTemp);
                    }
                }
                globalState.zones.set(id, savedZone);
            }
            break;
        }
    }
}

export class CT200Platform implements DynamicPlatformPlugin {
    public readonly Service: typeof Service;
    public readonly Characteristic: typeof Characteristic;
    public readonly accessories: PlatformAccessory[] = []; // Cache accessories

    private readonly timers: NodeJS.Timeout[] = [];

    constructor(
        public readonly log: Logging,
        public readonly config: PlatformConfig,
        public readonly api: API,
    ) {
        // Assigned here rather than as field initializers: with an ES2022 target
        // those would run before the `api` parameter property exists.
        this.Service = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;

        globalLogger = this.log;
        hapService = this.Service;
        hapCharacteristic = this.Characteristic;

        // Never exit the process on a bad config: under Homebridge 2 that turns
        // into an endless (child) bridge restart loop. Stay loaded and idle so
        // the user can fix the config in the UI.
        if (!config['serial'] || !config['access'] || !config['password'] || !config['zones']) {
            log.error('Config doesn\'t have needed values! Set access, serial, password and zones, then restart Homebridge.');
            return;
        }

        // Both keys are printed in dash-separated groups on the back of the
        // device. bosch-xmpp only strips those from the access key; the serial
        // number reaches the XMPP login verbatim and a pasted one is rejected
        // there. Accept either form rather than making the user spot that. The
        // password is left untouched: it is user-chosen, and a dash in it is a
        // real character.
        const serial = withoutSeparators(config['serial']);
        const access = withoutSeparators(config['access']);

        this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
            log.debug('Executed didFinishLaunching callback');

            // Accessories come from the config alone, so expose them before
            // talking to Bosch. HomeKit then stays populated (with cached
            // values) even while the backend is unreachable.
            if (!this.discoverDevices()) {
                return;
            }

            this.log.debug('Finished initializing platform:', this.config.platform);
            this.startPolling();

            connectAPI(serial, access, config['password'])
                .then(() => {
                    getEndpoint(EP_ZONES);
                    this.refreshCachedState();
                })
                .catch((e) => this.log.error('Failed to initialize platform: ' + e));
        });

        this.api.on(APIEvent.SHUTDOWN, () => {
            this.timers.forEach(timer => clearInterval(timer));
            this.timers.length = 0;
            disconnectAPI().catch((e) => this.log.debug('Failed to disconnect cleanly: ' + e));
        });
    }

    configureAccessory(accessory: PlatformAccessory) {
        this.accessories.push(accessory);
    }

    /** Registers the accessories described by the config. Returns false if the config is unusable. */
    discoverDevices(): boolean {
        if (!('zones' in this.config) || this.config['zones'].length === 0) {
            this.log.error('No zones defined! Add at least one zone to the plugin config, then restart Homebridge.');
            return false;
        }

        this.config['zones'].forEach((zone: ConfigZone) => {
            const uuid = this.api.hap.uuid.generate(zone.index.toString());
            const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
            if (existingAccessory) {
                this.log.debug('Restoring thermostat from cache:', existingAccessory.displayName, ' (', existingAccessory.context.id, ')');

                new Thermostat(this, existingAccessory);
                globalState.zones.set(zone.index, new Zone(existingAccessory));
            } else {
                this.log.debug('Adding new thermostat:', zone.name);
                const accessory = new this.api.platformAccessory(zone.name, uuid, this.api.hap.Categories.THERMOSTAT);

                accessory.context.id = zone.index;
                accessory.context.name = zone.name;

                new Thermostat(this, accessory);
                globalState.zones.set(zone.index, new Zone(accessory));
                this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            }
        });

        this.accessories.forEach(existingAccessory => {
            if (!this.config['zones'].find((configAccessory: ConfigZone) => existingAccessory.context.id === configAccessory.index)
               && existingAccessory.context.id !== undefined) {
                this.log.debug('Unregistering zone with index ' + existingAccessory.context.id);
                this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
            }
        });

        // By default, enable away mode switch
        const awayUUID = this.api.hap.uuid.generate('AWAY');
        const existingAway = this.accessories.find(accessory => accessory.UUID === awayUUID);
        if (!('away' in this.config) || this.config['away'] === true) {
            if (existingAway) {
                this.log.debug('Restoring Away switch from cache');
                new AwaySwitch(this, existingAway);
                globalState.away.accessory = existingAway;
            } else {
                this.log.debug('Creating new Away switch');
                const accessory = new this.api.platformAccessory('AWAY', awayUUID, this.api.hap.Categories.SWITCH);

                new AwaySwitch(this, accessory);
                globalState.away.accessory = accessory;
                this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            }
        } else {
            this.log.debug('Away switch disabled');
            if (existingAway) {
                this.log.debug('Unregistering existing away switch');
                this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAway]);
            }
        }

        return true;
    }

    startPolling() {
        // Configure zone info refresh
        let zoneInterval: number = 'zoneInterval' in this.config ? this.config['zoneInterval'] : 2;
        if (zoneInterval < 1) {
            this.log.warn('Zone refresh interval can\'t be less than 1! Setting to 1');
            zoneInterval = 1;
        }
        this.timers.push(setInterval(() => {
            globalLogger.debug('Updating zone status');
            getEndpoint(EP_ZONES);
        }, 1000 * 60 * zoneInterval));

        // Configure humidity, localization, away and per-zone refresh
        let auxInterval: number = 'auxInterval' in this.config ? this.config['auxInterval'] : 5;
        if (auxInterval < 1) {
            this.log.warn('Auxiliary refresh interval can\'t be less than 1! Setting to 1');
            auxInterval = 1;
        }
        this.timers.push(setInterval(() => {
            globalLogger.debug('Updating humidity, localization, target and away status');
            this.refreshCachedState();
        }, 1000 * 60 * auxInterval));
    }

    /**
     * Refreshes everything HomeKit reads from cache. Read handlers deliberately
     * never hit the network themselves, which would spike requests against the
     * Bosch backend whenever the Home app opens.
     */
    refreshCachedState() {
        getEndpoint(EP_HUMIDITY);
        getEndpoint(EP_LOCALIZATION);
        getEndpoint(EP_AWAY);
        globalState.zones.forEach((zone) => {
            getEndpoint(EP_BZ + zone.id + EP_BZ_TARGET_TEMP);
            getEndpoint(EP_BZ + zone.id + EP_BZ_MODE);
        });
    }
}
