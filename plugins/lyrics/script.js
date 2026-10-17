// plugins/lyrics/script.js

(function () {
  'use strict';

  // ============================================================
  // ЛОГИРОВАНИЕ
  // ============================================================
  const T0 = performance.now();
  function ts() {
    return ((performance.now() - T0) / 1000).toFixed(3) + 's';
  }
  function log(...args) {
    console.log('%c[lyrics ' + ts() + ']', 'color:#6cf', ...args);
  }
  function warn(...args) {
    console.warn('%c[lyrics ' + ts() + ']', 'color:#fc6', ...args);
  }
  function err(...args) {
    console.error('%c[lyrics ' + ts() + ']', 'color:#f66', ...args);
  }

  log('IIFE start');

  // ============================================================
  // DOM
  // ============================================================
  const bodyEl = document.getElementById('lyrics-body');
  if (!bodyEl) {
    err('не найден #lyrics-body');
    return;
  }
  log('DOM: #lyrics-body найден');

  // ============================================================
  // КНОПКА В ХЕДЕРЕ
  // ============================================================
  const headerSlot = document.getElementById('plugin-slot-header');
  let headerBtn = null;

  function createHeaderButton() {
    if (!headerSlot) {
      warn('слот header не найден — кнопка не будет создана');
      return;
    }
    if (headerBtn) {
      log('кнопка уже создана');
      return;
    }

    headerBtn = document.createElement('button');
    headerBtn.className = 'lyrics-header-btn';
    headerBtn.title = 'Текст песни';
    headerBtn.textContent = '🎤';
    headerBtn.addEventListener('click', toggleLyricsFocus);

    headerSlot.appendChild(headerBtn);
    log('кнопка в хедере создана');
  }

  function removeHeaderButton() {
    if (headerBtn && headerBtn.parentNode) {
      headerBtn.parentNode.removeChild(headerBtn);
      log('кнопка в хедере удалена');
    }
    headerBtn = null;
  }

  // ============================================================
  // ТОГГЛ ФОКУСА (через ядро)
  // ============================================================
  function toggleLyricsFocus() {
    if (window.WebPlayer && window.WebPlayer.toggleContentPlugin) {
      window.WebPlayer.toggleContentPlugin('lyrics');
    } else {
      warn('WebPlayer.toggleContentPlugin не найден');
    }
  }

  // Подсветка кнопки при смене активного плагина
  if (window.WebPlayer && window.WebPlayer.on) {
    window.WebPlayer.on('content:activeChanged', (data) => {
      if (!headerBtn) return;
      headerBtn.classList.toggle('active', data.activeId === 'lyrics');
    });
  }

  // ============================================================
  // СОСТОЯНИЕ
  // ============================================================
  let lines = [];
  let activeIndex = -1;
  let currentTrackPath = null;
  let lastKnownPath = undefined;
  let lineEls = [];
  let loadToken = 0;

  // ============================================================
  // ПАРСЕР LRC
  // ============================================================
  const LRC_RE = /^\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)$/;

  function parseLRC(text) {
    if (!text) return [];
    const out = [];
    for (const raw of text.split(/\r?\n/)) {
      const m = raw.match(LRC_RE);
      if (!m) continue;
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const ms = parseInt(m[3].padEnd(3, '0'), 10);
      const time = min * 60 + sec + ms / 1000;
      const lineText = m[4].trim();
      if (lineText) out.push({ time, text: lineText });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  }

  // ============================================================
  // РЕНДЕР
  // ============================================================
  function renderLines() {
    log('renderLines: строк =', lines.length);
    bodyEl.innerHTML = '';
    lineEls = [];
    activeIndex = -1;

    if (!lines.length) {
      bodyEl.innerHTML = '<div class="lyrics-empty">Нет LRC-файла рядом с треком</div>';
      return;
    }

    const frag = document.createDocumentFragment();
    for (let i = 0; i < lines.length; i++) {
      const div = document.createElement('div');
      div.className = 'lyrics-line';
      div.textContent = lines[i].text;
      frag.appendChild(div);
      lineEls.push(div);
    }
    bodyEl.appendChild(frag);
  }

  function setActiveLine(index) {
    if (index === activeIndex) return;
    if (activeIndex >= 0 && lineEls[activeIndex]) {
      lineEls[activeIndex].classList.remove('active');
    }
    if (index >= 0 && lineEls[index]) {
      lineEls[index].classList.add('active');
      lineEls[index].scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    activeIndex = index;
  }

  function findActiveIndex(seconds) {
    if (!lines.length) return -1;
    let lo = 0, hi = lines.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].time <= seconds) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return idx;
  }

  // ============================================================
  // ЗАГРУЗКА LRC
  // ============================================================
  async function loadLyricsForCurrentTrack(trackPath) {
    log('loadLyricsForCurrentTrack вызван, trackPath =', trackPath);

    if (trackPath === currentTrackPath) {
      log('loadLyricsForCurrentTrack: путь не изменился, выход');
      return;
    }

    const token = ++loadToken;
    currentTrackPath = trackPath;

    if (!trackPath) {
      log('loadLyricsForCurrentTrack: путь пустой, очистка');
      if (token === loadToken) {
        lines = [];
        renderLines();
      }
      return;
    }

    let text = null;
    try {
      text = await window.WebPlayer.pluginCall('lyrics', 'read_file_next_to_track', '.lrc');
    } catch (e) {
      warn('read_file_next_to_track упал:', e);
      text = null;
    }

    if (token !== loadToken) {
      log('loadLyricsForCurrentTrack: токен устарел, выбрасываю результат');
      return;
    }

    lines = parseLRC(text);
    log('loadLyricsForCurrentTrack: распарсено строк =', lines.length);
    renderLines();
  }

  // ============================================================
  // РЕАКЦИЯ НА ОБНОВЛЕНИЕ СТАТУСА
  // ============================================================
  let updateCounter = 0;

  async function onPlayerUpdate(status) {
    const n = ++updateCounter;
    if (!status) {
      log('#' + n, 'player:update без status');
      return;
    }

    const total = (status.track_info && status.track_info.duration) || 0;
    const seconds = (status.position || 0) * total;

    // 1) позиция
    setActiveLine(findActiveIndex(seconds));

    // 2) смена трека
    let path = status.track_info && status.track_info.id;

    if (path === undefined && (n % 30 === 0)) {
      try {
        path = await window.WebPlayer.pluginCall('lyrics', 'get_current_track_path');
      } catch (e) {
        warn('#' + n, 'get_current_track_path упал:', e);
        return;
      }
    }

    if (path !== undefined && path !== lastKnownPath) {
      log('#' + n, 'смена трека:', lastKnownPath, '->', path);
      lastKnownPath = path;
      await loadLyricsForCurrentTrack(path);
    }
  }

  // ============================================================
  // РЕАКЦИЯ НА ТИК ПОЗИЦИИ (60 fps)
  // ============================================================
  function onPlayerTick(position) {
    if (!lines.length) return;
    if (!window.currentStatus) return;

    const total = (window.currentStatus.track_info && window.currentStatus.track_info.duration) || 0;
    if (total <= 0) return;

    const seconds = position * total;
    setActiveLine(findActiveIndex(seconds));
  }

  // ============================================================
  // СТАРТ
  // ============================================================
  log('старт: createHeaderButton');
  createHeaderButton();

  log('старт: подписка на player:update');
  window.WebPlayer.on('player:update', onPlayerUpdate);

  log('старт: подписка на player:tick');
  window.WebPlayer.on('player:tick', onPlayerTick);

  log('старт: первичный get_status');
  window.WebPlayer.pluginCall('lyrics', 'get_status')
    .then((st) => {
      log('get_status ->', st);
      return onPlayerUpdate(st);
    })
    .catch((e) => {
      warn('get_status упал:', e);
    });

  // ============================================================
  // ВЫГРУЗКА
  // ============================================================
  window.WebPlayer.on('plugin:beforeUnmount', (data) => {
    if (data && data.id === 'lyrics') {
      log('плагин выгружается, убираю кнопку');
      removeHeaderButton();
    }
  });

  log('IIFE end');
})();