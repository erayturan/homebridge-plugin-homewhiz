import crypto from 'node:crypto';

import type { Logging } from 'homebridge';

import type {
  HomeWhizApplianceInfo,
  HomeWhizCredentials,
} from './types.js';

const ALGORITHM = 'AWS4-HMAC-SHA256';
const REGION = 'eu-west-1';
const SERVICE = 'execute-api';

interface ContentsDescription {
  cid: string;
  ctype: string;
  ver: number;
  lang: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sign(key: Buffer, message: string): Buffer {
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest();
}

function getSignatureKey(
  secret: string,
  dateStamp: string,
  regionName: string,
  serviceName: string,
): Buffer {
  const kDate = sign(Buffer.from(`AWS4${secret}`, 'utf8'), dateStamp);
  const kRegion = sign(kDate, regionName);
  const kService = sign(kRegion, serviceName);
  return sign(kService, 'aws4_request');
}

function formatAmzDate(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[-:]/g, '');
  const amzDate = `${iso.slice(0, 8)}T${iso.slice(9, 15)}Z`;
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function buildApplianceInfo(raw: unknown): HomeWhizApplianceInfo | undefined {
  const value = asRecord(raw);
  if (!value) {
    return undefined;
  }

  const id = asNumber(value.id);
  const applianceId = asString(value.applianceId);
  const brand = asNumber(value.brand);
  const model = asString(value.model);
  const applianceType = asNumber(value.applianceType);
  const platformType = asString(value.platformType);
  const name = asString(value.name);

  if (
    id === undefined
    || !applianceId
    || brand === undefined
    || !model
    || applianceType === undefined
    || !platformType
    || !name
  ) {
    return undefined;
  }

  return {
    id,
    applianceId,
    brand,
    model,
    applianceType,
    platformType,
    name,
    applianceSerialNumber: asString(value.applianceSerialNumber) ?? null,
    hsmId: asString(value.hsmId) ?? null,
    connectivity: asString(value.connectivity),
  };
}

export class HomeWhizApi {
  constructor(private readonly log: Logging) {
  }

  async login(username: string, password: string): Promise<HomeWhizCredentials> {
    const response = await fetch('https://api.arcelikiot.com/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'HomeWhiz/1.0',
      },
      body: JSON.stringify({ username, password }),
    });

    const payload = await response.json() as unknown;
    const payloadObject = asRecord(payload);
    if (!response.ok || !payloadObject) {
      throw new Error(`HomeWhiz login failed with HTTP ${response.status}`);
    }

    if (payloadObject.success === false) {
      throw new Error('HomeWhiz login rejected credentials');
    }

    const data = asRecord(payloadObject.data);
    const credentials = asRecord(data?.credentials);
    const accessKey = asString(credentials?.accessKey);
    const secretKey = asString(credentials?.secretKey);
    const sessionToken = asString(credentials?.sessionToken);
    const expiration = asNumber(credentials?.expiration);

    if (!accessKey || !secretKey || !sessionToken || expiration === undefined) {
      throw new Error('HomeWhiz login response did not include valid credentials');
    }

