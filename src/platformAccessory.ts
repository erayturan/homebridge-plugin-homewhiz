import type {
  CharacteristicValue,
  PlatformAccessory,
  Service,
} from 'homebridge';

import {
  readAcSnapshot,
  setFanPercent as buildFanSpeedCommand,
  setMode as buildModeCommands,
  setSwingMode as buildSwingCommand,
  setTargetTemperature as buildTargetTemperatureCommand,
  type AcControlProfile,
} from './acModel.js';
import { HomeWhizCloudClient } from './homewhizCloudClient.js';
import type { HomeWhizAccessoryContext } from './types.js';
import type { HomeWhizPlatform } from './platform.js';

const BRAND_NAMES = new Map<number, string>([
  [2, 'Grundig'],
  [3, 'Beko'],
  [4, 'Blomberg'],
  [5, 'Elektrabregenz'],
  [6, 'Arctic'],
  [7, 'Defy'],
  [8, 'Leisure'],
  [9, 'Flavel'],
  [10, 'Altus'],
  [11, 'Dawlance'],
  [12, 'Viking'],
  [13, 'Cylinda'],
  [14, 'Smeg'],
  [15, 'V-Zug'],
  [16, 'Lamona'],
  [17, 'Teka'],
  [18, 'Voltas Beko'],
  [36, 'Whirlpool'],
  [39, 'Bauknecht'],
]);

function defaultManufacturer(brandCode: number): string {
  return BRAND_NAMES.get(brandCode) ?? 'Arcelik';
}

export class HomeWhizPlatformAccessory {
  private readonly thermostat: Service;
  private readonly fanService?: Service;
  private unsubscribe?: () => void;

