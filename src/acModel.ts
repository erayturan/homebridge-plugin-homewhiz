import type { HomeWhizCommand, AcMode } from './types.js';

interface EnumOption {
  strKey: string;
  wifiArrayValue: number;
}

interface BoundedValue {
  factor: number;
  lowerLimit: number;
  upperLimit: number;
  step: number;
  unit?: string;
}

interface Feature {
  strKey: string;
  wifiArrayIndex: number;
  wfaWriteIndex?: number;
  enumValues?: EnumOption[];
  boundedValues?: BoundedValue[];
}

interface DeviceState {
  strKey: string;
  wifiArrayValue: number;
}

interface DeviceStates {
  wifiArrayReadIndex: number;
  wifiArrayWriteIndex?: number;
  wfaIndex?: number;
  states: DeviceState[];
}

interface Program {
  strKey: string;
  wifiArrayIndex: number;
  wfaWriteIndex?: number;
  values: EnumOption[];
}

interface ApplianceConfig {
  program?: Program;
  subPrograms?: Feature[];
  customSubPrograms?: Feature[];
  settings?: Feature[];
  monitorings?: Feature[];
  deviceStates?: DeviceStates;
}

export interface NumericControlProfile {
  key: string;
  readIndex: number;
  writeIndex: number;
  factor: number;
  lowerLimit: number;
  upperLimit: number;
  step: number;
}

export interface EnumControlOptionProfile {
  value: number;
  label: string;
}

export interface EnumControlProfile {
  key: string;
  readIndex: number;
  writeIndex: number;
  options: EnumControlOptionProfile[];
}

export interface BooleanControlProfile {
  key: string;
  readIndex: number;
  writeIndex: number;
  valueOn: number;
  valueOff: number;
}

export interface AcControlProfile {
  state: BooleanControlProfile;
  program: EnumControlProfile;
  targetTemperature?: NumericControlProfile;
  currentTemperature?: NumericControlProfile;
  fanMode?: EnumControlProfile;
  jetMode?: BooleanControlProfile;
  swingVertical?: EnumControlProfile | BooleanControlProfile;
  swingHorizontal?: EnumControlProfile;
  modeToProgram: Partial<Record<Exclude<AcMode, 'off'>, string>>;
}

