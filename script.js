/* =========================================================
   GlycoSense — Diabetes Prediction System
   Vanilla JS: validation, API integration, results, UI state
   ========================================================= */

// ---------------------------------------------------------
// Configuration
// API contract (from /openapi.json):
//   POST /predict  body: PatientInput  ->  PredictionResponse
//   GET  /health   -> { status, model_loaded, model_name, threshold }
// ---------------------------------------------------------
const API_BASE = 'https://diabetes-prediction-backend-api.onrender.com';
const REQUEST_TIMEOUT_MS = 90_000; // Render free tier can take ~60s to cold-start
const RETRYABLE_STATUS = [502, 503, 504];

// Field definitions mirror the backend PatientInput schema.
const FIELDS = {
  gender: { type: 'choice', label: 'Gender', options: ['Male', 'Female', 'Other'] },
  age: { type: 'number', label: 'Age', min: 0, max: 120, minInclusive: true, unit: 'years' },
  hypertension: { type: 'binary', label: 'Hypertension' },
  heart_disease: { type: 'binary', label: 'Heart disease' },
  smoking_history: {
    type: 'choice',
    label: 'Smoking history',
    options: ['never', 'former', 'current', 'ever', 'not current', 'No Info'],
  },
  bmi: { type: 'number', label: 'BMI', min: 0, max: 100, minInclusive: false, unit: 'kg/m²' },
  HbA1c_level: { type: 'number', label: 'HbA1c level', min: 0, max: 20, minInclusive: false, unit: '%' },
  blood_glucose_level: {
    type: 'number',
    label: 'Blood glucose',
    min: 0,
    max: 600,
    minInclusive: false,
    unit: 'mg/dL',
  },
};
const FIELD_NAMES = Object.keys(FIELDS);

const SMOKING_LABELS = {
  never: 'Never',
  former: 'Former',
  current: 'Current',
  ever: 'Ever',
  'not current': 'Not current',
  'No Info': 'No info',
};

// ---------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const refreshIcons = () => window.lucide && window.lucide.createIcons();
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const form = $('#assessmentForm');
const submitBtn = $('#submitBtn');
const views = {
  empty: $('#resultsEmpty'),
  loading: $('#resultsLoading'),
  error: $('#resultsError'),
  result: $('#resultCard'),
};

// In-memory state only. Nothing health-related is persisted.
const state = {
  touched: new Set(),
  loading: false,
  lastPayload: null,
  history: [],
};

// ---------------------------------------------------------
// Toasts
// ---------------------------------------------------------
function toast(type, title, msg = '', duration = 4500) {
  const icons = { success: 'check-circle-2', error: 'alert-circle', info: 'info' };
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `
    <i data-lucide="${icons[type] || 'info'}"></i>
    <div class="toast__body">
      <p class="toast__title">${escapeHtml(title)}</p>
      ${msg ? `<p class="toast__msg">${escapeHtml(msg)}</p>` : ''}
    </div>
    <button class="toast__close" type="button" aria-label="Dismiss notification"><i data-lucide="x"></i></button>`;
  $('#toasts').appendChild(el);
  refreshIcons();
  const close = () => {
    if (!el.isConnected) return;
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 250);
  };
  el.querySelector('.toast__close').addEventListener('click', close);
  setTimeout(close, duration);
}


// ---------------------------------------------------------
// Form: reading values & validation
// ---------------------------------------------------------
function readRaw(name) {
  const def = FIELDS[name];
  if (def.type === 'number') return form.elements[name].value.trim();
  if (name === 'smoking_history') return form.elements[name].value;
  const checked = form.querySelector(`input[name="${name}"]:checked`);
  return checked ? checked.value : '';
}

/** Returns an error message, or '' when valid. Bounds match the backend schema. */
function validateField(name) {
  const def = FIELDS[name];
  const raw = readRaw(name);

  if (def.type === 'number') {
    const input = form.elements[name];
    if (raw === '' && input.validity.badInput) return 'Enter a valid number.';
    if (raw === '') return `${def.label} is required.`;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 'Enter a valid number.';
    const belowMin = def.minInclusive ? n < def.min : n <= def.min;
    if (belowMin || n > def.max) {
      return def.minInclusive
        ? `Enter a value between ${def.min} and ${def.max}.`
        : `Enter a value above ${def.min} and up to ${def.max}.`;
    }
    return '';
  }
  if (def.type === 'binary') return raw === '0' || raw === '1' ? '' : 'Please select Yes or No.';
  return def.options.includes(raw) ? '' : `Please select ${def.label.toLowerCase()}.`;
}

