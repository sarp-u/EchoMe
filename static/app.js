/* EchoMe — front-end */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const PREFS_KEY = 'echome.prefs.v1';
const MAX_TEXT = 6000;
const MAX_REF_BYTES = 30 * 1024 * 1024;
const ALLOWED_REF_EXTS = ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'aiff', 'aif', 'webm'];

const ICONS = {
  play: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8.5 5.6v12.8a1 1 0 0 0 1.5.87l10-6.4a1 1 0 0 0 0-1.74l-10-6.4a1 1 0 0 0-1.5.87Z" fill="currentColor"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5M5 19h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4.5 7h15M9.5 7V5.2c0-.7.5-1.2 1.2-1.2h2.6c.7 0 1.2.5 1.2 1.2V7M7 7l.9 11.1c.1.9.8 1.6 1.7 1.6h4.8c.9 0 1.6-.7 1.7-1.6L17 7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const el = {
  text: $('#text'),
  charCount: $('#charCount'),
  clearText: $('#clearText'),
  langButtons: $$('.segmented button[data-lang]'),
  pauseButtons: $$('.segmented button[data-pause]'),
  dropzone: $('#dropzone'),
  refInput: $('#refInput'),
  dropEmpty: $('#dropEmpty'),
  dropFilled: $('#dropFilled'),
  refName: $('#refName'),
  refMeta: $('#refMeta'),
  refPlay: $('#refPlay'),
  refRemove: $('#refRemove'),
  exRange: $('#exRange'),
  exNum: $('#exNum'),
  cfgRange: $('#cfgRange'),
  cfgNum: $('#cfgNum'),
  tempRange: $('#tempRange'),
  tempNum: $('#tempNum'),
  expressivePreset: $('#expressivePreset'),
  generateBtn: $('#generateBtn'),
  generateLabel: $('#generateLabel'),
  cancelBtn: $('#cancelBtn'),
  progressWrap: $('#progressWrap'),
  progressStage: $('#progressStage'),
  progressTime: $('#progressTime'),
  modelPill: $('#modelPill'),
  modelText: $('#modelText'),
  devicePill: $('#devicePill'),
  modelError: $('#modelError'),
  modelErrorText: $('#modelErrorText'),
  playerEmpty: $('#playerEmpty'),
  player: $('#player'),
  playerTitle: $('#playerTitle'),
  playerChips: $('#playerChips'),
  playBtn: $('#playBtn'),
  viz: $('#viz'),
  seek: $('#seek'),
  curTime: $('#curTime'),
  durTime: $('#durTime'),
  downloadBtn: $('#downloadBtn'),
  openBtn: $('#openBtn'),
  historyList: $('#historyList'),
  historyEmpty: $('#historyEmpty'),
  histCount: $('#histCount'),
  toasts: $('#toasts'),
};

const state = {
  status: 'loading',
  wasLoading: false,
  lang: 'tr',
  pause: 'marked',
  reference: null,
  refUrl: null,
  refAudio: null,
  busy: false,
  jobId: null,
  progressLabel: 'Üretiliyor',
  elapsed: 0,
  elapsedTimer: null,
  clip: null,
  audio: null,
  audioUrl: null,
  audioBuffer: null,
  peaks: [],
  bars: 110,
  loadToken: 0,
  seeking: false,
  raf: 0,
  statusTimer: null,
  history: [],
};

const audioCtx = { ctx: null };

/* ------------------------------------------------------------------ utils */

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const parseDecimal = (value) => parseFloat(String(value).replace(',', '.'));

function fmtTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtElapsed(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total} sn`;
  return `${Math.floor(total / 60)} dk ${String(total % 60).padStart(2, '0')} sn`;
}

function fmtBytes(bytes) {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = (Date.now() - then) / 1000;
  if (diff < 45) return 'az önce';
  if (diff < 3600) return `${Math.max(1, Math.round(diff / 60))} dk önce`;
  if (diff < 86400) return `${Math.round(diff / 3600)} sa önce`;
  if (diff < 172800) return 'dün';
  return new Date(iso).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
}

function detailMessage(payload) {
  if (!payload) return null;
  if (typeof payload.detail === 'string') return payload.detail;
  if (Array.isArray(payload.detail)) {
    return payload.detail.map((item) => item.msg || '').filter(Boolean).join(' ');
  }
  return null;
}

function cleanServerError(message) {
  if (!message) return 'Üretim sırasında bilinmeyen bir hata oluştu.';
  return String(message).replace(/^[A-Za-z_.]*Error:\s*/, '').slice(0, 320);
}

function toast(message, type = 'success', timeout = 4600) {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  el.toasts.appendChild(node);
  const remove = () => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 220);
  };
  node.addEventListener('click', remove);
  setTimeout(remove, timeout);
}

function setRangeFill(input) {
  const min = parseFloat(input.min) || 0;
  const max = parseFloat(input.max) || 100;
  const value = parseFloat(input.value) || 0;
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--p', `${clamp(pct, 0, 100).toFixed(2)}%`);
}

/* -------------------------------------------------------------- preferences */

function savePrefs() {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        lang: state.lang,
        pause: state.pause,
        ex: el.exRange.value,
        cfg: el.cfgRange.value,
        temp: el.tempRange.value,
      }),
    );
  } catch {
    /* ignore */
  }
}

function loadPrefs() {
  let prefs = {};
  try {
    prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
  } catch {
    prefs = {};
  }

  if (prefs.lang === 'tr' || prefs.lang === 'en') setLang(prefs.lang, false);
  if (prefs.pause === 'natural' || prefs.pause === 'marked' || prefs.pause === 'strong') {
    setPause(prefs.pause, false);
  }

  const apply = (range, number, raw) => {
    let value = parseDecimal(raw);
    if (!Number.isFinite(value)) return;
    value = clamp(value, parseFloat(range.min), parseFloat(range.max));
    value = Math.round(value * 100) / 100;
    range.value = value.toFixed(2);
    number.value = value.toFixed(2);
    setRangeFill(range);
  };

  apply(el.exRange, el.exNum, prefs.ex);
  apply(el.cfgRange, el.cfgNum, prefs.cfg);
  apply(el.tempRange, el.tempNum, prefs.temp);
}

function setLang(lang, persist = true) {
  state.lang = lang;
  el.langButtons.forEach((button) => {
    const active = button.dataset.lang === lang;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (persist) savePrefs();
}

function setPause(pause, persist = true) {
  state.pause = pause;
  el.pauseButtons.forEach((button) => {
    const active = button.dataset.pause === pause;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (persist) savePrefs();
}

function setSliderValue(range, number, value) {
  const next = clamp(value, parseFloat(range.min), parseFloat(range.max));
  range.value = next.toFixed(2);
  number.value = next.toFixed(2);
  setRangeFill(range);
}

function applyExpressivePreset() {
  setSliderValue(el.exRange, el.exNum, 0.8);
  setSliderValue(el.cfgRange, el.cfgNum, 0.35);
  setSliderValue(el.tempRange, el.tempNum, 0.9);
  setPause('marked');
  savePrefs();
  toast('İfadeli ayarlar uygulandı: exaggeration 0.80 · CFG 0.35 · temperature 0.90');
}

/* ------------------------------------------------------------------ sliders */

function bindSlider(range, number) {
  const min = parseFloat(range.min);
  const max = parseFloat(range.max);

  const commit = (value, updateNumber = true) => {
    let next = parseDecimal(value);
    if (!Number.isFinite(next)) next = parseFloat(range.value);
    next = clamp(Math.round(next * 100) / 100, min, max);
    range.value = next.toFixed(2);
    if (updateNumber) number.value = next.toFixed(2);
    setRangeFill(range);
    savePrefs();
  };

  range.addEventListener('input', () => commit(range.value));
  number.addEventListener('input', () => {
    const value = parseDecimal(number.value);
    if (Number.isFinite(value) && value >= min && value <= max) {
      range.value = String(value);
      setRangeFill(range);
    }
  });
  number.addEventListener('change', () => commit(number.value));
  number.addEventListener('blur', () => {
    commit(number.value);
    number.value = parseFloat(range.value).toFixed(2);
  });
  number.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      number.blur();
    }
  });

  setRangeFill(range);
}

/* ---------------------------------------------------------------- reference */

function formatRefDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return `${seconds.toFixed(1).replace('.', ',')} sn`;
}

function clearReference() {
  if (state.refAudio) {
    state.refAudio.pause();
    state.refAudio = null;
  }
  if (state.refUrl) {
    URL.revokeObjectURL(state.refUrl);
    state.refUrl = null;
  }
  state.reference = null;
  el.refInput.value = '';
  el.dropzone.classList.remove('has-file');
  el.dropFilled.hidden = true;
  el.dropEmpty.hidden = false;
  el.refPlay.querySelector('.i-play').hidden = false;
  el.refPlay.querySelector('.i-stop').hidden = true;
  el.refPlay.setAttribute('aria-label', 'Referansı dinle');
}

function setReference(file) {
  if (!file) return;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (!ALLOWED_REF_EXTS.includes(ext)) {
    toast('Desteklenmeyen dosya türü. WAV, MP3, FLAC, OGG veya M4A seçin.', 'error');
    return;
  }
  if (file.size > MAX_REF_BYTES) {
    toast('Ses dosyası çok büyük. En fazla 30 MB olmalı.', 'error');
    return;
  }

  if (state.refAudio) state.refAudio.pause();
  if (state.refUrl) URL.revokeObjectURL(state.refUrl);

  state.reference = file;
  state.refUrl = URL.createObjectURL(file);
  state.refAudio = new Audio(state.refUrl);
  state.refAudio.addEventListener('ended', () => setRefPlaying(false));

  el.refName.textContent = file.name;
  el.refMeta.textContent = `${fmtBytes(file.size)} · süre okunuyor…`;
  el.dropzone.classList.add('has-file');
  el.dropFilled.hidden = false;
  el.dropEmpty.hidden = true;

  state.refAudio.addEventListener(
    'loadedmetadata',
    () => {
      const duration = formatRefDuration(state.refAudio.duration);
      el.refMeta.textContent = [`${fmtBytes(file.size)}`, duration].filter(Boolean).join(' · ');
    },
    { once: true },
  );
  state.refAudio.load();
}

function setRefPlaying(playing) {
  el.refPlay.querySelector('.i-play').hidden = playing;
  el.refPlay.querySelector('.i-stop').hidden = !playing;
  el.refPlay.setAttribute('aria-label', playing ? 'Referansı durdur' : 'Referansı dinle');
}

function toggleRefPlayback() {
  if (!state.refAudio) return;
  if (state.refAudio.paused) {
    state.refAudio
      .play()
      .then(() => setRefPlaying(true))
      .catch(() => toast('Referans ses oynatılamadı.', 'error'));
  } else {
    state.refAudio.pause();
    setRefPlaying(false);
  }
}

/* ------------------------------------------------------------------- status */

function scheduleStatusPoll(delay) {
  clearTimeout(state.statusTimer);
  state.statusTimer = setTimeout(loadStatus, delay);
}

function syncGenerateButton() {
  const modelLoading = state.status !== 'ready';
  el.generateBtn.disabled = state.busy || modelLoading;
  if (state.busy) {
    el.generateLabel.textContent = state.progressLabel;
  } else if (modelLoading) {
    el.generateLabel.textContent = state.status === 'error' ? 'Model yüklenemedi' : 'Model yükleniyor…';
  } else {
    el.generateLabel.textContent = 'Ses üret';
  }
}

function applyStatus(data) {
  const previous = state.status;
  state.status = data.status;
  el.devicePill.textContent = data.device ? data.device.toUpperCase() : '—';
  el.devicePill.title = data.sample_rate
    ? `${data.device ? data.device.toUpperCase() : '—'} · ${data.sample_rate} Hz`
    : 'Hesaplama birimi';

  if (data.status === 'ready') {
    el.modelPill.dataset.state = 'ready';
    el.modelText.textContent = 'Model hazır';
    el.modelError.hidden = true;
    if (previous === 'loading') toast('Model hazır. Üretime başlayabilirsin.', 'success');
  } else if (data.status === 'error') {
    el.modelPill.dataset.state = 'error';
    el.modelText.textContent = 'Model hatası';
    el.modelError.hidden = false;
    el.modelErrorText.textContent = data.error || 'Ayrıntı için terminal çıktısına bakın.';
  } else {
    el.modelPill.dataset.state = 'loading';
    el.modelText.textContent = 'Model yükleniyor';
    el.modelError.hidden = true;
  }

  syncGenerateButton();
  if (data.status !== 'ready' && data.status !== 'error') scheduleStatusPoll(1500);
}

async function loadStatus() {
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    applyStatus(await response.json());
  } catch {
    state.status = 'error';
    el.modelPill.dataset.state = 'error';
    el.modelText.textContent = 'Sunucuya ulaşılamıyor';
    el.modelError.hidden = false;
    el.modelErrorText.textContent = 'Yerel sunucu yanıt vermiyor. Terminalde çalışıp çalışmadığını kontrol edin.';
    syncGenerateButton();
    scheduleStatusPoll(3000);
  }
}

/* ---------------------------------------------------------------- progress */

function startElapsedTimer() {
  clearInterval(state.elapsedTimer);
  state.elapsed = 0;
  state.elapsedTimer = setInterval(() => {
    if (!state.busy) return;
    state.elapsed += 1;
    el.progressTime.textContent = fmtElapsed(state.elapsed);
  }, 1000);
}

function stopElapsedTimer() {
  clearInterval(state.elapsedTimer);
  state.elapsedTimer = null;
}

function resetProgress() {
  el.progressTime.textContent = '0 sn';
  el.progressStage.textContent = 'Hazırlanıyor…';
  state.elapsed = 0;
  state.progressLabel = 'Üretiliyor';
}

function setBusy(busy) {
  state.busy = busy;
  el.generateBtn.classList.toggle('is-busy', busy);
  el.cancelBtn.hidden = !busy;
  el.progressWrap.hidden = !busy;
  if (busy) {
    el.cancelBtn.disabled = false;
    el.cancelBtn.textContent = 'İptal';
    startElapsedTimer();
  } else {
    state.jobId = null;
    stopElapsedTimer();
  }
  syncGenerateButton();
}

function renderProgress(job) {
  state.elapsed = Math.max(state.elapsed, Number(job.elapsed) || 0);
  el.progressStage.textContent = job.stage || 'İşleniyor…';
  el.progressTime.textContent = fmtElapsed(state.elapsed);
  state.progressLabel = 'Üretiliyor…';
  if (!el.generateBtn.classList.contains('is-busy')) el.generateBtn.classList.add('is-busy');
  syncGenerateButton();
}

/* ---------------------------------------------------------------- generator */

async function generate() {
  if (state.busy) return;
  if (state.status !== 'ready') {
    toast(
      state.status === 'loading' ? 'Model hâlâ yükleniyor, birazdan tekrar dene.' : 'Model hazır değil.',
      'info',
    );
    return;
  }

  const text = el.text.value.trim();
  if (!text) {
    toast('Önce bir konuşma metni gir.', 'error');
    el.text.focus();
    return;
  }
  if (text.length > MAX_TEXT) {
    toast(`Metin en fazla ${MAX_TEXT} karakter olabilir.`, 'error');
    return;
  }

  const form = new FormData();
  form.append('text', text);
  form.append('language_id', state.lang);
  form.append('exaggeration', parseFloat(el.exRange.value).toFixed(2));
  form.append('cfg_weight', parseFloat(el.cfgRange.value).toFixed(2));
  form.append('temperature', parseFloat(el.tempRange.value).toFixed(2));
  form.append('pause_style', state.pause);
  if (state.reference) form.append('reference', state.reference, state.reference.name);

  resetProgress();
  el.progressStage.textContent = state.reference ? 'Ses dosyası hazırlanıyor…' : 'İş oluşturuluyor…';
  setBusy(true);
  state.progressLabel = 'Üretiliyor…';
  syncGenerateButton();

  try {
    const response = await fetch('/api/jobs', { method: 'POST', body: form });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(detailMessage(payload) || `Sunucu hatası (${response.status})`);
    }
    state.jobId = payload.job_id;
    await pollJob(payload.job_id);
  } catch (error) {
    toast(error.message || 'Üretim başlatılamadı.', 'error', 7000);
    setBusy(false);
  }
}

async function pollJob(jobId) {
  let failures = 0;

  for (;;) {
    await sleep(900);

    let job;
    try {
      const response = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('status');
      job = await response.json();
      failures = 0;
    } catch {
      failures += 1;
      if (failures >= 6) {
        toast('Sunucu bağlantısı koptu. Terminal çıktısını kontrol et.', 'error');
        setBusy(false);
        return;
      }
      continue;
    }

    renderProgress(job);

    if (job.status === 'done' && job.result) {
      setBusy(false);
      await loadClip(job.result);
      await loadHistory();
      toast('Ses hazır. Dinleyebilir veya WAV olarak indirebilirsin.', 'success');
      return;
    }

    if (job.status === 'error') {
      setBusy(false);
      toast(cleanServerError(job.error), 'error', 9000);
      return;
    }

    if (job.status === 'cancelled') {
      setBusy(false);
      toast('Üretim iptal edildi.', 'info');
      return;
    }
  }
}

async function cancelJob() {
  if (!state.busy || !state.jobId) return;
  el.cancelBtn.disabled = true;
  el.cancelBtn.textContent = 'İptal ediliyor…';
  try {
    await fetch(`/api/jobs/${state.jobId}/cancel`, { method: 'POST' });
    toast('İş, mevcut segment tamamlanınca durdurulacak.', 'info');
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------- player */

function ensureAudioContext() {
  if (!audioCtx.ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx.ctx = new Ctx();
  }
  return audioCtx.ctx;
}

function computePeaks(samples, count) {
  const peaks = new Array(count).fill(0.04);
  if (!samples || !samples.length) return peaks;
  const block = Math.max(1, Math.floor(samples.length / count));
  for (let i = 0; i < count; i += 1) {
    const start = i * block;
    const end = Math.min(samples.length, start + block);
    let peak = 0;
    for (let j = start; j < end; j += 2) {
      const abs = Math.abs(samples[j]);
      if (abs > peak) peak = abs;
    }
    peaks[i] = peak;
  }
  const max = Math.max(...peaks, 0.0001);
  return peaks.map((peak) => Math.max(0.035, Math.pow(peak / max, 0.72)));
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawViz(timeOverride) {
  const canvas = el.viz;
  if (!canvas) return;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const peaks = state.peaks;
  if (!peaks.length) return;

  const count = peaks.length;
  const gap = count > 90 ? 2 : 3;
  const barWidth = Math.max(1.5, (width - gap * (count - 1)) / count);
  const mid = height / 2;

  const duration =
    state.audio && Number.isFinite(state.audio.duration) && state.audio.duration > 0
      ? state.audio.duration
      : Number(state.clip?.duration) || 1;
  const time = timeOverride != null ? timeOverride : state.audio?.currentTime || 0;
  const ratio = clamp(time / duration, 0, 1);

  const gradient = ctx.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, '#ff7a59');
  gradient.addColorStop(0.55, '#ffb35f');
  gradient.addColorStop(1, '#ffd08a');

  for (let i = 0; i < count; i += 1) {
    const x = i * (barWidth + gap);
    const amplitude = peaks[i];
    const barHeight = Math.max(3, amplitude * (height - 18));
    const played = (i + 0.5) / count <= ratio;
    ctx.fillStyle = played ? gradient : 'rgba(255, 255, 255, 0.135)';
    roundRect(ctx, x, mid - barHeight / 2, barWidth, barHeight, Math.min(barWidth / 2, 2));
    ctx.fill();
  }

  const playhead = ratio * width;
  if (ratio > 0 && ratio < 1) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(playhead, 7);
    ctx.lineTo(playhead, height - 7);
    ctx.stroke();
    ctx.restore();
  }
}

function startVizLoop() {
  cancelAnimationFrame(state.raf);
  const tick = () => {
    drawViz();
    if (state.audio && !state.audio.paused) state.raf = requestAnimationFrame(tick);
  };
  state.raf = requestAnimationFrame(tick);
}

function updatePlayIcon() {
  const playing = Boolean(state.audio && !state.audio.paused);
  el.playBtn.querySelector('.i-play').hidden = playing;
  el.playBtn.querySelector('.i-pause').hidden = !playing;
  el.playBtn.setAttribute('aria-label', playing ? 'Duraklat' : 'Oynat');
}

function updateTimeUI() {
  if (!state.audio) return;
  const duration = Number(state.audio.duration) || Number(state.clip?.duration) || 0;
  const current = state.audio.currentTime || 0;
  el.curTime.textContent = fmtTime(current);
  el.durTime.textContent = fmtTime(duration);
  if (!state.seeking) {
    const value = duration > 0 ? Math.round((current / duration) * 1000) : 0;
    el.seek.value = String(value);
    setRangeFill(el.seek);
  }
}

function disposeAudio() {
  cancelAnimationFrame(state.raf);
  if (state.audio) {
    state.audio.pause();
    state.audio.removeAttribute('src');
    state.audio.load();
    state.audio = null;
  }
  if (state.audioUrl) {
    URL.revokeObjectURL(state.audioUrl);
    state.audioUrl = null;
  }
  updatePlayIcon();
}

function resetPlayer() {
  disposeAudio();
  state.clip = null;
  state.audioBuffer = null;
  state.peaks = [];
  el.player.hidden = true;
  el.playerEmpty.hidden = false;
  el.playerTitle.textContent = '—';
  el.playerChips.textContent = '';
  el.downloadBtn.href = '#';
  el.openBtn.href = '#';
  el.curTime.textContent = '0:00';
  el.durTime.textContent = '0:00';
  el.seek.value = '0';
  setRangeFill(el.seek);
  highlightHistory();
}

function buildChips(clip) {
  el.playerChips.textContent = '';
  const add = (label, accent = false) => {
    const chip = document.createElement('span');
    chip.className = `chip${accent ? ' accent' : ''}`;
    chip.textContent = label;
    el.playerChips.appendChild(chip);
  };
  add(String(clip.language_name || clip.language || '').toUpperCase(), true);
  add(fmtTime(Number(clip.duration) || 0));
  add(`ex ${Number(clip.exaggeration ?? 0.5).toFixed(2)}`);
  add(`cfg ${Number(clip.cfg_weight ?? 0.5).toFixed(2)}`);
  if (clip.temperature != null) add(`temp ${Number(clip.temperature).toFixed(2)}`);
  if (clip.reference_duration) add('klon ses');
  if (clip.chunks > 1) add(`${clip.chunks} segment`);
}

async function loadClip(clip, autoplay = false) {
  if (!clip) return;
  const token = ++state.loadToken;
  state.clip = clip;

  el.playerEmpty.hidden = true;
  el.player.hidden = false;
  el.playerTitle.textContent = clip.text || 'Üretilen ses';
  buildChips(clip);
  el.downloadBtn.href = clip.download_url || '#';
  el.openBtn.href = clip.url || '#';
  el.durTime.textContent = fmtTime(Number(clip.duration) || 0);
  el.curTime.textContent = '0:00';
  el.seek.value = '0';
  setRangeFill(el.seek);
  el.playBtn.disabled = true;

  highlightHistory();

  try {
    const response = await fetch(clip.url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    if (token !== state.loadToken) return;

    const blob = new Blob([buffer], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);

    disposeAudio();
    state.audioUrl = url;

    const audio = new Audio(url);
    audio.preload = 'auto';
    state.audio = audio;

    audio.addEventListener('timeupdate', updateTimeUI);
    audio.addEventListener('loadedmetadata', updateTimeUI);
    audio.addEventListener('play', () => {
      updatePlayIcon();
      startVizLoop();
    });
    audio.addEventListener('pause', () => {
      updatePlayIcon();
      cancelAnimationFrame(state.raf);
      drawViz();
    });
    audio.addEventListener('ended', () => {
      updatePlayIcon();
      cancelAnimationFrame(state.raf);
      audio.currentTime = 0;
      updateTimeUI();
      drawViz(0);
    });

    el.playBtn.disabled = false;
    el.durTime.textContent = fmtTime(Number(clip.duration) || 0);

    // Decode a copy for the waveform.
    const ctx = ensureAudioContext();
    if (ctx) {
      try {
        const decoded = await ctx.decodeAudioData(buffer.slice(0));
        if (token !== state.loadToken) return;
        state.audioBuffer = decoded;
        state.peaks = computePeaks(decoded.getChannelData(0), state.bars);
        drawViz();
      } catch {
        state.peaks = new Array(state.bars).fill(0.12);
        drawViz();
      }
    }

    if (autoplay) {
      try {
        await audio.play();
      } catch {
        updatePlayIcon();
      }
    }
  } catch (error) {
    if (token === state.loadToken) {
      toast('Ses yüklenemedi. Kayıt silinmiş olabilir.', 'error');
    }
  }
}

async function togglePlayback() {
  if (!state.audio) return;
  if (state.audio.paused) {
    try {
      await state.audio.play();
    } catch {
      toast('Oynatma başlatılamadı. Tekrar dene.', 'error');
    }
  } else {
    state.audio.pause();
  }
}

/* ----------------------------------------------------------------- history */

function highlightHistory() {
  const activeId = state.clip?.id;
  $$('.hist-item', el.historyList).forEach((item) => {
    item.classList.toggle('active', item.dataset.id === activeId);
  });
}

function makeHistoryItem(item) {
  const li = document.createElement('li');
  li.className = 'hist-item';
  li.dataset.id = item.id;
  li.title = 'Dinlemek için tıkla';

  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'hist-play';
  play.innerHTML = ICONS.play;
  play.setAttribute('aria-label', 'Bu kaydı oynat');

  const copy = document.createElement('div');
  copy.className = 'hist-copy';
  const text = document.createElement('p');
  text.className = 'hist-text';
  text.textContent = item.text || '(metin yok)';
  const meta = document.createElement('div');
  meta.className = 'hist-meta';
  meta.textContent = [
    String(item.language_name || item.language || '').toUpperCase(),
    fmtTime(Number(item.duration) || 0),
    timeAgo(item.created_at),
  ].join(' · ');
  copy.append(text, meta);

  const actions = document.createElement('div');
  actions.className = 'hist-actions';

  const download = document.createElement('a');
  download.className = 'icon-btn';
  download.href = item.download_url || '#';
  download.title = 'WAV indir';
  download.setAttribute('aria-label', 'WAV indir');
  download.innerHTML = ICONS.download;
  download.addEventListener('click', (event) => event.stopPropagation());

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'icon-btn danger';
  del.innerHTML = ICONS.trash;
  del.title = 'Sil';
  del.setAttribute('aria-label', 'Kaydı sil');
  del.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (del.dataset.confirm !== '1') {
      del.dataset.confirm = '1';
      del.classList.add('confirming');
      del.innerHTML = ICONS.check;
      del.title = 'Silmek için tekrar tıkla';
      clearTimeout(del._timer);
      del._timer = setTimeout(() => {
        del.dataset.confirm = '';
        del.classList.remove('confirming');
        del.innerHTML = ICONS.trash;
        del.title = 'Sil';
      }, 3000);
      return;
    }
    clearTimeout(del._timer);
    try {
      const response = await fetch(`/api/outputs/${item.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error();
      if (state.clip?.id === item.id) resetPlayer();
      toast('Kayıt silindi.', 'info');
      await loadHistory();
    } catch {
      toast('Kayıt silinemedi.', 'error');
    }
  });

  actions.append(download, del);

  li.append(play, copy, actions);
  li.addEventListener('click', (event) => {
    if (event.target.closest('a, button')) return;
    if (state.clip?.id === item.id && state.audio) togglePlayback();
    else loadClip(item, true);
  });
  play.addEventListener('click', (event) => {
    event.stopPropagation();
    if (state.clip?.id === item.id && state.audio) togglePlayback();
    else loadClip(item, true);
  });

  return li;
}

