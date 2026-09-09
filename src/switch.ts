import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { CT200Platform, globalState } from './platform';
import { EP_AWAY, EP_BZ, EP_BZ_TARGET_TEMP } from './endpoints';
import { getEndpoint, setEndpoint } from './cloud/client';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class AwaySwitch {
    private service: Service;

    constructor(
        private readonly platform: CT200Platform,
        private readonly accessory: PlatformAccessory,
    ) {

        // set accessory information
        this.accessory.getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Bosch')
            .setCharacteristic(this.platform.Characteristic.Model, 'CT200')
            // Not the Bosch serial number, see Thermostat's accessory information.
            .setCharacteristic(this.platform.Characteristic.SerialNumber, 'CT200-away');

        this.service = this.accessory.getService(this.platform.Service.Switch)
            || this.accessory.addService(this.platform.Service.Switch);

        this.service.setCharacteristic(this.platform.Characteristic.Name, 'CT200 Away Mode');

        this.service.getCharacteristic(this.platform.Characteristic.On)
            .onGet(this.getAwayStatus.bind(this))
            .onSet(this.setAwayStatus.bind(this));
    }

    async getAwayStatus(): Promise<CharacteristicValue> {
        return globalState.away.state;
    }

    setAwayStatus(value: CharacteristicValue): void {
        const command = value ? '"true"' : '"false"';

        // Deliberately not awaited, see Thermostat.setTargetTemp.
        setEndpoint(EP_AWAY, command).then(response => {
            if (response === undefined) {
                this.platform.log.error('Received invalid response when setting away mode!');
            } else if (response['status'] === 'ok') {
                // Update zone temperatures after changing state
                globalState.zones.forEach((zone) => {
                    getEndpoint(EP_BZ + zone.id + EP_BZ_TARGET_TEMP);
                });
            } else {
                this.platform.log.error('Failed to set away mode!');
            }
        });
    }
}