function setFieldError(name, message) {
  const field = form.querySelector(`[data-field="${name}"]`);
  const err = $(`#${CSS.escape(name)}-error`);
  field.classList.toggle('has-error', Boolean(message));
  err.innerHTML = message ? `<i data-lucide="alert-circle"></i>${escapeHtml(message)}` : '';
  $$('input, select', field).forEach((el) => el.setAttribute('aria-invalid', message ? 'true' : 'false'));
  if (message) refreshIcons();
}

function validateAll() {
  let firstInvalid = null;
  FIELD_NAMES.forEach((name) => {
    const msg = validateField(name);
    setFieldError(name, msg);
    if (msg && !firstInvalid) firstInvalid = name;
  });
  return firstInvalid;
}

function updateProgress() {
  const done = FIELD_NAMES.filter((n) => readRaw(n) !== '' && !validateField(n)).length;
  const el = $('#formProgress');
  el.textContent = `${done} of 8 fields completed`;
  el.classList.toggle('is-complete', done === 8);
}

/** Build the exact JSON body expected by POST /predict. */
function buildPayload() {
  return {
    gender: readRaw('gender'),
    age: Number(readRaw('age')),
    hypertension: Number(readRaw('hypertension')),
    heart_disease: Number(readRaw('heart_disease')),
    smoking_history: readRaw('smoking_history'),
    bmi: Number(readRaw('bmi')),
    HbA1c_level: Number(readRaw('HbA1c_level')),
    blood_glucose_level: Number(readRaw('blood_glucose_level')),
  };
}

function focusField(name) {
  const field = form.querySelector(`[data-field="${name}"]`);
  const target = field.querySelector('input:checked') || field.querySelector('input, select');
  field.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => target && target.focus({ preventScroll: true }), 300);
}

function initForm() {
  // Live validation once a field has been touched
  const onChange = (e) => {
    const name = e.target.name;
    if (!FIELDS[name]) return;
    if (e.type === 'change' || e.type === 'focusout') state.touched.add(name);
    if (state.touched.has(name)) setFieldError(name, validateField(name));
    updateProgress();
  };
  form.addEventListener('input', onChange);
  form.addEventListener('change', onChange);
  form.addEventListener('focusout', (e) => {
    if (e.target.type === 'number' && e.target.value !== '') onChange(e);
  });

  // Block non-numeric characters like "e", "+" in number inputs
  $$('input[type="number"]', form).forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (['e', 'E', '+', '-'].includes(e.key)) e.preventDefault();
    });
    input.addEventListener('wheel', () => input.blur(), { passive: true });
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.loading) return;
    FIELD_NAMES.forEach((n) => state.touched.add(n));
    const firstInvalid = validateAll();
    if (firstInvalid) {
      const count = FIELD_NAMES.filter((n) => validateField(n)).length;
      toast('error', 'Please review the form', `${count} field${count > 1 ? 's need' : ' needs'} attention.`);
      focusField(firstInvalid);
      return;
    }
    submitPrediction(buildPayload());
  });

  form.addEventListener('reset', () => {
    if (state.loading) return;
    state.touched.clear();
    // Native reset runs after this handler; sync UI on next tick
    setTimeout(() => {
      FIELD_NAMES.forEach((n) => setFieldError(n, ''));
      updateProgress();
    });
  });
  $('#resetBtn').addEventListener('click', (e) => {
    if (state.loading) {
      e.preventDefault();
      return;
    }
    toast('info', 'Form cleared', 'All fields have been reset.', 2500);
  });
}

// ---------------------------------------------------------
// API
// ---------------------------------------------------------
class ApiError extends Error {
  constructor(kind, status = 0, detail = null) {
    super(kind);
    this.kind = kind; // 'network' | 'timeout' | 'validation' | 'server' | 'invalid-response'
    this.status = status;
    this.detail = detail;
  }
}