  constructor(
    private readonly platform: HomeWhizPlatform,
    private readonly accessory: PlatformAccessory<HomeWhizAccessoryContext>,
    private readonly profile: AcControlProfile,
    private readonly client: HomeWhizCloudClient,
  ) {
    const appliance = this.accessory.context.device;
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, defaultManufacturer(appliance.brand))
      .setCharacteristic(this.platform.Characteristic.Model, appliance.model)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, appliance.applianceId);

    this.thermostat = this.accessory.getService(this.platform.Service.Thermostat)
      ?? this.accessory.addService(this.platform.Service.Thermostat);
    this.thermostat.setCharacteristic(this.platform.Characteristic.Name, appliance.name);

    if (this.profile.targetTemperature) {
      this.thermostat.getCharacteristic(this.platform.Characteristic.TargetTemperature).setProps({
        minValue: this.profile.targetTemperature.lowerLimit,
        maxValue: this.profile.targetTemperature.upperLimit,
        minStep: this.profile.targetTemperature.step,
      });
    }

    this.thermostat.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onGet(this.getTargetHeatingCoolingState.bind(this))
      .onSet(this.setTargetHeatingCoolingState.bind(this));

    this.thermostat.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.getCurrentHeatingCoolingState.bind(this));

    this.thermostat.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));

    this.thermostat.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onGet(this.getTargetTemperature.bind(this))
      .onSet(this.setTargetTemperature.bind(this));

    this.thermostat.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(() => this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS);

    if (this.profile.fanMode || this.profile.swingHorizontal || this.profile.swingVertical) {
      this.fanService = this.accessory.getService(this.platform.Service.Fanv2)
        ?? this.accessory.addService(this.platform.Service.Fanv2, `${appliance.name} Fan`, 'fan');

      this.fanService.getCharacteristic(this.platform.Characteristic.Active)
        .onGet(this.getFanActive.bind(this))
        .onSet(this.setFanActive.bind(this));

      if (this.profile.fanMode) {
        this.fanService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
          .onGet(this.getFanSpeed.bind(this))
          .onSet(this.setFanSpeed.bind(this));
      }

      if (this.profile.swingHorizontal || this.profile.swingVertical) {
        this.fanService.getCharacteristic(this.platform.Characteristic.SwingMode)
          .onGet(this.getSwingMode.bind(this))
          .onSet(this.setSwingMode.bind(this));
      }
    }

    this.unsubscribe = this.client.onData(() => {
      this.refreshCharacteristics();
    });

    this.refreshCharacteristics();
  }

  dispose(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  private getSnapshot() {
    const data = this.client.currentData;
    if (!data) {
      return undefined;
    }
    return readAcSnapshot(data, this.profile);
  }

  private getTargetHeatingCoolingState(): CharacteristicValue {
    const snapshot = this.getSnapshot();
    if (!snapshot) {
      return this.platform.Characteristic.TargetHeatingCoolingState.OFF;
    }
    if (!snapshot.power || snapshot.mode === 'off') {
      return this.platform.Characteristic.TargetHeatingCoolingState.OFF;
    }
    if (snapshot.mode === 'heat') {
      return this.platform.Characteristic.TargetHeatingCoolingState.HEAT;
    }
    if (snapshot.mode === 'cool') {
      return this.platform.Characteristic.TargetHeatingCoolingState.COOL;
    }
    return this.platform.Characteristic.TargetHeatingCoolingState.AUTO;
  }

  private getCurrentHeatingCoolingState(): CharacteristicValue {
    const snapshot = this.getSnapshot();
    if (!snapshot || !snapshot.power || snapshot.mode === 'off') {
      return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
    }
    if (snapshot.mode === 'heat') {
      return this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
    }
    return this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
  }

  private getCurrentTemperature(): CharacteristicValue {
    const snapshot = this.getSnapshot();
    if (!snapshot) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    return snapshot.currentTemperature ?? snapshot.targetTemperature ?? 20;
  }

  private getTargetTemperature(): CharacteristicValue {
    const snapshot = this.getSnapshot();
    if (!snapshot) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    return snapshot.targetTemperature ?? 20;
  }

  private async setTargetTemperature(value: CharacteristicValue): Promise<void> {
    const command = buildTargetTemperatureCommand(this.profile, Number(value));
    if (!command) {
      return;
    }
    await this.platform.sendCommand(this.accessory.context.device.applianceId, command);
  }

  private async setTargetHeatingCoolingState(value: CharacteristicValue): Promise<void> {
    const data = this.client.currentData;
    if (!data) {
      return;
    }

    const state = Number(value);
    const mode = state === this.platform.Characteristic.TargetHeatingCoolingState.OFF
      ? 'off'
      : state === this.platform.Characteristic.TargetHeatingCoolingState.HEAT
        ? 'heat'
        : state === this.platform.Characteristic.TargetHeatingCoolingState.COOL
          ? 'cool'
          : 'auto';

    const commands = buildModeCommands(this.profile, mode, data);
    await this.platform.sendCommands(this.accessory.context.device.applianceId, commands);
  }

  private getFanActive(): CharacteristicValue {
    const snapshot = this.getSnapshot();
    if (!snapshot?.power) {
      return this.platform.Characteristic.Active.INACTIVE;
    }
    return this.platform.Characteristic.Active.ACTIVE;
  }

  private async setFanActive(value: CharacteristicValue): Promise<void> {
    const data = this.client.currentData;
    if (!data) {
      return;
    }
    const targetMode = Number(value) === this.platform.Characteristic.Active.ACTIVE ? 'auto' : 'off';
    const commands = buildModeCommands(this.profile, targetMode, data);
    await this.platform.sendCommands(this.accessory.context.device.applianceId, commands);
  }

  private getFanSpeed(): CharacteristicValue {
    const snapshot = this.getSnapshot();
    return snapshot?.fanPercent ?? 0;
  }

  private async setFanSpeed(value: CharacteristicValue): Promise<void> {
    const command = buildFanSpeedCommand(this.profile, Number(value));
    if (!command) {
      return;
    }
    await this.platform.sendCommand(this.accessory.context.device.applianceId, command);
  }

  private getSwingMode(): CharacteristicValue {
    const snapshot = this.getSnapshot();
    if (!snapshot?.swingMode) {
      return this.platform.Characteristic.SwingMode.SWING_DISABLED;
    }
    return this.platform.Characteristic.SwingMode.SWING_ENABLED;
  }

  private async setSwingMode(value: CharacteristicValue): Promise<void> {
    const command = buildSwingCommand(
      this.profile,
      Number(value) === this.platform.Characteristic.SwingMode.SWING_ENABLED,
    );
    if (!command) {
      return;
    }
    await this.platform.sendCommand(this.accessory.context.device.applianceId, command);
  }

  private refreshCharacteristics(): void {
    const snapshot = this.getSnapshot();
    if (!snapshot) {
      return;
    }

    this.thermostat.updateCharacteristic(
      this.platform.Characteristic.CurrentTemperature,
      snapshot.currentTemperature ?? snapshot.targetTemperature ?? 20,
    );
    this.thermostat.updateCharacteristic(
      this.platform.Characteristic.TargetTemperature,
      snapshot.targetTemperature ?? 20,
    );
    this.thermostat.updateCharacteristic(
      this.platform.Characteristic.TargetHeatingCoolingState,
      this.getTargetHeatingCoolingState(),
    );
    this.thermostat.updateCharacteristic(
      this.platform.Characteristic.CurrentHeatingCoolingState,
      this.getCurrentHeatingCoolingState(),
    );

    if (this.fanService) {
      this.fanService.updateCharacteristic(
        this.platform.Characteristic.Active,
        snapshot.power
          ? this.platform.Characteristic.Active.ACTIVE
          : this.platform.Characteristic.Active.INACTIVE,
      );
      if (this.profile.fanMode && snapshot.fanPercent !== undefined) {
        this.fanService.updateCharacteristic(
          this.platform.Characteristic.RotationSpeed,
          snapshot.fanPercent,
        );
      }
      if (snapshot.swingMode !== undefined) {
        this.fanService.updateCharacteristic(
          this.platform.Characteristic.SwingMode,
          snapshot.swingMode
            ? this.platform.Characteristic.SwingMode.SWING_ENABLED
            : this.platform.Characteristic.SwingMode.SWING_DISABLED,
        );
      }
    }
  }
}
