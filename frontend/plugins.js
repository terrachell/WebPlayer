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

  // --- шина событий ---
  window.WebPlayer.on = function (event, cb) {
    (listeners[event] = listeners[event] || []).push(cb);
  };
  window.WebPlayer.emit = function (event, data) {
    (listeners[event] || []).forEach(cb => {
      try { cb(data); } catch (e) { console.error(e); }
    });
  };

  // --- вызов метода плагина через ядро ---
window.WebPlayer.pluginCall = async function (pluginId, method, ...args) {
    if (!window.apiReady) return { error: 'api not ready' };
    return await window.api.call('plugin_call', pluginId, method, ...args);
};

  // --- получить контейнер слота по имени ---
  function getSlotContainer(slotName) {
    const name = KNOWN_SLOTS.includes(slotName) ? slotName : DEFAULT_SLOT;
    let el = document.getElementById(`plugin-slot-${name}`);
    if (!el) {
      // На всякий случай: если в HTML нет нужного слота — падаем в дефолтный
      console.warn(`[plugins] слот "${name}" не найден в DOM, fallback на "${DEFAULT_SLOT}"`);
      el = document.getElementById(`plugin-slot-${DEFAULT_SLOT}`);
    }
    if (!el) {
      console.error(`[plugins] ни слот "${name}", ни fallback "${DEFAULT_SLOT}" не найдены`);
    }
    return el;
  }

  // --- загрузка одного плагина в DOM ---
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

  // --- выгрузка плагина из DOM ---
function unmountPlugin(id) {
    const entry = loaded[id];
    if (!entry) return;

    // Сообщаем плагину, что его выгружают
    if (window.WebPlayer && window.WebPlayer.emit) {
        window.WebPlayer.emit('plugin:beforeUnmount', { id });
    }

    entry.root.remove();
    entry.links.forEach(el => el.remove());
    entry.scripts.forEach(el => el.remove());

    delete loaded[id];
    console.log(`[plugin:${id}] выгружен`);
}

  // --- загрузка всех включённых плагинов ---
  window.WebPlayer.loadAllPlugins = async function () {
    if (!apiReady) return;
    const list = await window.api.call('get_plugins');
    for (const item of list) {
      if (item.enabled) {
        await mountPlugin(item.manifest);
      }
    }
  };

  // --- динамическое включение ---
  window.WebPlayer.enablePlugin = async function (pluginId) {
    if (!apiReady) return false;
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

  // --- динамическое выключение ---
  window.WebPlayer.disablePlugin = function (pluginId) {
    unmountPlugin(pluginId);
    return true;
  };

  // --- утилита: список загруженных плагинов ---
  window.WebPlayer.getLoadedPlugins = function () {
    return Object.keys(loaded);
  };
})();

window.WebPlayer.toggleFocus = function (pluginId) {
    const body = document.body;
    const current = body.dataset.focusPlugin || '';
    const slot = document.getElementById('plugin-slot-fullscreen');

    if (current === pluginId) {
        body.removeAttribute('data-focus-plugin');
        if (slot) slot.classList.remove('active');
    } else {
        body.dataset.focusPlugin = pluginId;
        if (slot) slot.classList.add('active');
    }
};