export interface AcSnapshot {
  power: boolean;
  mode: AcMode;
  currentTemperature?: number;
  targetTemperature?: number;
  fanPercent?: number;
  swingMode?: boolean;
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

function clamp(value: number): number {
  return value < 128 ? value : value - 128;
}

function readByte(data: Uint8Array, index: number): number {
  if (index < 0 || index >= data.length) {
    return 0;
  }
  return clamp(data[index]);
}

function toFriendlyName(value: string): string {
  let result = value.replace(/\+/g, 'plus').toLowerCase();
  result = result.replace(/[^a-z0-9-_]/g, '');
  if (result.endsWith('_')) {
    return result.slice(0, -1);
  }
  return result;
}

function parseBoundedValues(raw: unknown): BoundedValue[] {
  const results: BoundedValue[] = [];
  for (const entryRaw of asArray(raw)) {
    const entry = asRecord(entryRaw);
    if (!entry) {
      continue;
    }
    const factor = asNumber(entry.factor);
    const lowerLimit = asNumber(entry.lowerLimit);
    const upperLimit = asNumber(entry.upperLimit);
    const step = asNumber(entry.step);
    if (
      factor === undefined
      || lowerLimit === undefined
      || upperLimit === undefined
      || step === undefined
    ) {
      continue;
    }
    results.push({
      factor,
      lowerLimit,
      upperLimit,
      step,
      unit: asString(entry.unit),
    });
  }
  return results;
}

function parseEnumOptions(raw: unknown): EnumOption[] {
  return asArray(raw)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .map((entry) => ({
      strKey: asString(entry.strKey),
      wifiArrayValue: asNumber(entry.wifiArrayValue),
    }))
    .filter((entry): entry is EnumOption => Boolean(entry.strKey && entry.wifiArrayValue !== undefined));
}

function parseFeature(raw: unknown): Feature | undefined {
  const entry = asRecord(raw);
  if (!entry) {
    return undefined;
  }
  const strKey = asString(entry.strKey);
  const wifiArrayIndex = asNumber(entry.wifiArrayIndex);
  if (!strKey || wifiArrayIndex === undefined) {
    return undefined;
  }
  return {
    strKey,
    wifiArrayIndex,
    wfaWriteIndex: asNumber(entry.wfaWriteIndex),
    enumValues: parseEnumOptions(entry.enumValues),
    boundedValues: parseBoundedValues(entry.boundedValues),
  };
}

function parseProgram(raw: unknown): Program | undefined {
  const entry = asRecord(raw);
  if (!entry) {
    return undefined;
  }
  const strKey = asString(entry.strKey);
  const wifiArrayIndex = asNumber(entry.wifiArrayIndex);
  if (!strKey || wifiArrayIndex === undefined) {
    return undefined;
  }
  return {
    strKey,
    wifiArrayIndex,
    wfaWriteIndex: asNumber(entry.wfaWriteIndex),
    values: parseEnumOptions(entry.values),
  };
}

function parseDeviceStates(raw: unknown): DeviceStates | undefined {
  const entry = asRecord(raw);
  if (!entry) {
    return undefined;
  }
  const wifiArrayReadIndex = asNumber(entry.wifiArrayReadIndex);
  if (wifiArrayReadIndex === undefined) {
    return undefined;
  }
  const states = parseEnumOptions(entry.states)
    .map((state) => ({ strKey: state.strKey, wifiArrayValue: state.wifiArrayValue }));
  if (!states.length) {
    return undefined;
  }
  return {
    wifiArrayReadIndex,
    wifiArrayWriteIndex: asNumber(entry.wifiArrayWriteIndex),
    wfaIndex: asNumber(entry.wfaIndex),
    states,
  };
}

function parseConfiguration(raw: unknown): ApplianceConfig | undefined {
  const config = asRecord(raw);
  if (!config) {
    return undefined;
  }

  const parseFeatureList = (value: unknown): Feature[] => {
    return asArray(value)
      .map((entry) => parseFeature(entry))
      .filter((entry): entry is Feature => entry !== undefined);
  };

  return {
    program: parseProgram(config.program),
    subPrograms: parseFeatureList(config.subPrograms),
    customSubPrograms: parseFeatureList(config.customSubPrograms),
    settings: parseFeatureList(config.settings),
    monitorings: parseFeatureList(config.monitorings),
    deviceStates: parseDeviceStates(config.deviceStates),
  };
}

function optionValueLabel(value: number, factor: number): string {
  const display = Number((value * factor).toFixed(2)).toString();
  return toFriendlyName(display);
}

function buildFeatureOptions(feature: Feature): EnumControlOptionProfile[] {
  const options = new Map<number, string>();
  for (const option of feature.enumValues ?? []) {
    options.set(option.wifiArrayValue, toFriendlyName(option.strKey));
  }

  for (const bounded of feature.boundedValues ?? []) {
    let current = bounded.lowerLimit;
    while (current <= bounded.upperLimit + Number.EPSILON) {
      const wifiValue = Math.round(current / bounded.factor);
      if (!options.has(wifiValue)) {
        options.set(wifiValue, optionValueLabel(wifiValue, bounded.factor));
      }
      current += bounded.step;
    }
  }

  return [...options.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([value, label]) => ({ value, label }));
}

function toEnumControl(feature: Feature, fallbackWriteIndex?: number): EnumControlProfile | undefined {
  const options = buildFeatureOptions(feature);
  if (!options.length) {
    return undefined;
  }
  return {
    key: toFriendlyName(feature.strKey),
    readIndex: feature.wifiArrayIndex,
    writeIndex: feature.wfaWriteIndex ?? fallbackWriteIndex ?? feature.wifiArrayIndex,
    options,
  };
}

function toNumericControl(feature: Feature, fallbackWriteIndex?: number): NumericControlProfile | undefined {
  const bounded = feature.boundedValues?.[0];
  if (!bounded) {
    return undefined;
  }
  return {
    key: toFriendlyName(feature.strKey),
    readIndex: feature.wifiArrayIndex,
    writeIndex: feature.wfaWriteIndex ?? fallbackWriteIndex ?? feature.wifiArrayIndex,
    factor: bounded.factor,
    lowerLimit: bounded.lowerLimit,
    upperLimit: bounded.upperLimit,
    step: bounded.step,
  };
}

function enumToBoolean(control: EnumControlProfile): BooleanControlProfile | undefined {
  const onOption = control.options.find((option) => option.label.endsWith('_on'));
  const offOption = control.options.find((option) => option.label.endsWith('_off'));
  if (!onOption || !offOption) {
    return undefined;
  }
  return {
    key: control.key,
    readIndex: control.readIndex,
    writeIndex: control.writeIndex,
    valueOn: onOption.value,
    valueOff: offOption.value,
  };
}

function programLabelToMode(label: string): Exclude<AcMode, 'off'> | undefined {
  if (label.endsWith('_cooling')) {
    return 'cool';
  }
  if (label.endsWith('_auto')) {
    return 'auto';
  }
  if (label.endsWith('_dry') || label.endsWith('_dehumidification')) {
    return 'dry';
  }
  if (label.endsWith('_heating')) {
    return 'heat';
  }
  if (label.endsWith('_fan')) {
    return 'fan';
  }
  return undefined;
}

function readEnumLabel(control: EnumControlProfile, data: Uint8Array): string | undefined {
  const value = readByte(data, control.readIndex);
  return control.options.find((option) => option.value === value)?.label;
}

function readBoolean(control: BooleanControlProfile, data: Uint8Array): boolean {
  return readByte(data, control.readIndex) === control.valueOn;
}

function writeBoolean(control: BooleanControlProfile, value: boolean): HomeWhizCommand {
  return {
    index: control.writeIndex,
    value: value ? control.valueOn : control.valueOff,
  };
}

function writeEnum(control: EnumControlProfile, label: string): HomeWhizCommand | undefined {
  const option = control.options.find((entry) => entry.label === label);
  if (!option) {
    return undefined;
  }
  return {
    index: control.writeIndex,
    value: option.value,
  };
}

function readNumeric(control: NumericControlProfile, data: Uint8Array): number {
  return readByte(data, control.readIndex) * control.factor;
}

function writeNumeric(control: NumericControlProfile, value: number): HomeWhizCommand {
  const clamped = Math.max(control.lowerLimit, Math.min(control.upperLimit, value));
  const rawValue = Math.round(clamped / control.factor);
  return {
    index: control.writeIndex,
    value: rawValue,
  };
}

function preferredProgramLabel(
  mode: Exclude<AcMode, 'off'>,
  profile: AcControlProfile,
): string | undefined {
  return profile.modeToProgram[mode]
    ?? profile.modeToProgram.auto
    ?? profile.modeToProgram.cool
    ?? profile.modeToProgram.heat;
}

function getSwingControl(profile: AcControlProfile): EnumControlProfile | BooleanControlProfile | undefined {
  if (profile.swingVertical) {
    return profile.swingVertical;
  }
  return profile.swingHorizontal;
}

function readSwingControl(control: EnumControlProfile | BooleanControlProfile, data: Uint8Array): boolean {
  if ('valueOn' in control) {
    return readBoolean(control, data);
  }
  const label = readEnumLabel(control, data);
  if (!label) {
    return false;
  }
  return !label.endsWith('_off');
}

function writeSwingControl(
  control: EnumControlProfile | BooleanControlProfile,
  enabled: boolean,
): HomeWhizCommand | undefined {
  if ('valueOn' in control) {
    return writeBoolean(control, enabled);
  }
  const preferredSuffix = enabled ? '_auto' : '_off';
  const option = control.options.find((entry) => entry.label.endsWith(preferredSuffix));
  if (!option) {
    return undefined;
  }
  return {
    index: control.writeIndex,
    value: option.value,
  };
}

export function extractAcControlProfile(rawConfig: unknown): AcControlProfile | null {
  const config = parseConfiguration(rawConfig);
  if (!config?.program || !config.deviceStates) {
    return null;
  }

  const stateEnum: EnumControlProfile = {
    key: 'state',
    readIndex: config.deviceStates.wifiArrayReadIndex,
    writeIndex: config.deviceStates.wifiArrayWriteIndex ?? config.deviceStates.wfaIndex ?? config.deviceStates.wifiArrayReadIndex,
    options: config.deviceStates.states.map((state) => ({
      value: state.wifiArrayValue,
      label: toFriendlyName(state.strKey),
    })),
  };

  const state = enumToBoolean(stateEnum);
  if (!state) {
    return null;
  }

  const programFeature: Feature = {
    strKey: config.program.strKey,
    wifiArrayIndex: config.program.wifiArrayIndex,
    wfaWriteIndex: config.program.wfaWriteIndex,
    enumValues: config.program.values,
  };
  const program = toEnumControl(programFeature);
  if (!program) {
    return null;
  }

  const allWriteFeatures = [
    ...(config.subPrograms ?? []),
    ...(config.customSubPrograms ?? []),
    ...(config.settings ?? []),
  ];
  const findWriteFeature = (key: string): Feature | undefined => {
    return allWriteFeatures.find((feature) => toFriendlyName(feature.strKey) === key);
  };
  const findMonitoringFeature = (key: string): Feature | undefined => {
    return (config.monitorings ?? []).find((feature) => toFriendlyName(feature.strKey) === key);
  };

  const targetFeature = findWriteFeature('air_conditioner_target_temperature');
  const roomTempFeature = findMonitoringFeature('air_conditioner_room_temperature');
  const fanFeature = findWriteFeature('air_conditioner_wind_strength');
  const jetFeature = findWriteFeature('air_conditioner_jet_mode');
  const verticalSwingFeature = findWriteFeature('air_conditioner_up_down_vane_control');
  const horizontalSwingFeature = findWriteFeature('air_conditioner_left_right_vane_control');

  const targetTemperature = targetFeature ? toNumericControl(targetFeature) : undefined;
  const currentTemperature = roomTempFeature ? toNumericControl(roomTempFeature) : undefined;
  const fanMode = fanFeature ? toEnumControl(fanFeature) : undefined;
  const jetModeEnum = jetFeature ? toEnumControl(jetFeature) : undefined;
  const jetMode = jetModeEnum ? enumToBoolean(jetModeEnum) : undefined;
  const verticalSwingEnum = verticalSwingFeature ? toEnumControl(verticalSwingFeature) : undefined;
  const verticalSwingBool = verticalSwingEnum ? enumToBoolean(verticalSwingEnum) : undefined;
  const swingVertical = verticalSwingBool ?? verticalSwingEnum;
  const swingHorizontal = horizontalSwingFeature ? toEnumControl(horizontalSwingFeature) : undefined;

  const modeToProgram: Partial<Record<Exclude<AcMode, 'off'>, string>> = {};
  for (const option of program.options) {
    const mode = programLabelToMode(option.label);
    if (mode && !modeToProgram[mode]) {
      modeToProgram[mode] = option.label;
    }
  }

  return {
    state,
    program,
    targetTemperature,
    currentTemperature,
    fanMode,
    jetMode,
    swingVertical,
    swingHorizontal,
    modeToProgram,
  };
}

export function readAcSnapshot(data: Uint8Array, profile: AcControlProfile): AcSnapshot {
  const power = readBoolean(profile.state, data);
  const currentProgram = readEnumLabel(profile.program, data);
  const mode = !power ? 'off' : (currentProgram ? programLabelToMode(currentProgram) ?? 'auto' : 'auto');
  const currentTemperature = profile.currentTemperature ? readNumeric(profile.currentTemperature, data) : undefined;
  const targetTemperature = profile.targetTemperature ? readNumeric(profile.targetTemperature, data) : undefined;

  let fanPercent: number | undefined;
  if (profile.fanMode) {
    const label = readEnumLabel(profile.fanMode, data);
    const options = profile.fanMode.options
      .filter((option) => !option.label.endsWith('_auto'))
      .sort((left, right) => left.value - right.value);
    const ranked = options.length ? options : [...profile.fanMode.options].sort((left, right) => left.value - right.value);
    const selectedIndex = ranked.findIndex((option) => option.label === label);
    if (selectedIndex >= 0 && ranked.length > 1) {
      fanPercent = Math.round((selectedIndex / (ranked.length - 1)) * 100);
    } else if (selectedIndex === 0) {
      fanPercent = 0;
    }
  }

  const swingControl = getSwingControl(profile);
  const swingMode = swingControl ? readSwingControl(swingControl, data) : undefined;

  return {
    power,
    mode,
    currentTemperature,
    targetTemperature,
    fanPercent,
    swingMode,
  };
}

export function setPower(profile: AcControlProfile, power: boolean, currentData: Uint8Array): HomeWhizCommand[] {
  if (readBoolean(profile.state, currentData) === power) {
    return [];
  }
  return [writeBoolean(profile.state, power)];
}

export function setMode(profile: AcControlProfile, mode: AcMode, currentData: Uint8Array): HomeWhizCommand[] {
  if (mode === 'off') {
    return setPower(profile, false, currentData);
  }

  const commands: HomeWhizCommand[] = [];
  if (!readBoolean(profile.state, currentData)) {
    commands.push(writeBoolean(profile.state, true));
  }

  const targetProgram = preferredProgramLabel(mode, profile);
  if (!targetProgram) {
    return commands;
  }

  const currentProgram = readEnumLabel(profile.program, currentData);
  if (currentProgram !== targetProgram) {
    const command = writeEnum(profile.program, targetProgram);
    if (command) {
      commands.push(command);
    }
  }

  return commands;
}

export function setTargetTemperature(
  profile: AcControlProfile,
  temperature: number,
): HomeWhizCommand | undefined {
  if (!profile.targetTemperature) {
    return undefined;
  }
  return writeNumeric(profile.targetTemperature, temperature);
}

export function setFanPercent(
  profile: AcControlProfile,
  percent: number,
): HomeWhizCommand | undefined {
  if (!profile.fanMode) {
    return undefined;
  }

  const normalizedPercent = Math.max(0, Math.min(100, percent));
  const options = profile.fanMode.options
    .filter((option) => !option.label.endsWith('_auto'))
    .sort((left, right) => left.value - right.value);
  const ranked = options.length ? options : [...profile.fanMode.options].sort((left, right) => left.value - right.value);
  if (!ranked.length) {
    return undefined;
  }

  const targetIndex = ranked.length === 1
    ? 0
    : Math.round((normalizedPercent / 100) * (ranked.length - 1));

  return {
    index: profile.fanMode.writeIndex,
    value: ranked[targetIndex].value,
  };
}

export function setSwingMode(
  profile: AcControlProfile,
  enabled: boolean,
): HomeWhizCommand | undefined {
  const swingControl = getSwingControl(profile);
  if (!swingControl) {
    return undefined;
  }
  return writeSwingControl(swingControl, enabled);
}
