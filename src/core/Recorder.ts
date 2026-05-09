import * as fs from 'fs';
import * as path from 'path';
import type { TestCase, TestStep } from '../utils/types.js';

const OUTPUT_DIR = path.resolve(process.cwd(), 'output');
const DEFAULT_TEST_CASE_PATH = path.join(OUTPUT_DIR, 'test-case.json');

export class Recorder {
  private readonly steps: TestStep[] = [];
  private readonly testName: string;
  private readonly createdAt: string = new Date().toISOString();

  constructor(testName: string) {
    this.testName = testName;
  }

  record(step: TestStep): void {
    console.log(`[Recorder] Recording step: ${step.action} ${step.target || step.url || step.value || ''}`);

    const now = new Date().toISOString();
    const enriched: TestStep = {
      ...step,
      result: {
        ts: step.result?.ts ?? now,
        urlBefore: step.result?.urlBefore,
        urlAfter: step.result?.urlAfter,
        error: step.result?.error,
        screenshotPath: step.result?.screenshotPath,
        stateChange: step.result?.stateChange,
      },
    };

    this.steps.push(enriched);
    this.save();
  }

  save(filename = DEFAULT_TEST_CASE_PATH): void {
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const testCase: TestCase = {
      testName: this.testName,
      steps: this.steps,
      meta: { createdAt: this.createdAt, version: 4 },
    };

    const filePath = path.isAbsolute(filename) ? filename : path.join(process.cwd(), filename);
    fs.writeFileSync(filePath, JSON.stringify(testCase, null, 2));
    console.log(`[Recorder] Test case saved to ${filePath}`);
  }

  getSteps(): TestStep[] {
    return this.steps;
  }
}
