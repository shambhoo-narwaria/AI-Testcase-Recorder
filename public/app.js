const socket = io();

const recordForm = document.getElementById('recordForm');
const startButton = document.getElementById('startButton');
const sessionStatus = document.getElementById('sessionStatus');
const statusHint = document.getElementById('statusHint');
const previewImage = document.getElementById('previewImage');
const previewEmpty = document.getElementById('previewEmpty');
const stepsList = document.getElementById('stepsList');
const logOutput = document.getElementById('logOutput');
const jsonOutput = document.getElementById('jsonOutput');
const playbackButton = document.getElementById('playbackButton');

recordForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const formData = new FormData(recordForm);
  const payload = {
    startUrl: String(formData.get('startUrl') || '').trim(),
    goal: String(formData.get('goal') || '').trim(),
    ai: {
      provider: String(formData.get('provider') || '').trim() || undefined,
      model: String(formData.get('model') || '').trim() || undefined,
      baseUrl: String(formData.get('baseUrl') || '').trim() || undefined,
      fallbackModels: String(formData.get('fallbackModels') || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    },
  };

  setButtonLoading(true);

  try {
    const response = await fetch('/api/recordings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({ error: 'Failed to start recording.' }));
      alert(data.error || 'Failed to start recording.');
      setButtonLoading(false);
    }
  } catch (error) {
    alert(error instanceof Error ? error.message : 'Failed to start recording.');
    setButtonLoading(false);
  }
});

playbackButton.addEventListener('click', async () => {
  const jsonText = jsonOutput.textContent;
  let testCase;
  try {
    testCase = JSON.parse(jsonText);
  } catch {
    alert('No valid test case found in the Generated JSON panel.');
    return;
  }

  setButtonLoading(true);

  try {
    const response = await fetch('/api/playback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(testCase),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({ error: 'Failed to start playback.' }));
      alert(data.error || 'Failed to start playback.');
      setButtonLoading(false);
    }
  } catch (error) {
    alert(error instanceof Error ? error.message : 'Failed to start playback.');
    setButtonLoading(false);
  }
});

socket.on('session:update', (session) => {
  renderSession(session);
});

socket.on('log:append', () => {
  logOutput.scrollTop = logOutput.scrollHeight;
});

fetch('/api/session')
  .then((response) => response.json())
  .then((session) => renderSession(session))
  .catch(() => undefined);

function renderSession(session) {
  const status = session.status || 'idle';
  sessionStatus.textContent = capitalize(status);
  statusHint.textContent = getStatusHint(status, session);
  setButtonLoading(status === 'starting' || status === 'recording');
  playbackButton.disabled = (status === 'starting' || status === 'recording') || !session.testCase;

  const previewPath = session.previewPath;
  if (previewPath) {
    previewImage.src = `${previewPath}?t=${Date.now()}`;
    previewImage.style.display = 'block';
    previewEmpty.style.display = 'none';
  } else {
    previewImage.removeAttribute('src');
    previewImage.style.display = 'none';
    previewEmpty.style.display = 'grid';
  }

  const steps = Array.isArray(session.steps) ? session.steps : [];
  stepsList.innerHTML = steps
    .map(
      (step, index) => `
        <li class="step-item">
          <strong>${index + 1}. ${escapeHtml(step.action)}</strong>
          <p>${escapeHtml(describeStep(step))}</p>
        </li>
      `,
    )
    .join('');

  logOutput.textContent = Array.isArray(session.logs) && session.logs.length
    ? session.logs.join('\n')
    : 'Recorder logs will appear here.';

  jsonOutput.textContent = session.testCase
    ? JSON.stringify(session.testCase, null, 2)
    : 'Generated test case JSON will appear here.';
}

function setButtonLoading(isLoading) {
  startButton.disabled = isLoading;
  startButton.textContent = isLoading ? 'Processing...' : 'Start Recording';
  if (isLoading) playbackButton.disabled = true;
}

function describeStep(step) {
  const parts = [];
  if (step.target) parts.push(`target: ${step.target}`);
  if (step.url) parts.push(`url: ${step.url}`);
  if (step.value) parts.push(`value: ${step.value}`);
  if (step.result?.error) parts.push(`error: ${step.result.error}`);
  return parts.length ? parts.join(' | ') : 'Recorded successfully';
}

function getStatusHint(status, session) {
  if (status === 'recording') return 'Playwright is active and the AI agent is choosing the next step.';
  if (status === 'starting') return 'Launching the browser and preparing the recording run.';
  if (status === 'completed') return `Completed with ${session.steps?.length || 0} recorded steps.`;
  if (status === 'failed') return session.error || 'The run failed before reaching the goal.';
  if (status === 'stopped') return 'The run ended before the goal was fully achieved.';
  return 'Ready to start a new recording';
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
