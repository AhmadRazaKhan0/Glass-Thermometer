'use strict';

/* ==========================================================================
   Configuration
   ========================================================================== */

const MIN_TEMP = -30;
const MAX_TEMP = 100;
const DEFAULT_TEMP = 22;

const AUTO_SPEED = 5;            // °C per second in Auto mode (full sweep ≈ 26 s)
const MANUAL_EASING = 14;        // higher = liquid catches up with the slider faster
const SNAP_DISTANCE = 0.005;     // °C — stop easing when this close to the target
const MAX_FRAME_SECONDS = 0.05;  // avoids a jump after a background tab resumes
const SLIDER_STEP = 0.5;         // keep in sync with the range input's step
const REPEAT_DELAY = 380;        // ms before holding − / + starts repeating
const REPEAT_INTERVAL = 60;      // ms between repeats

// Live mode: real current temperature from Open-Meteo (free, no API key).
const LOCATION = { name: 'Karachi', latitude: 24.8607, longitude: 67.0011 };
const LIVE_SWEEP_FRACTIONS = [0.88, 0.12, 0.7, 0.25]; // up, down, up, down — then it settles
const LIVE_SEGMENT_SECONDS = 1.1;   // time for each swing
const LIVE_SETTLE_SECONDS = 1.6;    // final glide onto the real temperature
const LIVE_REFRESH_MS = 10 * 60 * 1000;
const LIVE_TIMEOUT_MS = 8000;

const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

// Liquid colour stops. Colours are interpolated linearly between neighbours.
const COLOR_STOPS = [
  { temp: -30, rgb: [38, 52, 190] },   // deep blue
  { temp: -10, rgb: [40, 110, 255] },  // blue
  { temp: 0, rgb: [34, 211, 238] },    // cyan
  { temp: 15, rgb: [125, 200, 255] },  // light blue
  { temp: 25, rgb: [60, 214, 110] },   // green
  { temp: 35, rgb: [250, 214, 40] },   // yellow
  { temp: 50, rgb: [255, 145, 30] },   // orange
  { temp: 70, rgb: [240, 40, 40] },    // red
  { temp: 100, rgb: [140, 10, 25] },   // deep red
];

// A temperature belongs to the first level whose `below` it is under.
const STATUS_LEVELS = [
  { below: -10, label: 'Extremely Cold' },
  { below: 0, label: 'Cold' },
  { below: 15, label: 'Cool' },
  { below: 25, label: 'Comfortable' },
  { below: 35, label: 'Warm' },
  { below: 50, label: 'Hot' },
  { below: 70, label: 'Very Hot' },
  { below: Infinity, label: 'Extremely Hot' },
];

const UNITS = {
  C: { symbol: '°C', buttonStep: 0.5, minorTick: 2, majorTick: 10, fromCelsius: (c) => c, toCelsius: (v) => v },
  F: { symbol: '°F', buttonStep: 1, minorTick: 4, majorTick: 20, fromCelsius: celsiusToFahrenheit, toCelsius: fahrenheitToCelsius },
};

/* ==========================================================================
   DOM references
   ========================================================================== */

const dom = {
  root: document.documentElement,
  app: document.getElementById('app'),
  thermo: document.getElementById('thermo'),
  scale: document.getElementById('scale'),
  scaleUnit: document.getElementById('scale-unit'),
  markerValue: document.getElementById('marker-value'),
  readoutLabel: document.getElementById('readout-label'),
  number: document.getElementById('temperature-number'),
  unit: document.getElementById('temperature-unit'),
  status: document.getElementById('temperature-status'),
  modeSwitch: document.getElementById('mode-switch'),
  modeHint: document.getElementById('mode-hint'),
  unitSwitch: document.getElementById('unit-switch'),
  slider: document.getElementById('temperature-slider'),
  sliderOutput: document.getElementById('slider-output'),
  decrease: document.getElementById('decrease'),
  increase: document.getElementById('increase'),
  limitMin: document.getElementById('limit-min'),
  limitMax: document.getElementById('limit-max'),
};

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/* ==========================================================================
   Application state
   ========================================================================== */

const state = {
  unit: 'C',
  mode: 'manual',            // 'live' | 'auto' | 'manual'
  direction: 1,              // Auto mode: 1 = warming, -1 = cooling
  temperature: DEFAULT_TEMP, // °C currently shown by the thermometer
  target: DEFAULT_TEMP,      // °C the user asked for (Manual mode)
};

