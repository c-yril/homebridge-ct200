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
import type { BoschResponse } from './cloud/types';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { Thermostat } from './thermostat';
import { AwaySwitch, BoschToggleSwitch } from './switch';
import { OutdoorSensor, BoilerStatus, HotWater } from './sensors';
import {
    EP_ZONES, EP_LOCALIZATION, EP_HUMIDITY, EP_AWAY, EP_AUTO_AWAY, EP_BZ, EP_BZ_MODE, EP_BZ_TARGET_TEMP,
    EP_OUTDOOR, EP_NOTIFICATIONS, EP_MAINTENANCE, EP_REFILL, EP_SUPPLY_TEMP, EP_DHW_TEMP, EP_DHW_MODE, EP_BOOST,
} from './endpoints';
import { connectAPI, disconnectAPI, getEndpoint, getDevices } from './cloud/client';

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
    // Low-battery flag for the eTRV bound to this zone: 0 = normal, 1 = low.
    // Undefined until a valve reports; a zone with no valve never gets a battery service.
    batteryLow: number | undefined = undefined;
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

// A single accessory carrying an outdoor temperature reading.
interface IOutdoor {
    temp: number | undefined;
    accessory?: PlatformAccessory;
}

// Boiler status: supply temperature and a combined fault flag. The fault is the
// OR of three independent sources, tracked separately so each can update alone.
interface IBoiler {
    supplyTemp: number | undefined;
    faultNotification: boolean;
    faultMaintenance: boolean;
    faultRefill: boolean;
    fault: number;
    accessory?: PlatformAccessory;
}

// Domestic hot water: current temperature and comfort/eco mode (1 = comfort/high).
interface IHotWater {
    temp: number | undefined;
    comfort: number;
    accessory?: PlatformAccessory;
}

// A plain toggle (boost, auto-away): 0 = off, 1 = on.
interface IToggle {
    state: number;
    accessory?: PlatformAccessory;
}

// Global Bosch system status
class SystemStatus {
    zones: Map<number, Zone> = new Map();
    humidity = 0;
    away: IAway = {state: 0, accessory: undefined};
    autoAway: IToggle = {state: 0, accessory: undefined};
    localization = 0;
    outdoor: IOutdoor = {temp: undefined, accessory: undefined};

    boiler: IBoiler = {
        supplyTemp: undefined, faultNotification: false, faultMaintenance: false,
        faultRefill: false, fault: 0, accessory: undefined,
    };

    dhw: IHotWater = {temp: undefined, comfort: 0, accessory: undefined};
    boost: IToggle = {state: 0, accessory: undefined};
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
    return Number.isFinite(value) && value > -50 && value < 150;
}

/** Coerces a Bosch binary/flag value (true/"true"/"on"/1) to a boolean. */
function isEnabled(value: unknown): boolean {
    return value === true || value === 'true' || value === 'on' || value === 1;
}

/**
 * Recomputes the combined boiler fault from its three sources and pushes it to
 * the contact sensor. A fault is any active notification, maintenance request,
 * or refill request.
 */
function refreshBoilerFault(): void {
    const boiler = globalState.boiler;
    boiler.fault = (boiler.faultNotification || boiler.faultMaintenance || boiler.faultRefill) ? 1 : 0;
    if (!boiler.accessory) {
        return;
    }
    const contact = boiler.accessory.getService(hapService.ContactSensor);
    if (contact) {
        contact.updateCharacteristic(hapCharacteristic.ContactSensorState,
            boiler.fault
                ? hapCharacteristic.ContactSensorState.CONTACT_NOT_DETECTED
                : hapCharacteristic.ContactSensorState.CONTACT_DETECTED);
        contact.updateCharacteristic(hapCharacteristic.StatusFault,
            boiler.fault
                ? hapCharacteristic.StatusFault.GENERAL_FAULT
                : hapCharacteristic.StatusFault.NO_FAULT);
    }
}