    return {
      accessKey,
      secretKey,
      sessionToken,
      expiration,
    };
  }

  async fetchApplianceInfos(credentials: HomeWhizCredentials): Promise<HomeWhizApplianceInfo[]> {
    const homesResponse = await this.makeApiGetRequest(
      'smarthome.arcelikiot.com',
      credentials,
      '/my-homes',
    );

    const homes = asArray(asRecord(homesResponse)?.data);
    const appliances: HomeWhizApplianceInfo[] = [];

    for (const home of homes) {
      const homeId = asNumber(asRecord(home)?.id);
      if (homeId === undefined) {
        continue;
      }

      const homeResponse = await this.makeApiGetRequest(
        'smarthome.arcelikiot.com',
        credentials,
        `/my-homes/${homeId}`,
      );

      const homeData = asRecord(homeResponse);
      const data = asRecord(homeData?.data);
      const discovered = asArray(data?.appliances)
        .map((entry) => buildApplianceInfo(entry))
        .filter((entry): entry is HomeWhizApplianceInfo => entry !== undefined);

      appliances.push(...discovered);
    }

    return appliances;
  }

  async fetchApplianceConfiguration(
    credentials: HomeWhizCredentials,
    applianceId: string,
    language: string,
  ): Promise<unknown> {
    const index = await this.fetchContentsIndex(credentials, applianceId, language);
    const configDescription = index.find((entry) => entry.ctype === 'CONFIGURATION');
    if (!configDescription) {
      throw new Error(`No CONFIGURATION content found for appliance ${applianceId}`);
    }

    return this.fetchContentFile(configDescription);
  }

  private async fetchContentsIndex(
    credentials: HomeWhizCredentials,
    applianceId: string,
    language: string,
  ): Promise<ContentsDescription[]> {
    const query = `applianceId=${encodeURIComponent(applianceId)}&ctype=CONFIGURATION%2CLOCALIZATION&lang=${encodeURIComponent(language)}&testMode=true`;
    const payload = await this.makeApiGetRequest(
      'api.arcelikiot.com',
      credentials,
      '/procam/contents',
      query,
    );
    const results = asArray(asRecord(asRecord(payload)?.data)?.results);

    return results
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== undefined)
      .map((item) => ({
        cid: asString(item.cid),
        ctype: asString(item.ctype),
        ver: asNumber(item.ver),
        lang: asString(item.lang),
      }))
      .filter((item): item is ContentsDescription => {
        return Boolean(item.cid && item.ctype && item.lang && item.ver !== undefined);
      });
  }

  private async fetchContentFile(description: ContentsDescription): Promise<unknown> {
    const url = [
      'https://s3-eu-west-1.amazonaws.com/procam-contents',
      `${description.ctype}S`,
      description.cid,
      `v${description.ver}`,
      `${description.cid}.${description.lang}.json`,
    ].join('/');
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download content file: HTTP ${response.status}`);
    }
    return response.json();
  }

  private async makeApiGetRequest(
    host: string,
    credentials: HomeWhizCredentials,
    canonicalUri: string,
    canonicalQuerystring = '',
  ): Promise<unknown> {
    const now = new Date();
    const { amzDate, dateStamp } = formatAmzDate(now);

    const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\nx-amz-security-token:${credentials.sessionToken}\n`;
    const signedHeaders = 'host;x-amz-date;x-amz-security-token';
    const payloadHash = crypto.createHash('sha256').update('').digest('hex');

    const canonicalRequest = `GET\n${canonicalUri}\n${canonicalQuerystring}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
    const stringToSign = `${ALGORITHM}\n${amzDate}\n${credentialScope}\n${crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')}`;
    const signingKey = getSignatureKey(credentials.secretKey, dateStamp, REGION, SERVICE);
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

    const authorizationHeader = `${ALGORITHM} Credential=${credentials.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    let url = `https://${host}${canonicalUri}`;
    if (canonicalQuerystring) {
      url = `${url}?${canonicalQuerystring}`;
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-amz-date': amzDate,
        'x-amz-security-token': credentials.sessionToken,
        'Authorization': authorizationHeader,
        'Accept': 'application/json',
        'User-Agent': 'HomeWhiz/1.0',
      },
    });

    const payload = await response.json() as unknown;
    if (!response.ok) {
      this.log.error('HomeWhiz API request to %s%s failed with HTTP %s', host, canonicalUri, response.status);
      throw new Error(`HomeWhiz API request failed with HTTP ${response.status}`);
    }

    const payloadObject = asRecord(payload);
    if (payloadObject?.success === false) {
      throw new Error(`HomeWhiz API request to ${canonicalUri} failed`);
    }

    return payload;
  }
}