const live = {
  phase: 'idle',        // 'idle' | 'loading' | 'sweep' | 'settled' | 'error'
  queue: [],            // °C waypoints still to visit during the sweep
  segment: null,        // the swing currently playing
  real: null,           // °C reported by the weather service
  updatedAt: null,
  failed: false,
  requestId: 0,         // lets stale responses be ignored
  controller: null,
  refreshTimer: null,
  swingHigh: true,
};

let frameId = null;
let lastFrameTime = 0;

/* ==========================================================================
   Pure helpers: conversion, normalisation, colour, status
   ========================================================================== */

function celsiusToFahrenheit(celsius) {
  return (celsius * 9) / 5 + 32;
}

function fahrenheitToCelsius(fahrenheit) {
  return ((fahrenheit - 32) * 5) / 9;
}

function clampTemperature(value) {
  return Math.min(MAX_TEMP, Math.max(MIN_TEMP, value));
}

// 0 at MIN_TEMP, 1 at MAX_TEMP
function normalizeTemperature(temperature) {
  return (clampTemperature(temperature) - MIN_TEMP) / (MAX_TEMP - MIN_TEMP);
}

// Liquid height as a CSS percentage of the scale; the stylesheet maps it onto the tube.
function temperatureToLiquidHeight(temperature) {
  return `${(normalizeTemperature(temperature) * 100).toFixed(2)}%`;
}

function mixColors(from, to, amount) {
  return from.map((channel, i) => channel + (to[i] - channel) * amount);
}

function toRgbString(rgb) {
  return `rgb(${rgb.map(Math.round).join(', ')})`;
}

function temperatureToColor(temperature) {
  const value = clampTemperature(temperature);
  for (let i = 1; i < COLOR_STOPS.length; i += 1) {
    const upper = COLOR_STOPS[i];
    if (value <= upper.temp) {
      const lower = COLOR_STOPS[i - 1];
      const ratio = (value - lower.temp) / (upper.temp - lower.temp);
      return mixColors(lower.rgb, upper.rgb, ratio);
    }
  }
  return COLOR_STOPS[COLOR_STOPS.length - 1].rgb.slice();
}

function temperatureToStatus(temperature) {
  return STATUS_LEVELS.find((level) => temperature < level.below).label;
}

function formatValue(celsius, digits = 1) {
  const value = UNITS[state.unit].fromCelsius(celsius);
  const text = (Math.abs(value) < 0.5 * 10 ** -digits ? 0 : value).toFixed(digits);
  return text.replace('-', '−');
}

function formatTemperature(celsius, digits = 1) {
  return `${formatValue(celsius, digits)}${UNITS[state.unit].symbol}`;
}

/* ==========================================================================
   Rendering (every write is skipped when nothing changed)
   ========================================================================== */

const textCache = new WeakMap();
const rendered = { level: '', paletteKey: '', valueText: '' };

function setText(node, text) {
  if (textCache.get(node) === text) return;
  textCache.set(node, text);
  node.textContent = text;
}

function applyPalette(rgb) {
  const key = rgb.map(Math.round).join(', ');
  if (key === rendered.paletteKey) return;
  rendered.paletteKey = key;

  const style = dom.root.style;
  style.setProperty('--rgb', key);
  style.setProperty('--liquid', toRgbString(rgb));
  style.setProperty('--liquid-light', toRgbString(mixColors(rgb, WHITE, 0.5)));
  style.setProperty('--liquid-dark', toRgbString(mixColors(rgb, BLACK, 0.45)));
  style.setProperty('--liquid-text', toRgbString(mixColors(rgb, WHITE, 0.42)));
}

function updateThermometer() {
  const temperature = state.temperature;

  const level = temperatureToLiquidHeight(temperature);
  if (level !== rendered.level) {
    rendered.level = level;
    dom.thermo.style.setProperty('--level', level);
    dom.thermo.style.setProperty('--glow-strength', (0.35 + 0.5 * normalizeTemperature(temperature)).toFixed(3));
  }

  applyPalette(temperatureToColor(temperature));

  setText(dom.number, formatValue(temperature));
  setText(dom.unit, UNITS[state.unit].symbol);
  setText(dom.markerValue, formatTemperature(temperature));
  setText(dom.status, temperatureToStatus(temperature));
}

function renderSlider() {
  const shown = state.mode === 'manual' ? state.target : state.temperature;
  const sliderValue = Math.round(shown / SLIDER_STEP) * SLIDER_STEP;
  if (Number(dom.slider.value) !== sliderValue) dom.slider.value = sliderValue;

  const text = formatTemperature(shown);
  setText(dom.sliderOutput, text);

  const valueText = `${text}, ${temperatureToStatus(shown)}`;
  if (valueText !== rendered.valueText) {
    rendered.valueText = valueText;
    dom.slider.setAttribute('aria-valuetext', valueText);
  }
}

