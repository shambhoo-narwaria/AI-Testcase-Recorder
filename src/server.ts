import * as dotenv from 'dotenv';
import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import { runRecording, type RecordAiConfig, type RecordConfig } from './core/RecordingRunner.js';
import type { TestCase, TestStep } from './utils/types.js';
import * as fs from 'fs';
import { exec } from 'child_process';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const port = Number(process.env.PORT ?? 3000);

interface SessionState {
  status: 'idle' | 'starting' | 'recording' | 'completed' | 'stopped' | 'failed';
  logs: string[];
  steps: TestStep[];
  previewPath: string | null;
  outputPath: string | null;
  testCase: TestCase | null;
  error: string | null;
  currentConfig: RecordConfig | null;
}

const sessionState: SessionState = {
  status: 'idle',
  logs: [],
  steps: [],
  previewPath: null,
  outputPath: null,
  testCase: null,
  error: null,
  currentConfig: null,
};

let activeRun: Promise<void> | null = null;

// Load existing test case if present
const existingTestCasePath = path.resolve(process.cwd(), 'output', 'test-case.json');
if (fs.existsSync(existingTestCasePath)) {
  try {
    const raw = fs.readFileSync(existingTestCasePath, 'utf-8');
    const testCase = JSON.parse(raw) as TestCase;
    sessionState.testCase = testCase;
    sessionState.steps = testCase.steps;
    sessionState.status = 'idle';
  } catch (err) {
    console.warn('[Server] Failed to load existing test-case.json:', err);
  }
}

app.use(express.json());
app.use('/artifacts', express.static(path.resolve(process.cwd(), 'artifacts')));
app.use('/output', express.static(path.resolve(process.cwd(), 'output')));
app.use(express.static(path.resolve(__dirname, '..', 'public')));

app.get('/api/session', (_req, res) => {
  res.json(buildSessionPayload());
});

app.post('/api/recordings', async (req, res) => {
  if (activeRun) {
    res.status(409).json({ error: 'A recording session is already running.' });
    return;
  }

  const config = normalizeRecordConfig(req.body);
  if (!config) {
    res.status(400).json({ error: 'Invalid payload. startUrl and goal are required.' });
    return;
  }

  resetSession(config);
  emitSession();

  activeRun = startRecording(config).finally(() => {
    activeRun = null;
  });

  res.status(202).json({ ok: true });
});

app.post('/api/playback', async (req, res) => {
  if (activeRun) {
    res.status(409).json({ error: 'A session is already running.' });
    return;
  }

  const testCase = req.body as TestCase;
  if (!testCase || !Array.isArray(testCase.steps)) {
    res.status(400).json({ error: 'Invalid test case. steps array is required.' });
    return;
  }

  resetSessionForPlayback(testCase);
  emitSession();

  activeRun = startPlayback().finally(() => {
    activeRun = null;
  });

  res.status(202).json({ ok: true });
});

app.use((_req, res) => {
  res.sendFile(path.resolve(__dirname, '..', 'public', 'index.html'));
});

io.on('connection', (socket) => {
  socket.emit('session:update', buildSessionPayload());
});

httpServer.listen(port, () => {
  console.log(`[GUI] Server running at http://localhost:${port}`);
});

async function startRecording(config: RecordConfig): Promise<void> {
  await runRecording(config, {
    onStatus(status) {
      sessionState.status = toSessionStatus(status);
      emitSession();
    },
    onLog(message) {
      sessionState.logs.push(message);
      if (sessionState.logs.length > 200) {
        sessionState.logs = sessionState.logs.slice(-200);
      }
      io.emit('log:append', message);
      emitSession();
    },
    onStepRecorded(_step, steps) {
      sessionState.steps = [...steps];
      emitSession();
    },
    onPreviewUpdated(previewPath) {
      sessionState.previewPath = toPublicAssetPath(previewPath);
      io.emit('preview:update', sessionState.previewPath);
      emitSession();
    },
    onFinished(result) {
      sessionState.steps = result.steps;
      sessionState.testCase = result.testCase;
      sessionState.outputPath = toPublicAssetPath(result.outputPath);
      sessionState.error = result.error ?? null;
      sessionState.status = result.error ? 'failed' : result.goalReached ? 'completed' : 'stopped';
      emitSession();
    },
  });
}

