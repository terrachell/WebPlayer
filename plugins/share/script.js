// plugins/share/script.js

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
    console.log('%c[share ' + ts() + ']', 'color:#6cf', ...args);
  }
  function warn(...args) {
    console.warn('%c[share ' + ts() + ']', 'color:#fc6', ...args);
  }
  function err(...args) {
    console.error('%c[share ' + ts() + ']', 'color:#f66', ...args);
  }

  log('IIFE start');

  // ============================================================
  // DOM
  // ============================================================
  const bodyEl = document.querySelector('.share-plugin');
  if (!bodyEl) {
    err('не найден .share-plugin');
    return;
  }

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
    if (headerBtn) return;

    headerBtn = document.createElement('button');
    headerBtn.className = 'share-header-btn';
    headerBtn.title = 'Общий доступ';
    headerBtn.textContent = '📱';
    headerBtn.addEventListener('click', toggleShare);

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
  function toggleShare() {
    if (!window.WebPlayer || !window.WebPlayer.toggleContentPlugin) {
      warn('WebPlayer.toggleContentPlugin не найден');
      return;
    }
    const willBeActive = window.WebPlayer.toggleContentPlugin('share');
    if (willBeActive) {
      loadShare();
    }
  }

  // Подсветка кнопки при смене активного плагина
  if (window.WebPlayer && window.WebPlayer.on) {
    window.WebPlayer.on('content:activeChanged', (data) => {
      if (!headerBtn) return;
      headerBtn.classList.toggle('active', data.activeId === 'share');
    });
  }

  // ============================================================
  // ЗАГРУЗКА URL ОТ PYTHON
  // ============================================================
  let qrLoadedForUrl = null;

  async function loadShare() {
    const urlEl = document.getElementById('share-url');
    const codeEl = document.getElementById('share-code');

    if (codeEl) codeEl.innerHTML = '<div class="share-placeholder">Загрузка...</div>';

    try {
      const result = await window.WebPlayer.pluginCall('share', 'get_url');
      const url = result && result.url;
      if (!url) throw new Error('URL не получен');

      if (urlEl) urlEl.textContent = url;

      if (qrLoadedForUrl !== url) {
        renderQR(url);
        qrLoadedForUrl = url;
      }
    } catch (e) {
      err('loadShare упал:', e);
      if (codeEl) codeEl.innerHTML = '<div class="share-placeholder">Ошибка</div>';
      if (urlEl) urlEl.textContent = '—';
    }
  }

  // ============================================================
  // QR-РЕНДЕР
  // ============================================================
  function renderQR(url) {
    const codeEl = document.getElementById('share-code');
    if (!codeEl) return;

    const img = document.createElement('img');
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(url)}`;
    img.alt = 'QR';
    img.style.width = '100%';
    img.style.height = '100%';
    img.onerror = () => {
      err('не удалось загрузить QR-изображение');
      codeEl.innerHTML = '<div class="share-placeholder">QR недоступен (нет интернета?)</div>';
    };

    codeEl.innerHTML = '';
    codeEl.appendChild(img);
  }

  // ============================================================
  // СТАРТ
  // ============================================================
  createHeaderButton();

  window.WebPlayer.on('plugin:beforeUnmount', (data) => {
    if (data && data.id === 'share') {
      log('плагин выгружается, убираю кнопку');
      removeHeaderButton();
    }
  });

  log('IIFE end');
})();