function renderStepButtons() {
  const isManual = state.mode === 'manual';
  dom.decrease.disabled = !isManual || state.target <= MIN_TEMP;
  dom.increase.disabled = !isManual || state.target >= MAX_TEMP;
}

function renderSegmented(group, attribute, active) {
  group.querySelectorAll('button').forEach((button, index) => {
    const isActive = button.dataset[attribute] === active;
    button.setAttribute('aria-pressed', String(isActive));
    if (isActive) {
      group.dataset.index = String(index);
      group.style.setProperty('--index', index);
    }
  });
}

function liveHint() {
  if (live.phase === 'error') {
    return 'Couldn’t reach the weather service. Check your connection, then tap Live to try again.';
  }
  if (live.phase === 'settled') {
    const time = live.updatedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `Live temperature in ${LOCATION.name}, updated ${time}. Refreshes every 10 minutes.`;
  }
  return `Reading the live temperature for ${LOCATION.name}…`;
}

function renderModeUi() {
  const hints = {
    live: liveHint,
    auto: () => 'Auto is sweeping the full range. Switch to Manual to take control.',
    manual: () => 'Drag the slider, or use − and + (hold to repeat) to set the temperature.',
  };
  dom.app.dataset.activeMode = state.mode;
  dom.slider.disabled = state.mode !== 'manual';
  renderSegmented(dom.modeSwitch, 'mode', state.mode);
  setText(dom.modeHint, hints[state.mode]());
  setText(dom.readoutLabel, state.mode === 'live' ? `Live · ${LOCATION.name}` : 'Current temperature');
}

function renderUnitUi() {
  renderSegmented(dom.unitSwitch, 'unit', state.unit);
  setText(dom.scaleUnit, UNITS[state.unit].symbol);
  setText(dom.limitMin, formatTemperature(MIN_TEMP, 0));
  setText(dom.limitMax, formatTemperature(MAX_TEMP, 0));
}

/* ==========================================================================
   Scale and slider track (built once, rebuilt when the unit changes)
   ========================================================================== */

function createTick(value, isMajor) {
  const tick = document.createElement('li');
  tick.className = isMajor ? 'tick tick-major' : 'tick';
  tick.style.setProperty('--p', `${(normalizeTemperature(UNITS[state.unit].toCelsius(value)) * 100).toFixed(3)}%`);

  if (isMajor) {
    const label = document.createElement('span');
    label.className = 'tick-label';
    label.textContent = String(value).replace('-', '−');
    tick.append(label);
  }

  const line = document.createElement('i');
  line.className = 'tick-line';
  tick.append(line);
  return tick;
}

function buildScale() {
  const unit = UNITS[state.unit];
  const lowest = unit.fromCelsius(MIN_TEMP);
  const highest = unit.fromCelsius(MAX_TEMP);
  const first = Math.ceil(lowest / unit.minorTick - 1e-9) * unit.minorTick;

  const fragment = document.createDocumentFragment();
  for (let value = first; value <= highest + 1e-9; value += unit.minorTick) {
    fragment.append(createTick(value, value % unit.majorTick === 0));
  }
  dom.scale.replaceChildren(fragment);
}

function buildTrackGradient() {
  const stops = COLOR_STOPS.map(
    ({ temp, rgb }) => `${toRgbString(rgb)} ${(normalizeTemperature(temp) * 100).toFixed(1)}%`
  );
  dom.root.style.setProperty('--track-gradient', `linear-gradient(90deg, ${stops.join(', ')})`);
}

/* ==========================================================================
   Animation loop (runs only while something is moving)
   ========================================================================== */

function advanceAuto(seconds) {
  let next = state.temperature + state.direction * AUTO_SPEED * seconds;
  if (next >= MAX_TEMP) {
    next = MAX_TEMP;
    state.direction = -1;
  } else if (next <= MIN_TEMP) {
    next = MIN_TEMP;
    state.direction = 1;
  }
  state.temperature = next;
}

function easeTowardTarget(seconds) {
  const distance = state.target - state.temperature;
  if (Math.abs(distance) < SNAP_DISTANCE || prefersReducedMotion.matches) {
    state.temperature = state.target;
    return;
  }
  state.temperature += distance * (1 - Math.exp(-MANUAL_EASING * seconds));
}

