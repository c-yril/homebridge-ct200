import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { CT200Platform, globalState } from './platform';
import { EP_BZ, EP_BZ_MODE, EP_BZ_TARGET_TEMP, EP_BZ_MANUAL_TEMP } from './endpoints';
import { getEndpoint, setEndpoint } from './cloud/client';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 *
 * All read handlers answer from the cached state kept in `globalState`; the
 * platform refreshes that state on a timer.
 */
export class Thermostat {
    private service: Service;
    private id: number;

    constructor(
        private readonly platform: CT200Platform,
        private readonly accessory: PlatformAccessory,
    ) {

        // set accessory information
        this.accessory.getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Bosch')
            .setCharacteristic(this.platform.Characteristic.Model, 'CT200')
            // Not the Bosch serial number: it is one of the three login
            // credentials, and this characteristic is persisted to
            // cachedAccessories and readable by every paired controller.
            .setCharacteristic(this.platform.Characteristic.SerialNumber, 'CT200-zone-' + accessory.context.id);

        this.service = this.accessory.getService(this.platform.Service.Thermostat)
            || this.accessory.addService(this.platform.Service.Thermostat);

        this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.name);
        this.id = this.accessory.context.id;

        this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature) // Global
            .onGet(this.getCurrentTemp.bind(this));

        this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature) // Per device
            .onGet(this.getTargetTemp.bind(this))
            .onSet(this.setTargetTemp.bind(this))
            .setProps({ // TODO This could potentially break for users using fahrenheit! (More testing is required)
                minValue: 5,
                maxValue: 30,
                minStep: 0.5, // The Bosch API only accepts half-degree steps
            });

        this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState) // Global
            .onGet(this.getCurrentState.bind(this));

        // 1 = manual, 3 = auto ('clock' in the Bosch app). HAP defaults this
        // characteristic to 0 (Off) and a restored accessory may hold any value,
        // so seed a valid one before narrowing the props - otherwise HAP warns
        // that the current value isn't in the valid values array.
        const targetState = this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState);
        if (targetState.value !== 1 && targetState.value !== 3) {
            targetState.updateValue(1);
        }
        targetState // Per device
            .onGet(this.getTargetState.bind(this))
            .onSet(this.setTargetState.bind(this))
            .setProps({
                validValues: [1, 3],
            });

        this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits) // Global
            .onGet(this.getDisplayUnits.bind(this))
            .onSet(this.setDisplayUnits.bind(this));

        this.service.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
            .onGet(this.getRelativeHumidity.bind(this));

    }

    async getCurrentTemp(): Promise<CharacteristicValue> {
        const zone = globalState.zones.get(this.id);
        if (!zone) {
            this.platform.log.error('Zone undefined while getting current temperature!');
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }

        // Before the first usable reading there is nothing honest to answer.
        // Reporting a placeholder here is what makes an unbound or mis-indexed
        // zone show up in the Home app as a room at 0 degrees.
        if (zone.currentTemp === undefined) {
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }

        return zone.currentTemp;
    }

    async getTargetTemp(): Promise<CharacteristicValue> {
        const zone = globalState.zones.get(this.id);
        if (zone) {
            return zone.wantedTemp;
        } else {
            this.platform.log.error('Zone undefined while getting target temperature!');
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    setTargetTemp(value: CharacteristicValue): void {
        // API only allows changing in steps of 0.5
        // TODO Query step size from API instead of hardcoding value
        const nearestHalfDecimal = Math.round(value as number / 0.5) * 0.5;

        // Deliberately not awaited: writes share the request queue with the
        // refresh GETs, and HomeKit times a write handler out long before a
        // backed-up queue would drain.
        setEndpoint(EP_BZ + this.id + EP_BZ_MANUAL_TEMP, nearestHalfDecimal).then(response => {
            if (response === undefined) {
                this.platform.log.error('Received invalid response when setting temperature!');
            } else if (response['status'] !== 'ok') {
                this.platform.log.error('Failed to set temperature!');
            }
        });
    }

    async getCurrentState(): Promise<CharacteristicValue> {
        const zone = globalState.zones.get(this.id);
        if (zone) {
            return zone.state;
        } else {
            this.platform.log.error('Zone undefined while getting current state!');
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    async getTargetState(): Promise<CharacteristicValue> {
        const zone = globalState.zones.get(this.id);
        if (zone) {
            return zone.mode;
        } else {
            this.platform.log.error('Zone undefined while getting target state!');
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    setTargetState(value: CharacteristicValue): void {
        setEndpoint(EP_BZ + this.id + EP_BZ_MODE, value === 3 ? 'clock' : 'manual').then(response => {
            if (response === undefined) {
                this.platform.log.error('Received invalid response when setting state!');
            } else if (response['status'] === 'ok') {
                // Update value when state is modified
                getEndpoint(EP_BZ + this.id + EP_BZ_TARGET_TEMP);
            } else {
                this.platform.log.error('Failed to set state!');
            }
        });
    }

    // Also a global property
    async getDisplayUnits(): Promise<CharacteristicValue> {
        return globalState.localization;
    }

    async setDisplayUnits(value: CharacteristicValue) {
        this.platform.log.warn('Setting temperature units to ' + value + ' failed! Change in bosch app!');
    }

    // This is a global property
    async getRelativeHumidity(): Promise<CharacteristicValue> {
        return globalState.humidity;
    }
}
