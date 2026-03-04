import { randomUUID } from 'node:crypto';

import { auth, io, iot, mqtt } from 'aws-iot-device-sdk-v2';
import type { Logging } from 'homebridge';

import { HomeWhizApi } from './homewhizApi.js';
import type {
  HomeWhizCloudConfig,
  HomeWhizCommand,
} from './types.js';
import { HOMEWHIZ_IOT_ENDPOINT } from './types.js';

type DataListener = (data: Uint8Array) => void;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry));
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class HomeWhizCloudClient {
  private mqttClient?: mqtt.MqttClient;
  private connection?: mqtt.MqttClientConnection;
  private readonly listeners = new Set<DataListener>();
  private refreshTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private connected = false;
  private stopping = false;
  private latestData?: Uint8Array;

  constructor(
    private readonly log: Logging,
    private readonly api: HomeWhizApi,
    private readonly applianceId: string,
    private readonly cloudConfig: HomeWhizCloudConfig,
  ) {
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get currentData(): Uint8Array | undefined {
    return this.latestData;
  }

  onData(listener: DataListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearTimers();
    await this.disconnect();
  }

  async sendCommand(command: HomeWhizCommand): Promise<void> {
    if (!this.connection || !this.connected) {
      this.log.warn('[%s] command skipped, MQTT is disconnected', this.applianceId);
      return;
    }

    const suffix = this.applianceId.startsWith('T') ? '/tuyacommand' : '/command';
    const payload: Record<string, string> = {
      type: 'write',
      prm: `[${command.index},${command.value}]`,
    };
    if (this.applianceId.startsWith('T')) {
      payload.applianceId = this.applianceId;
    }

    await this.connection.publish(
      `${this.applianceId}${suffix}`,
      JSON.stringify(payload),
      mqtt.QoS.AtLeastOnce,
    );
    await wait(500);
    await this.forceRead();
  }

  async forceRead(): Promise<void> {
    if (!this.connection || !this.connected) {
      return;
    }

    const suffix = this.applianceId.startsWith('T') ? '/tuyacommand' : '/command';
    const payload: Record<string, string> = {
      type: `fread${suffix}`,
    };
    if (this.applianceId.startsWith('T')) {
      payload.applianceId = this.applianceId;
    }

    await this.connection.publish(
      `$aws/things/${this.applianceId}/shadow/get`,
      JSON.stringify(payload),
      mqtt.QoS.AtMostOnce,
    );
  }

  private async connect(): Promise<void> {
    const credentials = await this.api.login(
      this.cloudConfig.username,
      this.cloudConfig.password,
    );

    const credentialsProvider = auth.AwsCredentialsProvider.newStatic(
      credentials.accessKey,
      credentials.secretKey,
      credentials.sessionToken,
    );

    const configBuilder = iot.AwsIotMqttConnectionConfigBuilder.new_with_websockets({
      region: 'eu-west-1',
      credentials_provider: credentialsProvider,
    });
    configBuilder.with_endpoint(HOMEWHIZ_IOT_ENDPOINT);
    configBuilder.with_client_id(randomUUID().replace(/-/g, ''));
    configBuilder.with_clean_session(false);
    configBuilder.with_keep_alive_seconds(1200);

    this.mqttClient = new mqtt.MqttClient(new io.ClientBootstrap());
    this.connection = this.mqttClient.new_connection(configBuilder.build());

    this.connection.on('interrupt', (error: Error) => {
      this.connected = false;
      this.log.warn('[%s] MQTT interrupted: %s', this.applianceId, error.message);
      this.scheduleReconnect(15_000);
    });

    this.connection.on('resume', (_returnCode: unknown, sessionPresent: boolean) => {
      this.connected = true;
      this.log.info('[%s] MQTT resumed (sessionPresent=%s)', this.applianceId, sessionPresent);
      if (!sessionPresent) {
        void this.subscribeToTopics();
      }
      void this.forceRead();
    });

    this.connection.on('message', (_topic: string, payload: ArrayBuffer) => {
      this.handleNotify(payload);
    });

    await this.connection.connect();
    this.connected = true;
    await this.subscribeToTopics();
    await this.forceRead();

    this.scheduleRefresh(credentials.expiration);
    this.schedulePeriodicRead();
    this.log.info('[%s] MQTT connected', this.applianceId);
  }

  private async subscribeToTopics(): Promise<void> {
    if (!this.connection) {
      return;
    }
    await this.connection.subscribe(
      `$aws/things/${this.applianceId}/shadow/update/accepted`,
      mqtt.QoS.AtLeastOnce,
    );
    await this.connection.subscribe(
      `$aws/things/${this.applianceId}/shadow/get/accepted`,
      mqtt.QoS.AtLeastOnce,
    );
  }

  private handleNotify(payload: ArrayBuffer): void {
    try {
      const messageText = Buffer.from(payload).toString('utf8');
      const parsed = JSON.parse(messageText) as unknown;
      const state = asRecord(asRecord(parsed)?.state);
      const reported = asRecord(state?.reported);
      const offset = asNumber(reported?.wfaStartOffset) ?? 26;
      const wfa = asNumberArray(reported?.wfa);
      if (!wfa.length) {
        return;
      }

      const data = Uint8Array.from([
        ...new Array(offset).fill(0),
        ...wfa.map((entry) => entry & 0xff),
      ]);
      this.latestData = data;
      for (const listener of this.listeners) {
        listener(data);
      }
    } catch (error) {
      const err = error as Error;
      this.log.debug('[%s] notify parse failed: %s', this.applianceId, err.message);
    }
  }

  private scheduleRefresh(expirationTimestampMs: number): void {
    const refreshDelay = Math.max(30_000, expirationTimestampMs - Date.now() - 60_000);
    this.refreshTimer = setTimeout(() => {
      void this.reconnect();
    }, refreshDelay);
  }

  private schedulePeriodicRead(): void {
    this.pollTimer = setInterval(() => {
      void this.forceRead();
    }, this.cloudConfig.pollIntervalSeconds * 1000);
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.stopping || this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect();
    }, delayMs);
  }

  private async reconnect(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.clearTimers();
    await this.disconnect();
    try {
      await this.connect();
    } catch (error) {
      const err = error as Error;
      this.log.error('[%s] reconnect failed: %s', this.applianceId, err.message);
      this.scheduleReconnect(30_000);
    }
  }

  private clearTimers(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private async disconnect(): Promise<void> {
    this.connected = false;
    if (this.connection) {
      await this.connection.disconnect();
    }
    this.connection = undefined;
    this.mqttClient = undefined;
  }
}