function frame(now) {
  const seconds = Math.min(Math.max((now - lastFrameTime) / 1000, 0), MAX_FRAME_SECONDS);
  lastFrameTime = now;

  if (state.mode === 'auto') advanceAuto(seconds);
  else if (isLiveSweeping()) advanceLive(seconds);
  else easeTowardTarget(seconds);

  if (state.mode !== 'manual') renderSlider();
  updateThermometer();

  const keepRunning = state.mode === 'auto' || isLiveSweeping() || state.temperature !== state.target;
  frameId = keepRunning ? requestAnimationFrame(frame) : null;
}

function requestFrame() {
  if (frameId !== null) return;
  lastFrameTime = performance.now();
  frameId = requestAnimationFrame(frame);
}

/* ==========================================================================
   Modes
   ========================================================================== */

function enterMode(mode) {
  cancelLive();
  stopStepRepeat();
  state.mode = mode;
  state.target = state.temperature;  // freeze exactly where the previous mode stopped
}

function renderAfterModeChange() {
  renderModeUi();
  renderStepButtons();
  renderSlider();
  requestFrame();
}

function startAutoMode() {
  enterMode('auto');                 // continues from the temperature currently shown
  renderAfterModeChange();
}

function startManualMode() {
  enterMode('manual');
  renderAfterModeChange();
}

const MODE_STARTERS = { live: startLiveMode, auto: startAutoMode, manual: startManualMode };

function setMode(mode) {
  // Tapping Live again replays the sweep and re-reads the temperature (also acts as "retry").
  if (mode === state.mode && mode !== 'live') return;
  MODE_STARTERS[mode]();
}

/* ==========================================================================
   Live mode: sweep up/down a few times, then settle on the real temperature
   ========================================================================== */

function easeInOut(t) {
  return t * t * (3 - 2 * t);
}

function isLiveSweeping() {
  return state.mode === 'live' && live.phase === 'sweep';
}

function startSegment(to, duration, isFinal = false) {
  live.segment = { from: state.temperature, to, duration, elapsed: 0, isFinal };
}

function finishLive() {
  live.phase = 'settled';
  state.temperature = live.real;
  state.target = live.real;
  scheduleLiveRefresh();
  renderModeUi();
}

function advanceLive(seconds) {
  const segment = live.segment;
  segment.elapsed += seconds;
  const progress = Math.min(segment.elapsed / segment.duration, 1);
  state.temperature = segment.from + (segment.to - segment.from) * easeInOut(progress);
  if (progress < 1) return;

  if (segment.isFinal) {
    finishLive();
  } else if (live.queue.length) {
    startSegment(live.queue.shift(), LIVE_SEGMENT_SECONDS);
  } else if (live.real !== null) {
    startSegment(live.real, LIVE_SETTLE_SECONDS, true);
  } else if (live.failed) {
    live.phase = 'error';
    state.target = state.temperature;
    renderModeUi();
  } else {
    // Still waiting for the network: keep a gentle swing going.
    live.swingHigh = !live.swingHigh;
    startSegment(sweepTemperature(live.swingHigh ? 0.6 : 0.35), LIVE_SEGMENT_SECONDS);
  }
}

function sweepTemperature(fraction) {
  return MIN_TEMP + fraction * (MAX_TEMP - MIN_TEMP);
}

