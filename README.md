# homebridge-plugin-homewhiz

Homebridge dynamic platform plugin for HomeWhiz **Wi-Fi air conditioners**.

[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=flat)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

This repository currently targets a Wi-Fi AC scope:

- Wi-Fi/cloud connection only
- Air conditioner devices only
- No Bluetooth support

## Project Origin

- This project was started from a cloned codebase reference of the Home Assistant integration:
  - https://github.com/home-assistant-HomeWhiz/home-assistant-HomeWhiz
- The Home Assistant implementation was adapted and converted to a Homebridge plugin architecture with AI-assisted development/refactoring.
- Scope difference:
  - This repository focuses on **Homebridge + Wi-Fi cloud devices**.
  - **Bluetooth device support is intentionally not implemented** in this project.
  - The original Home Assistant project remains a separate project with its own architecture and feature set.

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

## Publish to npm

```bash
# 1) login once
npm login

# 2) verify package contents
npm pack --dry-run

# 3) publish current version
npm publish --access public
```

If you need a new release first:

```bash
npm version patch
npm publish --access public
```
