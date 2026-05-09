import OpenAI from 'openai';
import type { Page } from 'playwright';
import { z } from 'zod';
import type { TestStep } from '../utils/types.js';
import { getDomSnapshot } from '../utils/domUtils.js';

const AIActionSchema = z.object({
  action: z.enum(['navigate', 'click', 'type', 'assert', 'scroll', 'press', 'wait', 'GOAL_REACHED']),
  target: z.string().nullish().or(z.literal('')),
  value: z.string().nullish().or(z.literal('')),
  thought: z.string().nullish().or(z.literal('')),
  assertion: z.enum(['visible', 'notVisible', 'textIncludes', 'urlIncludes']).nullish().or(z.literal('')),
  expected: z.string().nullish().or(z.literal('')),
});

type AgentDecision = TestStep | 'GOAL_REACHED' | 'FAILED';

export interface AIAgentConfig {
  apiKey?: string;
  baseURL?: string;
  providerName?: string;
  primaryModel?: string;
  fallbackModels?: string[];
}

export class AIAgent {
  private readonly goal: string;
  private readonly maxSteps: number;
  private currentSteps = 0;
  private readonly client: OpenAI;
  private readonly providerName: string;
  private readonly primaryModel: string;
  private readonly modelRotation: string[];
  private currentModelIndex = 0;

  constructor(goal: string, maxSteps = 15, config: AIAgentConfig = {}) {
    this.goal = goal;
    this.maxSteps = maxSteps;

    const apiKey = config.apiKey || process.env.AI_API_KEY || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Missing AI API key. Set AI_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_KEY in your .env file.',
      );
    }

    const baseURL = resolveBaseUrl(config.baseURL);
    this.providerName = config.providerName || process.env.AI_PROVIDER || inferProviderName(baseURL);
    this.primaryModel = config.primaryModel || process.env.AI_MODEL || inferDefaultModel(baseURL);
    this.modelRotation = dedupeModels([
      this.primaryModel,
      ...(config.fallbackModels?.length ? config.fallbackModels : parseFallbackModelsFromEnv()),
    ]);

    this.client = new OpenAI({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
    });
  }

  async getNextStep(page: Page, previousSteps: TestStep[], lastError: string | null = null): Promise<AgentDecision> {
    if (this.currentSteps >= this.maxSteps) {
      return 'FAILED';
    }

    this.currentSteps += 1;
    console.log('[Agent] Extracting DOM information...');

    const domSnapshot = await getDomSnapshot(page);
    let domElements = domSnapshot.elements;

    if (domElements.length === 0) {
      console.log('[Agent] No interactive elements found. Waiting for dynamic content.');
      await page.waitForTimeout(2000);
      domElements = (await getDomSnapshot(page)).elements;
    }

    console.log(`[Agent] DOM extraction complete. Found ${domElements.length} interactive elements.`);

    const prompt = this.buildPrompt(page.url(), domSnapshot, previousSteps, lastError);
    let attempt = 0;
    let schemaErrorFeedback = '';

    while (attempt < 5) {
      try {
        const modelName = attempt === 0 ? this.primaryModel : this.getNextModel();
        console.log(`[Agent] Sending request to ${this.providerName} (${modelName})...`);

        const responseText = await this.requestDecision(prompt + schemaErrorFeedback, modelName);
        console.log(`[Agent] AI Response: ${responseText}`);

        const parsed = AIActionSchema.parse(JSON.parse(stripCodeFences(responseText)));
        console.log(`[Agent] AI Thought: ${parsed.thought || ''}`);

        if (parsed.action === 'GOAL_REACHED') {
          return 'GOAL_REACHED';
        }

        return {
          action: parsed.action,
          target: parsed.target || undefined,
          value: parsed.value || undefined,
          assertion: parsed.assertion || undefined,
          expected: parsed.expected || undefined,
        };
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof z.ZodError) {
          console.log('[Agent] AI returned invalid JSON. Asking it to self-correct.');
          schemaErrorFeedback = `\n\nYOUR LAST RESPONSE WAS INVALID. ERROR: ${stringifyError(error)}. Return only one valid JSON object matching the required schema.`;
          attempt += 1;
          continue;
        }

        schemaErrorFeedback = '';
        const status = typeof error === 'object' && error && 'status' in error ? (error as { status?: number }).status : undefined;
        console.error(`[Agent] API error (${status ?? 'unknown'}): ${stringifyError(error)}`);

        if (status === 429 || status === 503 || status === 400 || status === 404) {
          console.log('[Agent] Switching to the next model in rotation.');
          attempt += 1;
          continue;
        }

        attempt += 1;
        if (attempt >= 5) {
          return 'FAILED';
        }

        const retryAfterSeconds = this.extractRetryAfter(error);
        const delayMs = retryAfterSeconds > 0 ? (retryAfterSeconds + 1) * 1000 : 4000 * attempt;
        console.log(`[Agent] Waiting ${Math.round(delayMs / 1000)}s before retry ${attempt}...`);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
      }
    }

    return 'FAILED';
  }

  private buildPrompt(
    currentUrl: string,
    domSnapshot: Awaited<ReturnType<typeof getDomSnapshot>>,
    previousSteps: TestStep[],
    lastError: string | null,
  ): string {
    const historyText =
      previousSteps.length > 0
        ? previousSteps
            .slice(-10)
            .map((step, index) => {
              const targetPart = step.target ? ` on "${step.target}"` : '';
              const valuePart = step.value ? ` with value "${step.value}"` : '';
              const resultPart = step.result?.error ? ` (ERROR: ${step.result.error})` : ' (SUCCESS)';
              return `${index + 1}. ${step.action}${targetPart}${valuePart}${resultPart}`;
            })
            .join('\n')
        : 'No actions taken yet.';

    return `
You are an autonomous browser agent. Your goal: "${this.goal}"

=== ACTION HISTORY ===
${historyText}
${lastError ? `\nLast error: ${lastError}\n` : ''}
=== CURRENT DOM SNAPSHOT ===
Current URL: ${currentUrl}
Page title: ${domSnapshot.pageTitle}
Interactive elements found: ${domSnapshot.elements.length}

Full DOM snapshot JSON:
${JSON.stringify(domSnapshot, null, 2)}

TASK:
1. If the goal is already achieved, return {"action":"GOAL_REACHED","target":null,"value":null,"thought":"..."}.
2. Otherwise choose exactly one next action to make progress.

Available actions:
- navigate: set target=null, value to a complete URL.
- click: set target to a selector from the DOM snapshot.
- type: set target to a selector from the DOM snapshot and value to the text to enter.
- press: set value to a key such as "Enter", "Tab", "ArrowDown".
- scroll: set value to "down" or "up".
- wait: set value to a milliseconds duration like "500" or "1500".
- GOAL_REACHED: use when the goal is achieved.

Rules:
- target MUST exactly match a selector from the DOM snapshot.
- Do not invent selectors or values that are unrealistic for the page.
- Do not repeat an action already executed successfully.
- Prefer visible actionable elements with labels, placeholders, or text.
- If no suitable element is found, use scroll or wait.
- Respond with ONLY valid JSON. No markdown.
`;
  }

  private async requestDecision(prompt: string, model: string): Promise<string> {
    let timeoutId: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('AI Timeout')), 45000);
    });

    try {
      const result = await Promise.race([
        this.client.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: 'You are a QA agent. You must only reply with valid JSON.' },
            { role: 'user', content: prompt },
          ],
          max_tokens: 500,
          temperature: 0.2,
        }),
        timeoutPromise,
      ]);

      if (!result.choices?.length) {
        throw new Error(`API returned no choices. Response: ${JSON.stringify(result)}`);
      }

      return result.choices[0]?.message?.content || '{}';
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private getNextModel(): string {
    const model = this.modelRotation[this.currentModelIndex % this.modelRotation.length];
    this.currentModelIndex += 1;
    return model || this.primaryModel;
  }

  private extractRetryAfter(error: unknown): number {
    const message = stringifyError(error);
    const match = message.match(/retry in ([\d.]+)s/i);
    return match?.[1] ? Math.ceil(Number.parseFloat(match[1])) : 0;
  }
}

