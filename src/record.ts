import * as dotenv from 'dotenv';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { isValidAiConfig, runRecording, type RecordConfig } from './core/RecordingRunner.js';

dotenv.config();

async function loadRecordConfig(fileName?: string): Promise<RecordConfig> {
  const filePath = resolveRecordConfigPath(fileName);
  const raw = await fs.readFile(filePath, 'utf-8');
  const config = JSON.parse(raw) as RecordConfig;

  if (typeof config.startUrl !== 'string' || typeof config.goal !== 'string') {
    throw new Error(`Invalid record config: ${filePath} must contain startUrl and goal strings.`);
  }

  if (config.ai && !isValidAiConfig(config.ai)) {
    throw new Error(
      `Invalid record config: ${filePath} has an invalid ai section. Expected strings and a fallbackModels string array.`,
    );
  }

  return config;
}

function resolveRecordConfigPath(fileName?: string): string {
  if (fileName) {
    return resolve(process.cwd(), fileName);
  }

  const preferredPath = resolve(process.cwd(), 'config', 'record-config.json');
  const legacyPath = resolve(process.cwd(), 'record-config.json');

  return existsSync(preferredPath) ? preferredPath : legacyPath;
}

async function readDefaultRecordConfig(): Promise<RecordConfig | null> {
  try {
    return await loadRecordConfig();
  } catch {
    return null;
  }
}

const args = process.argv.slice(2);
const [arg1, arg2] = args;

async function main(): Promise<void> {
  let targetUrl = 'https://www.google.com';
  let targetGoal = 'Search for Playwright and click on the official website';
  let recordConfig: RecordConfig = {
    startUrl: targetUrl,
    goal: targetGoal,
  };

  if (args.length === 1 && arg1?.endsWith('.json')) {
    const config = await loadRecordConfig(arg1);
    targetUrl = config.startUrl;
    targetGoal = config.goal;
    recordConfig = config;
    console.log(`[Main] Loaded instructions from ${arg1}`);
  } else if (args.length >= 2 && arg1 && arg2) {
    targetUrl = arg1;
    targetGoal = args.slice(1).join(' ');
    recordConfig = {
      startUrl: targetUrl,
      goal: targetGoal,
    };
  } else {
    const config = await readDefaultRecordConfig();
    if (config) {
      targetUrl = config.startUrl;
      targetGoal = config.goal;
      recordConfig = config;
      console.log('[Main] Loaded instructions from the default record config.');
    }
  }

  await runRecording({
    ...recordConfig,
    startUrl: targetUrl,
    goal: targetGoal,
  });
}

void main();
