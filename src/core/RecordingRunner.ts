import * as dotenv from 'dotenv';
import { AIAgent } from '../ai/AIAgent.js';
import type { AIAgentConfig } from '../ai/AIAgent.js';
import { BrowserManager } from './BrowserManager.js';
import { Recorder } from './Recorder.js';
import type { TestCase, TestStep } from '../utils/types.js';

dotenv.config();

export interface RecordAiConfig {
  provider?: string;
  model?: string;
  fallbackModels?: string[];
  baseUrl?: string;
}

export interface RecordConfig {
  startUrl: string;
  goal: string;
  ai?: RecordAiConfig;
}

export interface RecordingRunHooks {
  onStatus?: (status: string) => void;
  onLog?: (message: string) => void;
  onStepRecorded?: (step: TestStep, steps: TestStep[]) => void;
  onFinished?: (result: RecordingRunResult) => void;
  onPreviewUpdated?: (previewPath: string) => void;
}

export interface RecordingRunResult {
  success: boolean;
  goalReached: boolean;
  steps: TestStep[];
  testCase: TestCase;
  outputPath: string;
  error?: string;
}

const LIVE_PREVIEW_PATH = 'artifacts/live-preview.png';

export async function runRecording(config: RecordConfig, hooks: RecordingRunHooks = {}): Promise<RecordingRunResult> {
  const browserManager = new BrowserManager();
  const recorder = new Recorder(buildTestName(config.goal));
  const maxAiSteps = Number(process.env.MAX_AI_STEPS ?? 20);
  const agent = new AIAgent(config.goal, maxAiSteps, buildAgentConfig(config.ai));

  hooks.onStatus?.('starting');
  hooks.onLog?.(`[Main] Goal: ${config.goal}`);
  hooks.onLog?.(`[Main] Navigating to ${config.startUrl}`);

  try {
    const page = await browserManager.init();
    await captureLivePreview(browserManager, hooks);

    const navResult = await browserManager.executeStep(
      { action: 'navigate', url: config.startUrl },
      { stepIndex: 0 },
    );

    const initialStep: TestStep = {
      action: 'navigate',
      url: config.startUrl,
      result: navResult.result,
    };
    recorder.record(initialStep);
    hooks.onStepRecorded?.(initialStep, recorder.getSteps());
    await captureLivePreview(browserManager, hooks);

    let goalReached = false;
    let aiStepCount = 0;
    let lastError: string | null = null;

    hooks.onStatus?.('recording');

    while (!goalReached && aiStepCount < maxAiSteps) {
      hooks.onLog?.(`[Main] --- AI Step ${aiStepCount + 1}/${maxAiSteps} ---`);
      const nextStep = await agent.getNextStep(page, recorder.getSteps(), lastError);
      lastError = null;

      if (nextStep === 'GOAL_REACHED') {
        hooks.onLog?.('[Main] Goal reached.');
        goalReached = true;
        break;
      }

      if (nextStep === 'FAILED') {
        hooks.onLog?.('[Main] Agent failed to decide the next step.');
        break;
      }

      hooks.onLog?.(
        `[Main] Executing: ${nextStep.action} on ${getStepLabel(nextStep)} ${nextStep.value ? `with value "${nextStep.value}"` : ''}`.trim(),
      );

      try {
        const urlBefore = page.url();
        const { selectors, result } = await browserManager.executeStep(nextStep, {
          stepIndex: aiStepCount + 1,
        });

        const recordedStep: TestStep = {
          ...nextStep,
          selectors: selectors ?? nextStep.selectors,
          result: {
            ...result,
            urlBefore,
          },
        };

        recorder.record(recordedStep);
        hooks.onStepRecorded?.(recordedStep, recorder.getSteps());

        await page.waitForTimeout(1500);
        await captureLivePreview(browserManager, hooks);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        hooks.onLog?.(`[Main] Error executing step: ${lastError}`);

        const failedStep: TestStep = {
          ...nextStep,
          result: {
            ts: new Date().toISOString(),
            urlBefore: page.url(),
            error: lastError,
            urlAfter: page.url(),
          },
        };

        recorder.record(failedStep);
        hooks.onStepRecorded?.(failedStep, recorder.getSteps());
        await captureLivePreview(browserManager, hooks);
      }

      aiStepCount += 1;
    }

    const outputPath = recorder.save();
    const result: RecordingRunResult = {
      success: goalReached,
      goalReached,
      steps: recorder.getSteps(),
      testCase: buildTestCase(buildTestName(config.goal), recorder.getSteps()),
      outputPath,
    };

    hooks.onStatus?.(goalReached ? 'completed' : 'stopped');
    hooks.onLog?.('[Main] Recording session complete.');
    hooks.onFinished?.(result);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result: RecordingRunResult = {
      success: false,
      goalReached: false,
      steps: recorder.getSteps(),
      testCase: buildTestCase(buildTestName(config.goal), recorder.getSteps()),
      outputPath: 'output/test-case.json',
      error: message,
    };
    hooks.onStatus?.('failed');
    hooks.onLog?.(`[Main] Execution error: ${message}`);
    hooks.onFinished?.(result);
    return result;
  } finally {
    await browserManager.close();
  }
}

export function buildAgentConfig(ai?: RecordAiConfig): AIAgentConfig {
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

export function isValidAiConfig(ai: RecordAiConfig): boolean {
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

function buildTestName(goal: string): string {
  return `AI Generated Test: ${goal.substring(0, 40).trim()}`;
}

function buildTestCase(testName: string, steps: TestStep[]): TestCase {
  return {
    testName,
    steps,
    meta: {
      createdAt: new Date().toISOString(),
      version: 4,
    },
  };
}

async function captureLivePreview(browserManager: BrowserManager, hooks: RecordingRunHooks): Promise<void> {
  const page = browserManager.getPage();
  if (!page || page.isClosed()) {
    return;
  }

  try {
    await browserManager.capturePreview(LIVE_PREVIEW_PATH);
    hooks.onPreviewUpdated?.(LIVE_PREVIEW_PATH);
  } catch {
    return;
  }
}

function getStepLabel(step: TestStep): string {
  const s = step.selectors;
  if (s) {
    const name = s.text || s.ariaLabel || s.label || s.placeholder || s.title || s.alt || s.id || s.name;
    if (name) {
      return `${s.role ? `${s.role} ` : ''}"${name}"`.trim();
    }
  }

  if (step.target && !step.target.includes('[data-ai-id')) {
    return step.target;
  }

  return 'element';
}