// Diagnostics are reported once rather than on every poll: the zone list is
// re-read every couple of minutes and a per-poll warning would bury the log.
let zoneListReported = false;
const zonesWithoutTemperature = new Set<number>();
// Valve zones with no matching configured zone; warned about once each.
const reportedMissingValveZones = new Set<number>();

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

        case EP_AUTO_AWAY: {
            globalState.autoAway.state = isEnabled(response['value']) ? 1 : 0;
            if (globalState.autoAway.accessory) {
                const toggle = globalState.autoAway.accessory.getService(hapService.Switch);
                if (toggle) {
                    toggle.updateCharacteristic(hapCharacteristic.On, globalState.autoAway.state);
                }
            }
            break;
        }

        case EP_BOOST: {
            globalState.boost.state = isEnabled(response['value']) ? 1 : 0;
            if (globalState.boost.accessory) {
                const toggle = globalState.boost.accessory.getService(hapService.Switch);
                if (toggle) {
                    toggle.updateCharacteristic(hapCharacteristic.On, globalState.boost.state);
                }
            }
            break;
        }

        case EP_OUTDOOR: {
            const temperature = asNumber(response['value']);
            if (temperature === undefined || !isPlausibleTemperature(temperature)) {
                globalLogger.debug('Ignoring unusable outdoor temperature: ' + response['value']);
                break;
            }
            globalState.outdoor.temp = temperature;
            if (globalState.outdoor.accessory) {
                const sensor = globalState.outdoor.accessory.getService(hapService.TemperatureSensor);
                if (sensor) {
                    sensor.updateCharacteristic(hapCharacteristic.CurrentTemperature, temperature);
                }
            }
            break;
        }

        case EP_SUPPLY_TEMP: {
            const temperature = asNumber(response['value']);
            if (temperature === undefined || !isPlausibleTemperature(temperature)) {
                globalLogger.debug('Ignoring unusable boiler supply temperature: ' + response['value']);
                break;
            }
            globalState.boiler.supplyTemp = temperature;
            if (globalState.boiler.accessory) {
                const sensor = globalState.boiler.accessory.getService(hapService.TemperatureSensor);
                if (sensor) {
                    sensor.updateCharacteristic(hapCharacteristic.CurrentTemperature, temperature);
                }
            }
            break;
        }

        case EP_NOTIFICATIONS: {
            // The fault list may arrive as a bare array or wrapped (e.g. errorList).
            const raw = response['value'];
            let count = 0;
            if (Array.isArray(raw)) {
                count = raw.length;
            } else if (raw && typeof raw === 'object') {
                const obj = raw as Record<string, unknown>;
                const inner = obj.errorList ?? obj.values ?? obj.value;
                if (Array.isArray(inner)) {
                    count = inner.length;
                }
            }

            const active = count > 0;
            globalState.boiler.faultNotification = active;
            if (active) {
                globalLogger.warn('CT200 reports ' + count + ' active notification(s)/fault(s). '
                    + 'Check the Bosch app for details.');
            }
            refreshBoilerFault();
            break;
        }

        case EP_MAINTENANCE: {
            globalState.boiler.faultMaintenance = isEnabled(response['value']);
            if (globalState.boiler.faultMaintenance) {
                globalLogger.warn('CT200 reports a maintenance request.');
            }
            refreshBoilerFault();
            break;
        }

        case EP_REFILL: {
            globalState.boiler.faultRefill = isEnabled(response['value']);
            if (globalState.boiler.faultRefill) {
                globalLogger.warn('CT200 reports the boiler needs a water refill (low pressure).');
            }
            refreshBoilerFault();
            break;
        }

        case EP_DHW_TEMP: {
            const temperature = asNumber(response['value']);
            if (temperature === undefined || !isPlausibleTemperature(temperature)) {
                globalLogger.debug('Ignoring unusable hot water temperature: ' + response['value']);
                break;
            }
            globalState.dhw.temp = temperature;
            if (globalState.dhw.accessory) {
                const sensor = globalState.dhw.accessory.getService(hapService.TemperatureSensor);
                if (sensor) {
                    sensor.updateCharacteristic(hapCharacteristic.CurrentTemperature, temperature);
                }
            }
            break;
        }

        case EP_DHW_MODE: {
            globalState.dhw.comfort = response['value'] === 'high' ? 1 : 0;
            if (globalState.dhw.accessory) {
                const modeSwitch = globalState.dhw.accessory.getService(hapService.Switch);
                if (modeSwitch) {
                    modeSwitch.updateCharacteristic(hapCharacteristic.On, globalState.dhw.comfort);
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
        if (!config['refreshToken'] || !config['zones']) {
            log.error('Config doesn\'t have needed values! Log in to Bosch in the plugin settings and '
                + 'add at least one zone, then restart Homebridge.');
            return;
        }

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

            connectAPI({ refreshToken: config['refreshToken'], storagePath: this.api.user.storagePath() })
                .then(() => {
                    getEndpoint(EP_ZONES);
                    this.refreshCachedState();
                    this.updateDevices().catch((e) => this.log.debug('Initial device update failed: ' + e));
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

        // Optional feature accessories. Each defaults on (opt-out) except boost,
        // which is opt-in. A disabled feature unregisters any accessory it left
        // in the cache, so toggling it off in the config removes it from HomeKit.
        const enabled = (key: string, byDefault: boolean): boolean =>
            key in this.config ? this.config[key] === true : byDefault;

        globalState.away.accessory = this.ensureAccessory(
            enabled('away', true), 'AWAY', 'AWAY', this.api.hap.Categories.SWITCH,
            (accessory) => new AwaySwitch(this, accessory));

        globalState.autoAway.accessory = this.ensureAccessory(
            enabled('autoAway', true), 'AUTO_AWAY', 'CT200 Auto Away', this.api.hap.Categories.SWITCH,
            (accessory) => new BoschToggleSwitch(this, accessory, {
                name: 'CT200 Auto Away', serial: 'autoaway', endpoint: EP_AUTO_AWAY,
                onValue: 'true', offValue: 'false', getState: () => globalState.autoAway.state, label: 'auto away',
            }));

        globalState.boost.accessory = this.ensureAccessory(
            enabled('boost', false), 'BOOST', 'CT200 Heating Boost', this.api.hap.Categories.SWITCH,
            (accessory) => new BoschToggleSwitch(this, accessory, {
                name: 'CT200 Heating Boost', serial: 'boost', endpoint: EP_BOOST,
                onValue: 'on', offValue: 'off', getState: () => globalState.boost.state, label: 'heating boost',
            }));

        globalState.outdoor.accessory = this.ensureAccessory(
            enabled('outdoor', true), 'OUTDOOR', 'Outdoor Temperature', this.api.hap.Categories.SENSOR,
            (accessory) => new OutdoorSensor(this, accessory));

        globalState.boiler.accessory = this.ensureAccessory(
            enabled('boiler', true), 'BOILER', 'Boiler', this.api.hap.Categories.SENSOR,
            (accessory) => new BoilerStatus(this, accessory));

        globalState.dhw.accessory = this.ensureAccessory(
            enabled('dhw', true), 'DHW', 'Hot Water', this.api.hap.Categories.SWITCH,
            (accessory) => new HotWater(this, accessory));

        return true;
    }

    /**
     * Restores or creates a single accessory identified by `seed`, or unregisters
     * it when the feature is disabled. Returns the live accessory, or undefined
     * when disabled.
     */
    private ensureAccessory(
        featureEnabled: boolean,
        seed: string,
        displayName: string,
        category: number,
        attach: (accessory: PlatformAccessory) => void,
    ): PlatformAccessory | undefined {
        const uuid = this.api.hap.uuid.generate(seed);
        const existing = this.accessories.find(accessory => accessory.UUID === uuid);

        if (featureEnabled) {
            if (existing) {
                this.log.debug('Restoring ' + displayName + ' from cache');
                attach(existing);
                return existing;
            }
            this.log.debug('Creating new ' + displayName);
            const accessory = new this.api.platformAccessory(displayName, uuid, category);
            attach(accessory);
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            return accessory;
        }

        if (existing) {
            this.log.debug('Unregistering ' + displayName);
            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existing]);
        }
        return undefined;
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

        // Radiator valve battery status changes slowly; poll it on its own slow
        // timer to keep the extra per-device requests off the main refresh path.
        let deviceInterval: number = 'deviceInterval' in this.config ? this.config['deviceInterval'] : 30;
        if (deviceInterval < 1) {
            this.log.warn('Device refresh interval can\'t be less than 1! Setting to 1');
            deviceInterval = 1;
        }
        this.timers.push(setInterval(() => {
            globalLogger.debug('Updating radiator valve status');
            this.updateDevices().catch((e) => this.log.debug('Device update failed: ' + e));
        }, 1000 * 60 * deviceInterval));
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

        // Only poll the resources whose feature accessory is actually enabled.
        if (globalState.autoAway.accessory) {
            getEndpoint(EP_AUTO_AWAY);
        }
        if (globalState.outdoor.accessory) {
            getEndpoint(EP_OUTDOOR);
        }
        if (globalState.boiler.accessory) {
            getEndpoint(EP_SUPPLY_TEMP);
            getEndpoint(EP_NOTIFICATIONS);
            getEndpoint(EP_MAINTENANCE);
            getEndpoint(EP_REFILL);
        }
        if (globalState.dhw.accessory) {
            getEndpoint(EP_DHW_TEMP);
            getEndpoint(EP_DHW_MODE);
        }
        if (globalState.boost.accessory) {
            getEndpoint(EP_BOOST);
        }
    }

    /**
     * Reads the paired radiator valves and reflects each valve's battery status
     * onto its zone's thermostat accessory (as a Battery service). A valve whose
     * zone is not in the config is skipped. Battery info comes from a different
     * resource shape than the flat resources, so it is fetched via getDevices()
     * rather than the getEndpoint/processResponse path.
     */
    async updateDevices(): Promise<void> {
        const batteryEnabled = 'battery' in this.config ? this.config['battery'] === true : true;
        if (!batteryEnabled) {
            return;
        }

        const devices = await getDevices();
        devices.forEach((device) => {
            // The controller itself reports as a "thermostat" with no user-replaceable
            // battery; only the radiator valves carry a real battery status.
            if (device.type !== 'thermostat_valve') {
                return;
            }

            const zone = globalState.zones.get(device.zone);
            if (!zone) {
                if (!reportedMissingValveZones.has(device.zone)) {
                    reportedMissingValveZones.add(device.zone);
                    this.log.info('Radiator valve "' + device.name + '" is on zone ' + device.zone
                        + ', which is not in your config; its battery status is not shown. '
                        + 'Add a zone with that index to see it.');
                }
                return;
            }

            const low = device.battery === 'low' ? 1 : 0;
            zone.batteryLow = low;
            this.log.debug('Valve "' + device.name + '" on zone ' + device.zone
                + ' reports battery=' + device.battery + ' signal=' + device.signal);

            let battery = zone.accessory.getService(this.Service.Battery);
            if (!battery) {
                battery = zone.accessory.addService(this.Service.Battery, 'Valve Battery', 'valve-battery');
                battery.getCharacteristic(this.Characteristic.StatusLowBattery)
                    .onGet(() => zone.batteryLow ?? 0);
            }
            battery.updateCharacteristic(this.Characteristic.StatusLowBattery, low);
        });
    }
}
