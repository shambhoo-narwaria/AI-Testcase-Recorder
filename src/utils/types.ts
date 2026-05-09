export type AssertionMode = 'visible' | 'notVisible' | 'textIncludes' | 'urlIncludes';

export interface StepResult {
  ts?: string | undefined;
  urlBefore?: string | undefined;
  urlAfter?: string | undefined;
  error?: string | undefined;
  screenshotPath?: string | undefined;
  stateChange?: 'Changed' | 'NO_CHANGE_DETECTED' | undefined;
}

export type ActionType = 'navigate' | 'click' | 'type' | 'assert' | 'scroll' | 'press' | 'wait' | 'GOAL_REACHED';

export interface TestStep {
  action: ActionType;
  url?: string | undefined;
  target?: string | undefined;
  value?: string | undefined;
  expected?: string | undefined;
  assertion?: AssertionMode | undefined;
  selectors?: {
    id?: string | undefined;
    css?: string | undefined;
    xpath?: string | undefined;
    tagName?: string | undefined;
    inputType?: string | undefined;
    text?: string | undefined;
    parentText?: string | undefined;
    ariaLabel?: string | undefined;
    testId?: string | undefined;
    role?: string | undefined;
    name?: string | undefined;
    label?: string | undefined;
    placeholder?: string | undefined;
    title?: string | undefined;
    alt?: string | undefined;
    shortCss?: string | undefined;
    href?: string | undefined;
    nthOfType?: number | undefined;
  } | undefined;
  result?: StepResult | undefined;
}

export interface TestCase {
  testName: string;
  steps: TestStep[];
  meta?: {
    createdAt?: string | undefined;
    version?: number | undefined;
  } | undefined;
}
