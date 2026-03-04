# homebridge-plugin-homewhiz

Homebridge dynamic platform plugin for HomeWhiz **Wi-Fi air conditioners**.

This repository currently targets a Wi-Fi AC scope:

- Wi-Fi/cloud connection only
- Air conditioner devices only
- No Bluetooth support

## Implemented

- Login to HomeWhiz cloud
- Discover appliances from account
- Filter to air conditioners (`applianceType = 9`)
- Build per-device AC control profile from HomeWhiz configuration payload
- Connect to AWS IoT MQTT shadow for state updates
- Send write commands for:
  - Power (on/off)
  - HVAC mode (off/auto/cool/heat + dry/fan where available)
  - Target temperature
  - Fan speed (when device exposes fan control)
  - Swing mode (vertical/horizontal; both axes if available)
  - Jet/Preset mode (when device exposes jet control)
- HomeKit services:
  - `Thermostat`
  - `Fanv2` (optional, if supported by the device profile)
  - `Switch` services for advanced controls (optional):
    - Jet
    - Dry mode
    - Fan-only mode

## Install

```bash
npm install
npm run build
npm link
```

Then start Homebridge with debug logs:

```bash
homebridge -D
```

## Homebridge Config

```json
{
  "platforms": [
    {
      "name": "HomeWhiz",
      "platform": "HomeWhiz",
      "username": "your-homewhiz-email@example.com",
      "password": "your-homewhiz-password",
      "language": "en-GB",
      "pollIntervalSeconds": 60,
      "applianceIds": [],
      "includeBluetoothDevices": false
    }
  ]
}
```

## Notes

- `includeBluetoothDevices` is `false` by default. Keep it disabled for this MVP.
- `applianceIds` is optional. If set, only listed appliance IDs are exposed.
- The plugin refreshes shadow state periodically and also after each command.

## Development

```bash
npm run lint
npm run build
npm run watch
```