function stripCodeFences(value: string): string {
  return value.replace(/```json/gi, '').replace(/```/g, '').trim();
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function parseFallbackModelsFromEnv(): string[] {
  const multiValue = process.env.AI_FALLBACK_MODELS;
  if (multiValue) {
    return multiValue
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean);
  }

  const legacyValue = process.env.AI_FALLBACK_MODEL;
  return legacyValue ? [legacyValue] : [];
}

function dedupeModels(models: string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))];
}

function resolveBaseUrl(override?: string): string | undefined {
  if (override) {
    return override;
  }

  if (process.env.AI_BASE_URL) {
    return process.env.AI_BASE_URL;
  }

  return process.env.OPENROUTER_API_KEY ? 'https://openrouter.ai/api/v1' : undefined;
}

function inferProviderName(baseURL?: string): string {
  if (!baseURL) {
    return 'OpenAI';
  }

  if (baseURL.includes('openrouter.ai')) {
    return 'OpenRouter';
  }

  if (baseURL.includes('openai.com')) {
    return 'OpenAI';
  }

  return 'AI provider';
}

function inferDefaultModel(baseURL?: string): string {
  if (baseURL?.includes('openrouter.ai')) {
    return 'openai/gpt-4.1-mini';
  }

  return 'gpt-4.1-mini';
}
