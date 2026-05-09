import * as fs from 'fs';
import * as path from 'path';
import { BrowserManager } from '../src/core/BrowserManager.js';
import type { TestCase } from '../src/utils/types.js';

async function runPlayback(): Promise<void> {
  const filePath = path.resolve(process.cwd(), 'output', 'test-case.json');
  if (!fs.existsSync(filePath)) {
    console.error('No test case file found. Record a test first.');
    return;
  }

  const testCase: TestCase = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  console.log(`\n[Playback] Starting: ${testCase.testName}`);
  console.log('-------------------------------------------');

  const browserManager = new BrowserManager();
  await browserManager.init(false);

  try {
    let stepNumber = 1;

    for (const step of testCase.steps) {
      console.log(`[Step ${stepNumber}] Executing ${step.action} ${step.target || step.url || step.value || ''}`);
      await browserManager.executeStep(step, { stepIndex: stepNumber, isPlayback: true });
      stepNumber += 1;

      await new Promise((resolveDelay) => setTimeout(resolveDelay, 600));
    }

    console.log('-------------------------------------------');
    console.log('[Playback] Finished successfully.');
  } catch (error) {
    console.error('\n[Playback] Failed:', error);
  } finally {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2000));
    await browserManager.close();
  }
}

void runPlayback();
