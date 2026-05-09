import * as dotenv from 'dotenv';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { AIAgent } from './ai/AIAgent.js';
import type { AIAgentConfig } from './ai/AIAgent.js';
import { Recorder } from './core/Recorder.js';
import { BrowserManager } from './core/BrowserManager.js';

dotenv.config();

interface RecordAiConfig {
  provider?: string;
  model?: string;
  fallbackModels?: string[];
  baseUrl?: string;
}

interface RecordConfig {
  startUrl: string;
  goal: string;
  ai?: RecordAiConfig;
}

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

function buildTestName(goal: string): string {
  return `AI Generated Test: ${goal.substring(0, 40).trim()}`;
}

function buildAgentConfig(ai?: RecordAiConfig): AIAgentConfig {
  const config: AIAgentConfig = {};

  if (ai?.provider) {
    config.providerName = ai.provider;
  }

  if (ai?.model) {
    config.primaryModel = ai.model;
  }

  if (ai?.fallbackModels?.length) {
    config.fallbackModels = ai.fallbackModels;
  }

  if (ai?.baseUrl) {
    config.baseURL = ai.baseUrl;
  }

  return config;
}

function isValidAiConfig(ai: RecordAiConfig): boolean {
  if (ai.provider !== undefined && typeof ai.provider !== 'string') {
    return false;
  }

  if (ai.model !== undefined && typeof ai.model !== 'string') {
    return false;
  }

  if (ai.baseUrl !== undefined && typeof ai.baseUrl !== 'string') {
    return false;
  }

  if (ai.fallbackModels !== undefined) {
    return Array.isArray(ai.fallbackModels) && ai.fallbackModels.every((model) => typeof model === 'string');
  }

  return true;
}

async function runAIExtraction(startUrl: string, goal: string, agentConfig?: AIAgentConfig): Promise<void> {
  const browserManager = new BrowserManager();
  const recorder = new Recorder(buildTestName(goal));
  const maxAiSteps = Number(process.env.MAX_AI_STEPS ?? 20);
  const agent = new AIAgent(goal, maxAiSteps, agentConfig);

  try {
    const page = await browserManager.init();

    console.log(`[Main] Goal: ${goal}`);
    console.log(`[Main] Navigating to ${startUrl}`);

    const navResult = await browserManager.executeStep(
      { action: 'navigate', url: startUrl },
      { stepIndex: 0 },
    );

    recorder.record({
      action: 'navigate',
      url: startUrl,
      result: navResult.result,
    });

    let goalReached = false;
    let aiStepCount = 0;
    let lastError: string | null = null;

    while (!goalReached && aiStepCount < maxAiSteps) {
      console.log(`\n[Main] --- AI Step ${aiStepCount + 1}/${maxAiSteps} ---`);
      const nextStep = await agent.getNextStep(page, recorder.getSteps(), lastError);
      lastError = null;

      if (nextStep === 'GOAL_REACHED') {
        console.log('[Main] Goal reached.');
        goalReached = true;
        break;
      }

      if (nextStep === 'FAILED') {
        console.log('[Main] Agent failed to decide the next step.');
        break;
      }

      console.log(
        `[Main] Executing: ${nextStep.action} ${nextStep.target ? `on "${nextStep.target}"` : ''} ${nextStep.value ? `with value "${nextStep.value}"` : ''}`,
      );

      try {
        const urlBefore = page.url();
        const { selectors, result } = await browserManager.executeStep(nextStep, {
          stepIndex: aiStepCount + 1,
        });

        recorder.record({
          ...nextStep,
          selectors: selectors ?? nextStep.selectors,
          result: {
            ...result,
            urlBefore,
          },
        });

        // Small settle delay helps the agent reason about the updated UI state.
        await page.waitForTimeout(1500);
      } catch (err) {
        console.error('[Main] Error executing step:', (err as Error).message);
        lastError = err instanceof Error ? err.message : String(err);

        recorder.record({
          ...nextStep,
          result: {
            ts: new Date().toISOString(),
            urlBefore: page.url(),
            error: lastError,
            urlAfter: page.url(),
          },
        });
      }

      aiStepCount += 1;
    }

    console.log('\n[Main] Recording session complete.');
    if (goalReached) {
      console.log(`[Main] Captured ${recorder.getSteps().length} steps to achieve the goal.`);
    }
  } catch (error) {
    console.error('[Main] Execution error:', error);
  } finally {
    await browserManager.close();
  }
}

const args = process.argv.slice(2);
const [arg1, arg2] = args;

async function main(): Promise<void> {
  let targetUrl = 'https://www.google.com';
  let targetGoal = 'Search for Playwright and click on the official website';
  let agentConfig: AIAgentConfig | undefined;

  if (args.length === 1 && arg1?.endsWith('.json')) {
    const config = await loadRecordConfig(arg1);
    targetUrl = config.startUrl;
    targetGoal = config.goal;
    agentConfig = buildAgentConfig(config.ai);
    console.log(`[Main] Loaded instructions from ${arg1}`);
  } else if (args.length >= 2 && arg1 && arg2) {
    targetUrl = arg1;
    targetGoal = args.slice(1).join(' ');
  } else {
    const config = await readDefaultRecordConfig();
    if (config) {
      targetUrl = config.startUrl;
      targetGoal = config.goal;
      agentConfig = buildAgentConfig(config.ai);
      console.log('[Main] Loaded instructions from the default record config.');
    }
  }

  await runAIExtraction(targetUrl, targetGoal, agentConfig);
}

void main();
