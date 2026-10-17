// ============================================================
// PLUGINS — загрузка, слоты, изоляция
// ============================================================

window.WebPlayer = window.WebPlayer || {};

(function () {
  const listeners = {};
  const loaded = {};   // id -> { manifest, root, links: [], scripts: [] }

  // Слоты, которые ядро поддерживает.
  // Если плагин указал слот, которого нет — fallback на DEFAULT_SLOT.
  const DEFAULT_SLOT = 'sidebar';
  const KNOWN_SLOTS = ['header', 'sidebar', 'overlay', 'player', 'fullscreen', 'content'];

  // ============================================================
  // Шина событий
  // ============================================================
  window.WebPlayer.on = function (event, cb) {
    (listeners[event] = listeners[event] || []).push(cb);
  };

  window.WebPlayer.emit = function (event, data) {
    (listeners[event] || []).forEach(cb => {
      try { cb(data); } catch (e) { console.error(e); }
    });
  };

  // ============================================================
  // Вызов метода плагина через ядро
  // ============================================================
  window.WebPlayer.pluginCall = async function (pluginId, method, ...args) {
    if (!window.apiReady) return { error: 'api not ready' };
    return await window.api.call('plugin_call', pluginId, method, ...args);
  };

  // ============================================================
  // Получить контейнер слота по имени
  // ============================================================
  function getSlotContainer(slotName) {
    const name = KNOWN_SLOTS.includes(slotName) ? slotName : DEFAULT_SLOT;
    let el = document.getElementById(`plugin-slot-${name}`);
    if (!el) {
      console.warn(`[plugins] слот "${name}" не найден в DOM, fallback на "${DEFAULT_SLOT}"`);
      el = document.getElementById(`plugin-slot-${DEFAULT_SLOT}`);
    }
    if (!el) {
      console.error(`[plugins] ни слот "${name}", ни fallback "${DEFAULT_SLOT}" не найдены`);
    }
    return el;
  }

  // ============================================================
  // Монтирование плагина
  // ============================================================
  async function mountPlugin(manifest) {
    const id = manifest.id;
    if (loaded[id]) return;   // уже загружен

    const slotName = manifest.slot || DEFAULT_SLOT;
    const container = getSlotContainer(slotName);
    if (!container) return;

    const root = document.createElement('div');
    root.className = 'plugin-root';
    root.dataset.pluginId = id;
    root.dataset.pluginSlot = slotName;
    container.appendChild(root);

    // HTML
    try {
      const html = await fetch(`plugins/${id}/${manifest.entry}`).then(r => r.text());
      root.innerHTML = html;
    } catch (e) {
      console.error(`[plugin:${id}] не удалось загрузить ${manifest.entry}:`, e);
      root.remove();
      return;
    }

    // CSS
    const links = [];
    for (const css of manifest.styles || []) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `plugins/${id}/${css}`;
      link.dataset.pluginId = id;
      document.head.appendChild(link);
      links.push(link);
    }

    // JS
    const scripts = [];
    for (const js of manifest.scripts || []) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `plugins/${id}/${js}`;
        script.dataset.pluginId = id;
        script.onload = resolve;
        script.onerror = reject;
        document.body.appendChild(script);
        scripts.push(script);
      });
    }

    loaded[id] = { manifest, root, links, scripts, slotName };
    console.log(`[plugin:${id}] смонтирован в слот "${slotName}"`);
  }

  // ============================================================
  // Выгрузка плагина
  // ============================================================
  function unmountPlugin(id) {
    const entry = loaded[id];
    if (!entry) return;

    // Сообщаем плагину, что его выгружают
    window.WebPlayer.emit('plugin:beforeUnmount', { id });

    // Если плагин был активен в слоте content — снимаем фокус
    if (window.WebPlayer._activeContentPlugin === id) {
      window.WebPlayer._activeContentPlugin = null;
      window.WebPlayer.emit('content:activeChanged', { activeId: null });
      const contentSlot = document.getElementById('plugin-slot-content');
      if (contentSlot) {
        contentSlot.classList.remove('active');
      }
    }

    // Если плагин лежал в content — убираем его рут из слота
    if (entry.root && entry.root.parentNode) {
      entry.root.remove();
    }
    entry.links.forEach(el => el.remove());
    entry.scripts.forEach(el => el.remove());

    delete loaded[id];
    console.log(`[plugin:${id}] выгружен`);
  }

  // ============================================================
  // Загрузка всех включённых плагинов
  // ============================================================
  window.WebPlayer.loadAllPlugins = async function () {
    if (!window.apiReady) return;
    const list = await window.api.call('get_plugins');
    for (const item of list) {
      if (item.enabled) {
        await mountPlugin(item.manifest);
      }
    }
  };

  // ============================================================
  // Динамическое включение / выключение
  // ============================================================
  window.WebPlayer.enablePlugin = async function (pluginId) {
    if (!window.apiReady) return false;
    if (loaded[pluginId]) return true;   // уже загружен

    const list = await window.api.call('get_plugins');
    const item = list.find(p => p.id === pluginId);
    if (!item) {
      console.warn(`[plugin:${pluginId}] не найден`);
      return false;
    }
    await mountPlugin(item.manifest);
    return true;
  };

  window.WebPlayer.disablePlugin = function (pluginId) {
    unmountPlugin(pluginId);
    return true;
  };

  // ============================================================
  // Утилита: список загруженных плагинов
  // ============================================================
  window.WebPlayer.getLoadedPlugins = function () {
    return Object.keys(loaded);
  };

  // ============================================================
  // Секции настроек от плагинов
  // ============================================================

  /**
   * Возвращает массив секций настроек от всех включённых плагинов.
   * Формат: [{ id, icon, label, pluginId, manifest }]
   */
  window.WebPlayer.getSettingsSections = function () {
    const list = [];
    for (const id in loaded) {
      const entry = loaded[id];
      const s = entry.manifest.settings;
      if (!s || !s.label) continue;
      list.push({
        id: `plugin:${id}`,
        icon: s.icon || '🧩',
        label: s.label,
        pluginId: id,
        manifest: s,
      });
    }
    return list;
  };

  /**
   * Рендерит секцию настроек плагина в указанный контейнер.
   */
  window.WebPlayer.renderSettingsSection = async function (pluginId, container) {
    const entry = loaded[pluginId];
    if (!entry) {
      console.warn(`[plugins] renderSettingsSection: плагин ${pluginId} не загружен`);
      return;
    }

    const s = entry.manifest.settings;
    if (!s) return;

    container.innerHTML = '<div class="settings-loading">Загрузка...</div>';

    let html = '';
    if (s.entry) {
      try {
        html = await fetch(`plugins/${pluginId}/${s.entry}`).then(r => r.text());
      } catch (e) {
        console.error(`[plugin:${pluginId}] не удалось загрузить ${s.entry}:`, e);
        container.innerHTML = '<div class="settings-error">Не удалось загрузить настройки плагина</div>';
        return;
      }
    }

    container.innerHTML = html;

    const styleId = `plugin-settings-css-${pluginId}`;
    if (!document.getElementById(styleId)) {
      const styleEl = document.createElement('style');
      styleEl.id = styleId;
      let cssText = '';
      for (const css of s.styles || []) {
        try {
          const text = await fetch(`plugins/${pluginId}/${css}`).then(r => r.text());
          cssText += `\n/* === ${pluginId}/${css} === */\n` + text;
        } catch (e) {
          console.warn(`[plugin:${pluginId}] CSS ${css} не загружен:`, e);
        }
      }
      styleEl.textContent = cssText;
      document.head.appendChild(styleEl);
    }

    const scriptFlag = `__settingsScriptLoaded_${pluginId}`;
    if (!window[scriptFlag]) {
      window[scriptFlag] = true;
      for (const js of s.scripts || []) {
        try {
          const code = await fetch(`plugins/${pluginId}/${js}`).then(r => r.text());
          window.__pluginSettingsContext = { root: container, pluginId };
          const fn = new Function(code);
          fn();
        } catch (e) {
          console.error(`[plugin:${pluginId}] JS ${js} не загружен:`, e);
        }
      }
    } else if (typeof window[`__settingsRefresh_${pluginId}`] === 'function') {
      window[`__settingsRefresh_${pluginId}`](container);
    }
  };

  // ============================================================
  // Взаимоисключение плагинов в слоте content
  // ============================================================

  window.WebPlayer._activeContentPlugin = null;

  /**
   * Переключает активный плагин в слоте content.
   * Только один плагин может быть активен одновременно.
   * @param {string} pluginId
   * @returns {boolean} true, если плагин стал активным
   */
  window.WebPlayer.toggleContentPlugin = function (pluginId) {
    const slot = document.getElementById('plugin-slot-content');
    if (!slot) {
      console.warn('[plugins] plugin-slot-content не найден');
      return false;
    }

    const myRoot = slot.querySelector(`[data-plugin-id="${pluginId}"]`);
    if (!myRoot) {
      console.warn(`[plugins] рут плагина "${pluginId}" не найден в слоте content`);
      return false;
    }

    const willBeActive = !myRoot.classList.contains('active');

    // Снимаем active со всех рутов
    slot.querySelectorAll('.plugin-root').forEach(r => {
      r.classList.remove('active');
    });

    if (willBeActive) {
      myRoot.classList.add('active');
      window.WebPlayer._activeContentPlugin = pluginId;
      slot.classList.add('active');
    } else {
      window.WebPlayer._activeContentPlugin = null;
      slot.classList.remove('active');
    }

    window.WebPlayer.emit('content:activeChanged', {
      activeId: window.WebPlayer._activeContentPlugin,
    });

    return willBeActive;
  };

  /**
   * Возвращает id активного плагина в слоте content (или null).
   */
  window.WebPlayer.getActiveContentPlugin = function () {
    return window.WebPlayer._activeContentPlugin;
  };

})();