function renderHistory() {
  el.historyList.textContent = '';
  el.histCount.textContent = String(state.history.length);
  el.historyEmpty.hidden = state.history.length > 0;
  state.history.forEach((item) => el.historyList.appendChild(makeHistoryItem(item)));
  highlightHistory();
}

async function loadHistory() {
  try {
    const response = await fetch('/api/outputs', { cache: 'no-store' });
    if (!response.ok) throw new Error();
    const payload = await response.json();
    state.history = Array.isArray(payload.items) ? payload.items : [];
    renderHistory();
    if (!state.clip && state.history.length) loadClip(state.history[0]);
  } catch {
    /* history is optional */
  }
}

/* -------------------------------------------------------------------- init */

function updateCharCount() {
  const length = el.text.value.length;
  el.charCount.textContent = `${length} / ${MAX_TEXT}`;
  el.charCount.classList.toggle('warn', length > MAX_TEXT - 400);
}

function resizeViz() {
  const width = el.viz.clientWidth;
  if (!width) return;
  const bars = clamp(Math.floor(width / 6), 56, 150);
  if (bars !== state.bars) {
    state.bars = bars;
    if (state.audioBuffer) {
      state.peaks = computePeaks(state.audioBuffer.getChannelData(0), bars);
    } else if (state.peaks.length) {
      state.peaks = new Array(bars).fill(0.12);
    }
  }
  drawViz();
}

