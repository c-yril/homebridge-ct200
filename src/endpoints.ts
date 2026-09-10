// File contains definitions of used endpoints

// Away mode get/set endpoint
export const EP_AWAY = '/system/awayMode/enabled';

// Geofencing / presence auto-away get/set endpoint
export const EP_AUTO_AWAY = '/system/autoAway/enabled';

// Array of zones, with current temp and status
export const EP_ZONES = '/zones/list';

// Data localization (Celsius or Fahrenheit)
export const EP_LOCALIZATION = '/gateway/localisation';

// Relative humidity
export const EP_HUMIDITY = '/system/sensors/humidity/indoor_h1';

// Outdoor temperature sensor (virtual/weather or wired)
export const EP_OUTDOOR = '/system/sensors/temperatures/outdoor_t1';

// Active fault list (empty array = no faults)
export const EP_NOTIFICATIONS = '/notifications';

// Appliance maintenance request flag
export const EP_MAINTENANCE = '/system/appliance/maintenanceRequest';

// Boiler needs a water refill (low pressure) flag
export const EP_REFILL = '/heatSources/refillNeeded';

// Boiler supply (flow) temperature
export const EP_SUPPLY_TEMP = '/heatSources/actualSupplyTemperature';

// Domestic hot water current temperature (combi: only meaningful while drawing)
export const EP_DHW_TEMP = '/dhwCircuits/dhw1/actualTemp';

// Domestic hot water operation mode (high/eco/off/ownprogram) get/set endpoint
export const EP_DHW_MODE = '/dhwCircuits/dhw1/operationMode';

// Heating boost get/set endpoint
export const EP_BOOST = '/heatingCircuits/hc1/boostMode';

// Device list root (eTRV radiator valves); enumerated by the client, not polled here
export const EP_DEVICES = '/devices';

// Endpoints which start with /zones/zn(index)
export const EP_BZ = '/zones/zn';

// Target temperature get/set endpoint
export const EP_BZ_TARGET_TEMP = '/temperatureHeatingSetpoint';

// Manual-mode target temperature (applied while userMode is "manual")
export const EP_BZ_MANUAL_TEMP = '/manualTemperatureHeating';

// Clock-override target temperature (applied while userMode is "clock"/auto)
export const EP_BZ_CLOCK_OVERRIDE_TEMP = '/clockOverride/temperatureHeating';

// Heating mode (auto/manual) get/set endpoint
export const EP_BZ_MODE = '/userMode';
