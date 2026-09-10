import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { CT200Platform, globalState } from './platform';
import { EP_DHW_MODE } from './endpoints';
import { setEndpoint } from './cloud/client';

/**
 * Read handlers answer from the cached state kept in `globalState`; the platform
 * refreshes that state on a timer. A reading that has never arrived throws
 * SERVICE_COMMUNICATION_FAILURE rather than publishing an invented value.
 */
function requireReading(platform: CT200Platform, value: number | undefined): CharacteristicValue {
    if (value === undefined) {
        throw new platform.api.hap.HapStatusError(platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return value;
}

/** Outdoor temperature, exposed as a standalone temperature sensor. */
export class OutdoorSensor {
    private service: Service;

    constructor(
        private readonly platform: CT200Platform,
        private readonly accessory: PlatformAccessory,
    ) {
        this.accessory.getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Bosch')
            .setCharacteristic(this.platform.Characteristic.Model, 'CT200')
            .setCharacteristic(this.platform.Characteristic.SerialNumber, 'CT200-outdoor');

        this.service = this.accessory.getService(this.platform.Service.TemperatureSensor)
            || this.accessory.addService(this.platform.Service.TemperatureSensor);
        this.service.setCharacteristic(this.platform.Characteristic.Name, 'Outdoor Temperature');

        this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
            // Outdoor temperatures legitimately drop below the HAP default floor of 0.
            .setProps({ minValue: -50, maxValue: 100 })
            .onGet(() => requireReading(this.platform, globalState.outdoor.temp));
    }
}

/**
 * Boiler status: the supply (flow) temperature plus a single fault indicator that
 * trips on an active notification, a maintenance request, or a refill request.
 */
export class BoilerStatus {
    private temperature: Service;
    private fault: Service;

    constructor(
        private readonly platform: CT200Platform,
        private readonly accessory: PlatformAccessory,
    ) {
        this.accessory.getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Bosch')
            .setCharacteristic(this.platform.Characteristic.Model, 'CT200')
            .setCharacteristic(this.platform.Characteristic.SerialNumber, 'CT200-boiler');

        this.temperature = this.accessory.getService(this.platform.Service.TemperatureSensor)
            || this.accessory.addService(this.platform.Service.TemperatureSensor, 'Boiler Flow', 'supply');
        this.temperature.setCharacteristic(this.platform.Characteristic.Name, 'Boiler Flow');
        this.temperature.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
            .setProps({ minValue: -50, maxValue: 150 })
            .onGet(() => requireReading(this.platform, globalState.boiler.supplyTemp));

        this.fault = this.accessory.getService(this.platform.Service.ContactSensor)
            || this.accessory.addService(this.platform.Service.ContactSensor, 'Boiler Fault', 'fault');
        this.fault.setCharacteristic(this.platform.Characteristic.Name, 'Boiler Fault');
        this.fault.getCharacteristic(this.platform.Characteristic.ContactSensorState)
            .onGet(() => globalState.boiler.fault
                ? this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
                : this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED);
        this.fault.getCharacteristic(this.platform.Characteristic.StatusFault)
            .onGet(() => globalState.boiler.fault
                ? this.platform.Characteristic.StatusFault.GENERAL_FAULT
                : this.platform.Characteristic.StatusFault.NO_FAULT);
    }
}

/**
 * Domestic hot water: a comfort/eco switch (operationMode high vs eco) plus the
 * current DHW temperature. On an instantaneous combi there is no settable DHW
 * setpoint, so only the mode is writable.
 */
export class HotWater {
    private mode: Service;
    private temperature: Service;

    constructor(
        private readonly platform: CT200Platform,
        private readonly accessory: PlatformAccessory,
    ) {
        this.accessory.getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Bosch')
            .setCharacteristic(this.platform.Characteristic.Model, 'CT200')
            .setCharacteristic(this.platform.Characteristic.SerialNumber, 'CT200-dhw');

        this.mode = this.accessory.getService(this.platform.Service.Switch)
            || this.accessory.addService(this.platform.Service.Switch, 'Hot Water Comfort', 'comfort');
        this.mode.setCharacteristic(this.platform.Characteristic.Name, 'Hot Water Comfort');
        this.mode.getCharacteristic(this.platform.Characteristic.On)
            .onGet(() => globalState.dhw.comfort === 1)
            .onSet(this.setComfort.bind(this));

        this.temperature = this.accessory.getService(this.platform.Service.TemperatureSensor)
            || this.accessory.addService(this.platform.Service.TemperatureSensor, 'Hot Water', 'temp');
        this.temperature.setCharacteristic(this.platform.Characteristic.Name, 'Hot Water');
        this.temperature.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
            .setProps({ minValue: -50, maxValue: 150 })
            .onGet(() => requireReading(this.platform, globalState.dhw.temp));
    }

    setComfort(value: CharacteristicValue): void {
        // Deliberately not awaited, see Thermostat.setTargetTemp.
        setEndpoint(EP_DHW_MODE, value ? 'high' : 'eco').then(response => {
            if (response === undefined) {
                this.platform.log.error('Received invalid response when setting hot water mode!');
            } else if (response['status'] !== 'ok') {
                this.platform.log.error('Failed to set hot water mode!');
            }
        });
    }
}
