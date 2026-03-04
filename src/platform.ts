import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  Service,
} from 'homebridge';

import {
  extractAcControlProfile,
  type AcControlProfile,
} from './acModel.js';
import { HomeWhizApi } from './homewhizApi.js';
import { HomeWhizCloudClient } from './homewhizCloudClient.js';
import { HomeWhizPlatformAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import type {
  HomeWhizAccessoryContext,
  HomeWhizApplianceInfo,
  HomeWhizCloudConfig,
  HomeWhizCommand,
  HomeWhizCredentials,
  HomeWhizPlatformConfig,
} from './types.js';
import {
  AIR_CONDITIONER_APPLIANCE_TYPE,
  isBluetoothConnectivity,
} from './types.js';

export class HomeWhizPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: Map<string, PlatformAccessory<HomeWhizAccessoryContext>> = new Map();

  private readonly discoveredCacheUUIDs: string[] = [];
  private readonly handlers = new Map<string, HomeWhizPlatformAccessory>();
  private readonly clients = new Map<string, HomeWhizCloudClient>();
  private readonly profiles = new Map<string, AcControlProfile>();
  private readonly apiClient: HomeWhizApi;

  constructor(
    public readonly log: Logging,
    public readonly config: HomeWhizPlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.apiClient = new HomeWhizApi(log);

    this.api.on('didFinishLaunching', () => {
      void this.discoverDevices();
    });
    this.api.on('shutdown', () => {
      void this.shutdown();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory as PlatformAccessory<HomeWhizAccessoryContext>);
  }

  async discoverDevices(): Promise<void> {
    this.discoveredCacheUUIDs.length = 0;

    const username = this.config.username?.trim();
    const password = this.config.password ?? '';
    if (!username || !password) {
      this.log.error('Missing configuration: username and password are required.');
      return;
    }

    const language = this.config.language || 'en-GB';
    const includeBluetooth = this.config.includeBluetoothDevices === true;
    const allowList = new Set((this.config.applianceIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0));

    const cloudConfig: HomeWhizCloudConfig = {
      username,
      password,
      pollIntervalSeconds: this.config.pollIntervalSeconds ?? 60,
    };

    let appliances: HomeWhizApplianceInfo[] = [];
    try {
      const credentials = await this.apiClient.login(username, password);
      const allAppliances = await this.apiClient.fetchApplianceInfos(credentials);
      appliances = allAppliances.filter((appliance) => {
        if (appliance.applianceType !== AIR_CONDITIONER_APPLIANCE_TYPE) {
          return false;
        }
        if (!includeBluetooth && isBluetoothConnectivity(appliance.connectivity)) {
          return false;
        }
        if (allowList.size > 0 && !allowList.has(appliance.applianceId)) {
          return false;
        }
        return true;
      });
      this.log.info('Discovered %s HomeWhiz Wi-Fi air conditioner(s)', appliances.length);

      for (const appliance of appliances) {
        await this.setupAppliance(appliance, credentials, language, cloudConfig);
      }
    } catch (error) {
      const err = error as Error;
      this.log.error('HomeWhiz discovery failed: %s', err.message);
      return;
    }

    for (const [uuid, accessory] of this.accessories) {
      if (!this.discoveredCacheUUIDs.includes(uuid)) {
        this.log.info('Removing accessory from cache: %s', accessory.displayName);
        const client = this.clients.get(accessory.context.device.applianceId);
        if (client) {
          await client.stop();
        }
        this.clients.delete(accessory.context.device.applianceId);
        this.profiles.delete(accessory.context.device.applianceId);
        this.handlers.delete(uuid);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
      }
    }
  }

  private async setupAppliance(
    appliance: HomeWhizApplianceInfo,
    credentials: HomeWhizCredentials,
    language: string,
    cloudConfig: HomeWhizCloudConfig,
  ): Promise<void> {
    const uuid = this.api.hap.uuid.generate(appliance.applianceId);
    const existingAccessory = this.accessories.get(uuid);

    let config: unknown;
    try {
      config = await this.apiClient.fetchApplianceConfiguration(
        credentials,
        appliance.applianceId,
        language,
      );
    } catch (error) {
      const err = error as Error;
      this.log.error('[%s] failed to fetch configuration: %s', appliance.name, err.message);
      return;
    }

    const profile = extractAcControlProfile(config);
    if (!profile) {
      this.log.warn('[%s] skipped: AC control profile could not be built', appliance.name);
      return;
    }
    this.profiles.set(appliance.applianceId, profile);

    const context: HomeWhizAccessoryContext = { device: appliance, config };
    let accessory = existingAccessory;
    if (accessory) {
      this.log.info('Restoring accessory from cache: %s', accessory.displayName);
      accessory.context = context;
      this.api.updatePlatformAccessories([accessory]);
    } else {
      this.log.info('Adding accessory: %s', appliance.name);
      accessory = new this.api.platformAccessory<HomeWhizAccessoryContext>(appliance.name, uuid);
      accessory.context = context;
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
    }

    this.discoveredCacheUUIDs.push(uuid);

    const existingClient = this.clients.get(appliance.applianceId);
    if (existingClient) {
      await existingClient.stop();
    }

    const client = new HomeWhizCloudClient(
      this.log,
      this.apiClient,
      appliance.applianceId,
      cloudConfig,
    );
    this.clients.set(appliance.applianceId, client);

    const existingHandler = this.handlers.get(uuid);
    if (existingHandler) {
      existingHandler.dispose();
    }
    this.handlers.set(uuid, new HomeWhizPlatformAccessory(this, accessory, profile, client));

    try {
      await client.start();
    } catch (error) {
      const err = error as Error;
      this.log.error('[%s] MQTT client failed to start: %s', appliance.name, err.message);
    }
  }

  getLatestData(applianceId: string): Uint8Array | undefined {
    return this.clients.get(applianceId)?.currentData;
  }

  isApplianceConnected(applianceId: string): boolean {
    return this.clients.get(applianceId)?.isConnected ?? false;
  }

  async sendCommands(applianceId: string, commands: HomeWhizCommand[]): Promise<void> {
    const client = this.clients.get(applianceId);
    if (!client) {
      this.log.warn('[%s] command skipped, client unavailable', applianceId);
      return;
    }
    for (const command of commands) {
      await client.sendCommand(command);
    }
  }

  async sendCommand(applianceId: string, command: HomeWhizCommand): Promise<void> {
    await this.sendCommands(applianceId, [command]);
  }

  private async shutdown(): Promise<void> {
    for (const handler of this.handlers.values()) {
      handler.dispose();
    }
    this.handlers.clear();

    for (const client of this.clients.values()) {
      await client.stop();
    }
    this.clients.clear();
    this.profiles.clear();
  }
}