async function fetchWithTimeout(url, options = {}, timeout = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    throw new ApiError(err.name === 'AbortError' ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
}

/** Ensure the response has every field promised by PredictionResponse. */
function isValidPrediction(d) {
  return (
    d &&
    Number.isInteger(d.prediction) &&
    typeof d.result === 'string' &&
    typeof d.probability === 'number' &&
    typeof d.probability_percent === 'number' &&
    typeof d.threshold === 'number'
  );
}

async function requestPrediction(payload, attempt = 1) {
  let res;
  try {
    res = await fetchWithTimeout(`${API_BASE}/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // One automatic retry for network hiccups during a cold start
    if (err.kind === 'network' && attempt === 1) {
      await new Promise((r) => setTimeout(r, 3000));
      return requestPrediction(payload, 2);
    }
    throw err;
  }

  if (RETRYABLE_STATUS.includes(res.status) && attempt === 1) {
    await new Promise((r) => setTimeout(r, 4000));
    return requestPrediction(payload, 2);
  }
  if (res.status === 422) {
    let detail = null;
    try {
      detail = (await res.json()).detail;
    } catch {}
    throw new ApiError('validation', 422, detail);
  }
  if (!res.ok) throw new ApiError('server', res.status);

  let data;
  try {
    data = await res.json();
  } catch {
    throw new ApiError('invalid-response', res.status);
  }
  if (!isValidPrediction(data)) throw new ApiError('invalid-response', res.status);
  return data;
}

/** Map internal errors to safe, user-friendly copy (never shows raw backend output). */
function friendlyError(err) {
  switch (err.kind) {
    case 'timeout':
      return {
        title: 'The server is taking too long',
        text: 'The prediction service may still be starting up. Please wait a moment and try again.',
      };
    case 'network':
      return {
        title: 'Unable to reach the prediction service',
        text: 'Check your internet connection. If it persists, the service may be temporarily offline.',
      };
    case 'validation':
      return {
        title: 'Some values were not accepted',
        text: 'The service could not accept one or more inputs. Please review the highlighted fields.',
      };
    case 'invalid-response':
      return {
        title: 'Unexpected response',
        text: 'The prediction service returned a response we could not read. Please try again later.',
      };
    default:
      return {
        title: 'Prediction service unavailable',
        text: 'The service encountered a problem processing your request. Please try again in a few minutes.',
      };
  }
}

// ---------------------------------------------------------
// Prediction flow
// ---------------------------------------------------------
function showView(name) {
  Object.entries(views).forEach(([key, el]) => (el.hidden = key !== name));
}

function setLoading(on) {
  state.loading = on;
  submitBtn.disabled = on;
  submitBtn.classList.toggle('is-loading', on);
  submitBtn.setAttribute('aria-busy', String(on));
  $('.btn__label', submitBtn).textContent = on ? 'Analyzing…' : 'Predict Diabetes Risk';
  $('#resetBtn').disabled = on;
}

async function submitPrediction(payload) {
  state.lastPayload = payload;
  setLoading(true);
  showView('loading');
  $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Progressive messaging for Render cold starts
  const msg = $('#loadingMsg');
  msg.innerHTML = '<span class="spinner"></span>Analyzing your health indicators…';
  const timers = [
    setTimeout(() => {
      msg.innerHTML = '<span class="spinner"></span>Waking up the prediction server. This can take up to a minute…';
      setApiStatus('waking');
    }, 5000),
    setTimeout(() => {
      msg.innerHTML = '<span class="spinner"></span>Still working — the server is almost ready…';
    }, 30000),
  ];

  try {
    const data = await requestPrediction(payload);
    setApiStatus('online');
    const entry = { id: Date.now(), at: new Date(), payload, data };
    state.history.unshift(entry);
    renderResult(entry);
    renderHistory();
    toast('success', 'Prediction complete', 'Your result is ready below.');
  } catch (err) {
    const err2 = err instanceof ApiError ? err : new ApiError('server');
    const { title, text } = friendlyError(err2);
    $('#errorTitle').textContent = title;
    $('#errorText').textContent = text;
    showView('error');
    toast('error', title);
    if (err2.kind === 'network' || err2.kind === 'timeout' || err2.kind === 'server') setApiStatus('offline');
    if (err2.kind === 'validation') highlightServerErrors(err2.detail);
  } finally {
    timers.forEach(clearTimeout);
    setLoading(false);
  }
}

/** Flag fields the backend rejected (422) without exposing raw messages. */
function highlightServerErrors(detail) {
  if (!Array.isArray(detail)) return;
  let first = null;
  detail.forEach((d) => {
    const name = Array.isArray(d.loc) ? d.loc[d.loc.length - 1] : null;
    if (FIELDS[name]) {
      setFieldError(name, 'This value was not accepted. Please check it.');
      first = first || name;
    }
  });
  if (first) setTimeout(() => focusField(first), 400);
}

// ---------------------------------------------------------
// Results rendering
// ---------------------------------------------------------
const fmtPct = (n) => `${Number(n).toFixed(1)}%`;
const fmtTime = (d) =>
  d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function paramRows(p) {
  return [
    ['Gender', p.gender],
    ['Age', p.age, 'years'],
    ['Hypertension', p.hypertension === 1 ? 'Yes' : 'No'],
    ['Heart disease', p.heart_disease === 1 ? 'Yes' : 'No'],
    ['Smoking history', SMOKING_LABELS[p.smoking_history] || p.smoking_history],
    ['BMI', p.bmi, 'kg/m²'],
    ['HbA1c level', p.HbA1c_level, '%'],
    ['Blood glucose', p.blood_glucose_level, 'mg/dL'],
  ];
}

/** Position the threshold tick on the semicircular gauge (fraction 0..1). */
function placeGaugeTick(fraction) {
  const angle = Math.PI * (1 - fraction);
  const cx = 100,
    cy = 100;
  const pt = (r) => [cx + r * Math.cos(angle), cy - r * Math.sin(angle)];
  const [x1, y1] = pt(66);
  const [x2, y2] = pt(94);
  const tick = $('#gaugeTick');
  tick.setAttribute('x1', x1);
  tick.setAttribute('y1', y1);
  tick.setAttribute('x2', x2);
  tick.setAttribute('y2', y2);
}

function renderResult({ at, payload, data }) {
  // Classification comes from the backend's `prediction`; no client-side thresholding.
  const positive = data.prediction === 1;
  const card = views.result;
  card.dataset.tone = positive ? 'positive' : 'negative';

  const pct = Math.max(0, Math.min(100, data.probability_percent));
  const thresholdPct = data.threshold * 100;

  $('#resultTime').textContent = fmtTime(at);
  $('#probValue').textContent = fmtPct(data.probability_percent);
  $('#thresholdLegend').textContent = `${data.threshold}`;
  placeGaugeTick(Math.max(0, Math.min(1, data.threshold)));

  const fill = $('#gaugeFill');
  fill.style.strokeDasharray = '0 100';
  requestAnimationFrame(() => requestAnimationFrame(() => (fill.style.strokeDasharray = `${pct} 100`)));

  const badge = $('#resultBadge');
  badge.innerHTML = `<i data-lucide="${positive ? 'alert-triangle' : 'check-circle-2'}"></i><span>${
    positive ? 'Positive prediction' : 'Negative prediction'
  }</span>`;

  $('#resultTitle').textContent = data.result;
  $('#resultExplain').textContent = positive
    ? `The model estimated a ${fmtPct(data.probability_percent)} probability of diabetes, which meets the backend's ` +
      `classification threshold of ${data.threshold} (${fmtPct(thresholdPct)}). This is a screening estimate, not a ` +
      `diagnosis. Please discuss these results with a healthcare professional, who can arrange confirmatory testing.`
    : `The model estimated a ${fmtPct(data.probability_percent)} probability of diabetes, which is below the backend's ` +
      `classification threshold of ${data.threshold} (${fmtPct(thresholdPct)}). This does not confirm that you are ` +
      `free of diabetes — models can miss cases. Continue regular check-ups and consult a professional about any symptoms.`;

  $('#metaPrediction').textContent = String(data.prediction);
  $('#metaProbability').textContent = data.probability.toFixed(4);
  $('#metaThreshold').textContent = String(data.threshold);
  $('#metaModel').textContent = data.model_name || '—';

  $('#paramsList').innerHTML = paramRows(payload)
    .map(
      ([k, v, unit]) =>
        `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}${unit ? `<small>${escapeHtml(unit)}</small>` : ''}</dd></div>`,
    )
    .join('');

  $('#resultDisclaimer').textContent =
    data.disclaimer ||
    'This prediction is generated by a machine learning model and is not a substitute for professional medical advice.';

  showView('result');
  refreshIcons();
}

function renderHistory() {
  const list = $('#historyList');
  $('#clearHistoryBtn').hidden = state.history.length === 0;
  if (!state.history.length) {
    list.innerHTML = '<p class="history__empty">Previous assessments from this session will appear here.</p>';
    return;
  }
  list.innerHTML = state.history
    .map((h) => {
      const p = h.payload;
      const tone = h.data.prediction === 1 ? 'positive' : 'negative';
      return `
      <button type="button" class="history-item" data-tone="${tone}" data-id="${h.id}"
        aria-label="View result from ${escapeHtml(fmtTime(h.at))}">
        <span class="history-item__dot" aria-hidden="true"></span>
        <span>
          <span class="history-item__title">${escapeHtml(h.data.result)}</span><br />
          <span class="history-item__sub">${escapeHtml(p.gender)}, ${escapeHtml(p.age)} yrs · HbA1c ${escapeHtml(
            p.HbA1c_level,
          )}% · Glucose ${escapeHtml(p.blood_glucose_level)} mg/dL</span>
        </span>
        <span class="history-item__prob">${fmtPct(h.data.probability_percent)}</span>
        <span class="history-item__time">${escapeHtml(
          h.at.toLocaleTimeString(undefined, { timeStyle: 'short' }),
        )}</span>
      </button>`;
    })
    .join('');
}

function initResults() {
  $('#historyList').addEventListener('click', (e) => {
    const btn = e.target.closest('.history-item');
    if (!btn) return;
    const entry = state.history.find((h) => String(h.id) === btn.dataset.id);
    if (entry) {
      renderResult(entry);
      views.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
  $('#clearHistoryBtn').addEventListener('click', () => {
    state.history = [];
    renderHistory();
    showView('empty');
    toast('info', 'Session history cleared', '', 2500);
  });
  $('#newAssessmentBtn').addEventListener('click', () => {
    form.reset();
    $('#assessment').scrollIntoView({ behavior: 'smooth' });
    setTimeout(() => form.querySelector('input[name="gender"]').focus({ preventScroll: true }), 500);
  });
  $('#retryBtn').addEventListener('click', () => {
    if (state.lastPayload && !state.loading) submitPrediction(state.lastPayload);
  });
  $('#printBtn').addEventListener('click', () => {
    document.body.classList.add('print-result');
    window.print();
  });
  window.addEventListener('afterprint', () => document.body.classList.remove('print-result'));
}

// ---------------------------------------------------------
// API status: warm up the Render instance on page load
// ---------------------------------------------------------
function setApiStatus(s) {
  const el = $('#apiStatus');
  const labels = { checking: 'Checking API', waking: 'API waking up', online: 'API online', offline: 'API unavailable' };
  el.dataset.state = s;
  $('.api-status__label', el).textContent = labels[s];
  el.title = labels[s];
}

async function checkHealth() {
  setApiStatus('checking');
  const slow = setTimeout(() => setApiStatus('waking'), 4000);
  try {
    const res = await fetchWithTimeout(`${API_BASE}/health`, {}, REQUEST_TIMEOUT_MS);
    const data = res.ok ? await res.json() : null;
    if (state.loading) return; // the prediction flow owns the status now
    setApiStatus(data && data.model_loaded ? 'online' : 'offline');
  } catch {
    if (!state.loading) setApiStatus('offline');
  } finally {
    clearTimeout(slow);
  }
}

// ---------------------------------------------------------
// Navigation: shadow on scroll + active section link
// ---------------------------------------------------------
function initNav() {
  const nav = $('.nav');
  const onScroll = () => nav.classList.toggle('is-scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const links = $$('.nav__links a');
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        links.forEach((a) => a.classList.toggle('is-active', a.getAttribute('href') === `#${entry.target.id}`));
      });
    },
    { rootMargin: '-45% 0px -50% 0px' },
  );
  ['overview', 'assessment', 'results', 'model'].forEach((id) => observer.observe(document.getElementById(id)));
}

// ---------------------------------------------------------
// Boot
// ---------------------------------------------------------
function init() {
  $('#year').textContent = new Date().getFullYear();
  refreshIcons();
  initNav();
  initForm();
  initResults();
  updateProgress();
  checkHealth();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