async function startPlayback(): Promise<void> {
  sessionState.status = 'recording';
  sessionState.logs.push('[Playback] Starting npm run playback...');
  emitSession();

  const child = exec('npm run playback');

  child.stdout?.on('data', (data) => {
    const lines = String(data).split('\n');
    for (const line of lines) {
      if (line.trim()) {
        sessionState.logs.push(line.trim());
        io.emit('log:append', line.trim());
      }
    }
    if (sessionState.logs.length > 200) sessionState.logs = sessionState.logs.slice(-200);
    emitSession();
  });

  child.stderr?.on('data', (data) => {
    sessionState.logs.push(`[Error] ${String(data).trim()}`);
    emitSession();
  });

  child.on('close', (code) => {
    sessionState.status = code === 0 ? 'completed' : 'failed';
    sessionState.logs.push(`[Playback] Process exited with code ${code}`);
    emitSession();
  });
}

function normalizeRecordConfig(payload: unknown): RecordConfig | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const maybe = payload as {
    startUrl?: unknown;
    goal?: unknown;
    ai?: RecordAiConfig;
  };

  if (typeof maybe.startUrl !== 'string' || typeof maybe.goal !== 'string') {
    return null;
  }

  const config: RecordConfig = {
    startUrl: maybe.startUrl,
    goal: maybe.goal,
  };

  const ai = sanitizeAiConfig(maybe.ai);
  if (ai) {
    config.ai = ai;
  }

  return config;
}

function sanitizeAiConfig(ai: RecordAiConfig | undefined): RecordAiConfig | undefined {
  if (!ai) {
    return undefined;
  }

  const next: RecordAiConfig = {};

  if (typeof ai.provider === 'string' && ai.provider.trim()) {
    next.provider = ai.provider.trim();
  }

  if (typeof ai.model === 'string' && ai.model.trim()) {
    next.model = ai.model.trim();
  }

  if (typeof ai.baseUrl === 'string' && ai.baseUrl.trim()) {
    next.baseUrl = ai.baseUrl.trim();
  }

  if (Array.isArray(ai.fallbackModels)) {
    const fallbackModels = ai.fallbackModels.filter((model): model is string => typeof model === 'string' && model.trim().length > 0);
    if (fallbackModels.length) {
      next.fallbackModels = fallbackModels;
    }
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

function buildSessionPayload() {
  return {
    status: sessionState.status,
    logs: sessionState.logs,
    steps: sessionState.steps,
    previewPath: sessionState.previewPath,
    outputPath: sessionState.outputPath,
    testCase: sessionState.testCase,
    error: sessionState.error,
    currentConfig: sessionState.currentConfig,
  };
}

function emitSession(): void {
  io.emit('session:update', buildSessionPayload());
}

function resetSession(config: RecordConfig): void {
  sessionState.status = 'starting';
  sessionState.logs = [];
  sessionState.steps = [];
  sessionState.previewPath = null;
  sessionState.outputPath = null;
  sessionState.testCase = null;
  sessionState.error = null;
  sessionState.currentConfig = config;
}

function resetSessionForPlayback(testCase: TestCase): void {
  sessionState.status = 'starting';
  sessionState.logs = [];
  sessionState.steps = testCase.steps;
  sessionState.previewPath = null;
  sessionState.outputPath = null;
  sessionState.testCase = testCase;
  sessionState.error = null;
  sessionState.currentConfig = null;
}

function toPublicAssetPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const artifactsPrefix = `${process.cwd().replace(/\\/g, '/')}/artifacts/`;
  const outputPrefix = `${process.cwd().replace(/\\/g, '/')}/output/`;

  if (normalized.startsWith(artifactsPrefix)) {
    return `/artifacts/${normalized.slice(artifactsPrefix.length)}`;
  }

  if (normalized.startsWith(outputPrefix)) {
    return `/output/${normalized.slice(outputPrefix.length)}`;
  }

  if (normalized.startsWith('artifacts/')) {
    return `/${normalized}`;
  }

  if (normalized.startsWith('output/')) {
    return `/${normalized}`;
  }

  return normalized;
}

function toSessionStatus(status: string): SessionState['status'] {
  if (status === 'starting' || status === 'recording' || status === 'completed' || status === 'stopped' || status === 'failed') {
    return status;
  }

  return 'idle';
}