async function fetchLiveTemperature(signal) {
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${LOCATION.latitude}&longitude=${LOCATION.longitude}&current=temperature_2m&timezone=auto`;
  const response = await fetch(url, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`Weather service returned ${response.status}`);
  const celsius = (await response.json())?.current?.temperature_2m;
  if (typeof celsius !== 'number' || Number.isNaN(celsius)) throw new Error('Unexpected weather response');
  return clampTemperature(celsius);
}

async function loadLiveTemperature() {
  const requestId = live.requestId;
  const controller = new AbortController();
  live.controller = controller;
  const timeout = window.setTimeout(() => controller.abort(), LIVE_TIMEOUT_MS);

  try {
    const celsius = await fetchLiveTemperature(controller.signal);
    if (requestId === live.requestId) onLiveReading(celsius);
  } catch {
    if (requestId === live.requestId) onLiveFailure();
  } finally {
    window.clearTimeout(timeout);
  }
}

function onLiveReading(celsius) {
  live.real = celsius;
  live.failed = false;
  live.updatedAt = new Date();

  if (live.phase === 'sweep') return;   // the sweep picks the reading up when it ends

  // Reduced motion (no sweep) or a periodic refresh: glide straight to the new value.
  live.phase = 'settled';
  state.target = celsius;
  scheduleLiveRefresh();
  renderModeUi();
  requestFrame();
}

function onLiveFailure() {
  live.failed = true;
  if (live.phase === 'settled') {
    scheduleLiveRefresh();              // keep showing the last reading, try again later
  } else if (live.phase === 'loading') {
    live.phase = 'error';
    renderModeUi();
  }
}

function scheduleLiveRefresh() {
  window.clearTimeout(live.refreshTimer);
  live.refreshTimer = window.setTimeout(loadLiveTemperature, LIVE_REFRESH_MS);
}

function cancelLive() {
  live.requestId += 1;                  // any in-flight response is now stale
  if (live.controller) live.controller.abort();
  window.clearTimeout(live.refreshTimer);
  live.phase = 'idle';
  live.segment = null;
}

function startLiveMode() {
  enterMode('live');
  live.real = null;
  live.failed = false;

  if (prefersReducedMotion.matches) {
    live.phase = 'loading';
  } else {
    live.phase = 'sweep';
    live.queue = LIVE_SWEEP_FRACTIONS.map(sweepTemperature);
    startSegment(live.queue.shift(), LIVE_SEGMENT_SECONDS);
  }

  renderAfterModeChange();
  loadLiveTemperature();
}

/* ==========================================================================
   Manual controls
   ========================================================================== */

function setTarget(celsius) {
  state.target = clampTemperature(celsius);
  renderSlider();
  renderStepButtons();
  requestFrame();
}

// Moves to the next step boundary of the current unit (0.5 °C or 1 °F).
// Returns false when nothing changed (wrong mode, or already at a limit).
function nudgeTemperature(direction) {
  if (state.mode !== 'manual') return false;

  const unit = UNITS[state.unit];
  const position = unit.fromCelsius(state.target) / unit.buttonStep;
  const snapped = direction > 0 ? Math.floor(position + 1e-6) + 1 : Math.ceil(position - 1e-6) - 1;
  const next = clampTemperature(unit.toCelsius(snapped * unit.buttonStep));
  if (next === state.target) return false;

  setTarget(next);
  return true;
}

let repeatTimer = null;

function startStepRepeat(direction) {
  stopStepRepeat();
  if (!nudgeTemperature(direction)) return;

  const repeat = () => {
    if (!nudgeTemperature(direction)) {
      stopStepRepeat();
      return;
    }
    repeatTimer = window.setTimeout(repeat, REPEAT_INTERVAL);
  };
  repeatTimer = window.setTimeout(repeat, REPEAT_DELAY);
}

function stopStepRepeat() {
  window.clearTimeout(repeatTimer);
  repeatTimer = null;
}

/* ==========================================================================
   Units
   ========================================================================== */

function setUnit(unit) {
  if (unit === state.unit) return;
  state.unit = unit;   // the physical temperature is untouched; only its display changes
  renderUnitUi();
  buildScale();
  updateThermometer();
  renderSlider();
}

/* ==========================================================================
   Events
   ========================================================================== */

function onSegmentClick(attribute, handler) {
  return (event) => {
    const button = event.target.closest('button');
    if (button) handler(button.dataset[attribute]);
  };
}

function bindStepButton(button, direction) {
  // Pointer: act on press so holding can repeat.
  button.addEventListener('pointerdown', (event) => {
    if (event.button === 0) startStepRepeat(direction);
  });
  // Keyboard / assistive tech activation arrives as a click with detail === 0.
  button.addEventListener('click', (event) => {
    if (event.detail === 0) nudgeTemperature(direction);
  });
}

function bindEvents() {
  dom.modeSwitch.addEventListener('click', onSegmentClick('mode', setMode));
  dom.unitSwitch.addEventListener('click', onSegmentClick('unit', setUnit));

  dom.slider.addEventListener('input', () => setTarget(Number(dom.slider.value)));

  bindStepButton(dom.decrease, -1);
  bindStepButton(dom.increase, 1);
  window.addEventListener('pointerup', stopStepRepeat);
  window.addEventListener('pointercancel', stopStepRepeat);
  window.addEventListener('blur', stopStepRepeat);
}

/* ==========================================================================
   Initialisation
   ========================================================================== */

function init() {
  buildTrackGradient();
  buildScale();
  renderUnitUi();
  renderModeUi();
  renderSlider();
  renderStepButtons();
  updateThermometer();
  bindEvents();

  startLiveMode();
}

init();