function init() {
  bindSlider(el.exRange, el.exNum);
  bindSlider(el.cfgRange, el.cfgNum);
  bindSlider(el.tempRange, el.tempNum);
  loadPrefs();
  setRangeFill(el.seek);
  updateCharCount();

  // Language
  el.langButtons.forEach((button) => {
    button.addEventListener('click', () => setLang(button.dataset.lang));
  });

  // Pause profile
  el.pauseButtons.forEach((button) => {
    button.addEventListener('click', () => setPause(button.dataset.pause));
  });
  el.expressivePreset.addEventListener('click', applyExpressivePreset);

  // Text
  el.text.addEventListener('input', updateCharCount);
  el.text.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      generate();
    }
  });
  el.clearText.addEventListener('click', () => {
    el.text.value = '';
    updateCharCount();
    el.text.focus();
  });

  // Reference dropzone
  el.dropzone.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    el.refInput.click();
  });
  el.dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      el.refInput.click();
    }
  });
  el.refInput.addEventListener('change', () => {
    if (el.refInput.files && el.refInput.files[0]) setReference(el.refInput.files[0]);
  });
  ['dragenter', 'dragover'].forEach((type) => {
    el.dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      el.dropzone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((type) => {
    el.dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      el.dropzone.classList.remove('dragover');
    });
  });
  el.dropzone.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) setReference(file);
  });
  el.refPlay.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleRefPlayback();
  });
  el.refRemove.addEventListener('click', (event) => {
    event.stopPropagation();
    clearReference();
  });

  // Generate / cancel
  el.generateBtn.addEventListener('click', generate);
  el.cancelBtn.addEventListener('click', cancelJob);

  // Player
  el.playBtn.addEventListener('click', togglePlayback);
  el.seek.addEventListener('input', () => {
    if (!state.audio) return;
    state.seeking = true;
    const duration = Number(state.audio.duration) || Number(state.clip?.duration) || 0;
    const time = (Number(el.seek.value) / 1000) * duration;
    el.curTime.textContent = fmtTime(time);
    setRangeFill(el.seek);
    drawViz(time);
  });
  el.seek.addEventListener('change', () => {
    if (!state.audio) return;
    const duration = Number(state.audio.duration) || Number(state.clip?.duration) || 0;
    state.audio.currentTime = (Number(el.seek.value) / 1000) * duration;
    state.seeking = false;
    updateTimeUI();
    if (state.audio.paused) drawViz();
  });
  el.viz.addEventListener('click', (event) => {
    if (!state.audio) return;
    const duration = Number(state.audio.duration) || 0;
    if (!duration) return;
    const rect = el.viz.getBoundingClientRect();
    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    state.audio.currentTime = ratio * duration;
    updateTimeUI();
    drawViz();
    if (state.audio.paused) el.playBtn.focus();
  });

  // Keyboard shortcut hint
  const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
  const shortcut = $('.shortcut');
  if (shortcut && !isMac) shortcut.textContent = 'Ctrl ↵';

  // Global drag safety
  ['dragover', 'drop'].forEach((type) => {
    window.addEventListener(type, (event) => {
      if (!el.dropzone.contains(event.target)) event.preventDefault();
    });
  });

  // Canvas resize
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resizeViz, 120);
  });

  loadStatus();
  loadHistory();
}

init();
