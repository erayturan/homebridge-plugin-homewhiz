import type { PlatformConfig } from 'homebridge';

export interface HomeWhizPlatformConfig extends PlatformConfig {
  username?: string;
  password?: string;
  language?: string;
  pollIntervalSeconds?: number;
  applianceIds?: string[];
  includeBluetoothDevices?: boolean;
}

export interface HomeWhizCredentials {
  accessKey: string;
  secretKey: string;
  sessionToken: string;
  expiration: number;
}

export interface HomeWhizApplianceInfo {
  id: number;
  applianceId: string;
  brand: number;
  model: string;
  applianceType: number;
  platformType: string;
  applianceSerialNumber?: string | null;
  name: string;
  hsmId?: string | null;
  connectivity?: string;
}

export interface HomeWhizCloudConfig {
  username: string;
  password: string;
  pollIntervalSeconds: number;
}

export interface HomeWhizAccessoryContext {
  device: HomeWhizApplianceInfo;
  config: unknown;
}

export interface HomeWhizCommand {
  index: number;
  value: number;
}

export type AcMode = 'off' | 'auto' | 'cool' | 'heat' | 'dry' | 'fan';

export const AIR_CONDITIONER_APPLIANCE_TYPE = 9;
export const HOMEWHIZ_IOT_ENDPOINT = 'ajf7v9dcoe69w-ats.iot.eu-west-1.amazonaws.com';

export function isBluetoothConnectivity(connectivity?: string | null): boolean {
  if (!connectivity) {
    return false;
  }
  return connectivity === 'BT' || connectivity === 'BASICBT';
}

