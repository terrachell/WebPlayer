// ============================================================
// ===== SETTINGS.JS — ОКНО НАСТРОЕК ==========================
// ============================================================
(function() {
    'use strict';

    // ============================================================
    // ===== КОНСТАНТЫ ============================================
    // ============================================================
    const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

    const EQ_PRESETS = {
        'Flat':       [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        'Rock':       [5, 4, 2, 0, -1, -1, 0, 2, 3, 4],
        'Pop':        [-1, 1, 3, 4, 3, 1, -1, -2, -1, 0],
        'Jazz':       [3, 2, 1, 2, -1, -1, 0, 1, 2, 3],
        'Bass Boost': [8, 6, 4, 2, 0, 0, 0, 0, 0, 0],
        'Vocal':      [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1],
        'Electronic': [5, 4, 1, 0, -2, 1, 0, 2, 5, 6],
        'Classical':  [4, 3, 2, 1, -1, -1, 0, 2, 3, 4],
    };

    const ACCENTS = [
        { name: 'Индиго',    value: '#7c8cff' },
        { name: 'Мята',      value: '#4ade80' },
        { name: 'Роза',      value: '#f472b6' },
        { name: 'Янтарь',    value: '#fbbf24' },
        { name: 'Лазурь',    value: '#22d3ee' },
        { name: 'Сирень',    value: '#a78bfa' },
    ];

    const SECTIONS = [
        { id: 'appearance', icon: '🎨', label: 'Внешний вид' },
        { id: 'player',     icon: '▶️', label: 'Плеер' },
        { id: 'equalizer',  icon: '🎚', label: 'Эквалайзер' },
        { id: 'library',    icon: '📚', label: 'Библиотека' },
        { id: 'about',      icon: 'ℹ️', label: 'О программе' },
    ];

    // ============================================================
    // ===== СОСТОЯНИЕ ============================================
    // ============================================================
    let overlay = null;
    let activeSection = 'appearance';

    // Локальная копия всех настроек
    const state = {
        theme: 'dark',
        accent: '#7c8cff',
        cover_size: 'medium',
        eq_enabled: true,
        eq_values: new Array(10).fill(0),
        eq_profile: 'Flat',
        custom_profiles: {},
        waveform_enabled: true,
        waveform_points: 2000,
        playlist_limit: 1000,
        resume_on_start: true,
    };

    // ============================================================
    // ===== API-АДАПТЕР ==========================================
    // ============================================================
    async function apiCall(method, ...args) {
        if (typeof window.pywebview !== 'undefined' && window.pywebview.api) {
            return await window.pywebview.api[method](...args);
        }
        throw new Error('API недоступен');
    }

    async function saveToAPI() {
        try {
            await apiCall('save_settings', { ...state });
        } catch (e) {
            console.error('save_settings error:', e);
        }
    }

    // ============================================================
    // ===== ПРИМЕНЕНИЕ НАСТРОЕК К UI =============================
    // ============================================================
    function applyAccent(color) {
        document.documentElement.style.setProperty('--accent', color);
        // Производные оттенки
        const rgb = hexToRgb(color);
        if (rgb) {
            document.documentElement.style.setProperty('--accent-dim', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.12)`);
            document.documentElement.style.setProperty('--accent-glow', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15)`);
            document.documentElement.style.setProperty('--border-active', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.3)`);
        }
    }

    function applyCoverSize(size) {
        document.body.setAttribute('data-cover-size', size);
    }

    function hexToRgb(hex) {
        const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return m ? {
            r: parseInt(m[1], 16),
            g: parseInt(m[2], 16),
            b: parseInt(m[3], 16),
        } : null;
    }

    // ============================================================
    // ===== HTML-СТРУКТУРА ОВЕРЛЕЯ ===============================
    // ============================================================
    function buildOverlayHTML() {
        return `
            <div class="settings-shell">
                <aside class="settings-nav">
                    <div class="settings-nav-title">⚙️ Настройки</div>
                    ${SECTIONS.map(s => `
                        <button class="settings-nav-item" data-section="${s.id}">
                            <span class="nav-icon">${s.icon}</span>
                            <span class="nav-label">${s.label}</span>
                        </button>
                    `).join('')}
                </aside>

                <main class="settings-body">
                    <button class="settings-close" onclick="window.closeSettings()" title="Закрыть">✕</button>
                    <div class="settings-content" id="settingsContent"></div>
                </main>
            </div>
        `;
    }

    // ============================================================
    // ===== РЕНДЕР СЕКЦИЙ ========================================
    // ============================================================
    function renderSection(id) {
        activeSection = id;

        // Подсветка активного пункта меню
        document.querySelectorAll('.settings-nav-item').forEach(el => {
            el.classList.toggle('active', el.dataset.section === id);
        });

        const content = document.getElementById('settingsContent');
        content.innerHTML = '';

        switch (id) {
            case 'appearance': renderAppearance(content); break;
            case 'player':     renderPlayer(content); break;
            case 'equalizer':  renderEqualizer(content); break;
            case 'library':    renderLibrary(content); break;
            case 'about':      renderAbout(content); break;
        }
    }

    // ---------- Внешний вид ----------
    function renderAppearance(root) {
        root.innerHTML = `
            <h2>🎨 Внешний вид</h2>

            <div class="setting-group">
                <div class="setting-label">Тема оформления</div>
                <div class="theme-toggle">
                    <button class="theme-btn ${state.theme === 'dark' ? 'active' : ''}"
                            data-theme="dark" onclick="window.__setTheme('dark')">🌙 Тёмная</button>
                    <button class="theme-btn ${state.theme === 'light' ? 'active' : ''}"
                            data-theme="light" onclick="window.__setTheme('light')">☀️ Светлая</button>
                </div>
            </div>

            <div class="setting-group">
                <div class="setting-label">Акцентный цвет</div>
                <div class="accent-picker" id="accentPicker">
                    ${ACCENTS.map(a => `
                        <button class="accent-swatch ${state.accent === a.value ? 'active' : ''}"
                                data-color="${a.value}"
                                style="--swatch: ${a.value}"
                                title="${a.name}"
                                onclick="window.__setAccent('${a.value}')"></button>
                    `).join('')}
                </div>
            </div>

            <div class="setting-group">
                <div class="setting-label">Размер обложек в списке</div>
                <div class="segmented" data-name="cover_size">
                    ${['small','medium','large'].map(s => `
                        <button class="seg-btn ${state.cover_size === s ? 'active' : ''}"
                                data-value="${s}"
                                onclick="window.__setCoverSize('${s}')">
                            ${s === 'small' ? 'Маленькие' : s === 'medium' ? 'Средние' : 'Большие'}
                        </button>
                    `).join('')}
                </div>
            </div>
        `;
    }

    // ---------- Плеер ----------
    function renderPlayer(root) {
        root.innerHTML = `
            <h2>▶️ Плеер</h2>

            <div class="setting-group">
                <label class="toggle-switch">
                    <input type="checkbox" ${state.resume_on_start ? 'checked' : ''}
                           onchange="window.__setBool('resume_on_start', this.checked)">
                    <span class="slider"></span>
                    <span class="toggle-label">Продолжать с последнего трека при запуске</span>
                </label>
            </div>

            <div class="setting-group">
                <label class="toggle-switch">
                    <input type="checkbox" ${state.waveform_enabled ? 'checked' : ''}
                           onchange="window.__setBool('waveform_enabled', this.checked)">
                    <span class="slider"></span>
                    <span class="toggle-label">Показывать waveform</span>
                </label>
                <div class="setting-hint">Если выключить, при запуске трека не будет считаться волна — это ускоряет переключение.</div>
            </div>

            <div class="setting-group">
                <div class="setting-label">Точек waveform</div>
                <div class="segmented">
                    ${[1000, 2000, 4000].map(n => `
                        <button class="seg-btn ${state.waveform_points === n ? 'active' : ''}"
                                onclick="window.__setWaveformPoints(${n})">
                            ${n}
                        </button>
                    `).join('')}
                </div>
                <div class="setting-hint">Больше точек — детальнее волна, но дольше первая отрисовка и больше кэш.</div>
            </div>
        `;
    }

    // ---------- Эквалайзер ----------
    function renderEqualizer(root) {
        const presetNames = Object.keys(EQ_PRESETS);
        const customNames = Object.keys(state.custom_profiles);

        root.innerHTML = `
            <h2>🎚 Эквалайзер</h2>

            <div class="setting-group">
                <label class="toggle-switch">
                    <input type="checkbox" id="eqToggle" ${state.eq_enabled ? 'checked' : ''}
                           onchange="window.__setBool('eq_enabled', this.checked)">
                    <span class="slider"></span>
                    <span class="toggle-label">Включить эквалайзер</span>
                </label>
            </div>

            <div class="setting-group">
                <div class="setting-label">Пресеты</div>
                <div class="preset-row">
                    ${presetNames.map(name => `
                        <button class="preset-btn ${state.eq_profile === name ? 'active' : ''}"
                                data-name="${name}"
                                onclick="window.__applyPreset('${name}')">${name}</button>
                    `).join('')}
                </div>
            </div>

            <div class="setting-group eq-group" id="eqGroup">
                <div class="eq-header">
                    <div class="setting-label">Полосы</div>
                    <div class="eq-current" id="eqCurrentProfile">${state.eq_profile}</div>
                </div>
                <div class="equalizer-container" id="equalizerContainer"></div>
                <div class="eq-actions">
                    <button class="eq-btn" onclick="window.__resetEQ()">Сбросить (Flat)</button>
                    <button class="eq-btn accent" onclick="window.__saveProfile()">💾 Сохранить профиль</button>
                </div>
            </div>

            <div class="setting-group">
                <div class="setting-label">Мои профили (${customNames.length})</div>
                <div class="custom-profiles" id="customProfilesList">
                    ${customNames.length ? customNames.map(name => `
                        <div class="profile-item">
                            <span class="profile-name" onclick="window.__loadProfile('${name}')">${name}</span>
                            <span class="profile-actions">
                                <span class="profile-act" title="Загрузить" onclick="window.__loadProfile('${name}')">▶</span>
                                <span class="profile-act" title="Переименовать" onclick="window.__renameProfile('${name}')">✏️</span>
                                <span class="profile-act danger" title="Удалить" onclick="window.__deleteProfile('${name}')">🗑</span>
                            </span>
                        </div>
                    `).join('') : '<div class="empty-hint">Пока нет сохранённых профилей</div>'}
                </div>
            </div>
        `;

        initEqualizerSliders();
    }

    function initEqualizerSliders() {
        const container = document.getElementById('equalizerContainer');
        if (!container) return;
        container.innerHTML = '';

        EQ_BANDS.forEach((freq, index) => {
            const band = document.createElement('div');
            band.className = 'eq-band';

            const value = document.createElement('span');
            value.className = 'eq-value';
            value.textContent = state.eq_values[index].toFixed(1) + '';

            const slider = document.createElement('input');
            slider.type = 'range';
            slider.min = -12;
            slider.max = 12;
            slider.value = state.eq_values[index];
            slider.step = 0.5;
            slider.className = 'eq-slider';
            slider.dataset.index = index;
            slider.oninput = function() {
                const val = parseFloat(this.value);
                state.eq_values[parseInt(this.dataset.index)] = val;
                value.textContent = val.toFixed(1);
                // Когда крутим ползунок — переключаемся на Custom
                if (state.eq_profile !== 'Custom') {
                    state.eq_profile = 'Custom';
                    updateProfileHighlight();
                }
                saveToAPI();
            };

            const label = document.createElement('span');
            label.className = 'eq-label';
            label.textContent = freq < 1000 ? `${freq}` : `${(freq / 1000).toFixed(0)}k`;

            band.appendChild(value);
            band.appendChild(slider);
            band.appendChild(label);
            container.appendChild(band);
        });
    }

    function updateProfileHighlight() {
        document.querySelectorAll('.preset-btn').forEach(el => {
            el.classList.toggle('active', el.dataset.name === state.eq_profile);
        });
        const cur = document.getElementById('eqCurrentProfile');
        if (cur) cur.textContent = state.eq_profile;
    }

    function redrawSliders() {
        const sliders = document.querySelectorAll('.eq-slider');
        const values = document.querySelectorAll('.eq-value');
        sliders.forEach((s, i) => {
            s.value = state.eq_values[i];
            if (values[i]) values[i].textContent = state.eq_values[i].toFixed(1);
        });
    }

    // ---------- Библиотека ----------
    function renderLibrary(root) {
        root.innerHTML = `
            <h2>📚 Библиотека</h2>

            <div class="setting-group">
                <div class="setting-label">Лимит треков в плейлисте</div>
                <input type="number" class="setting-input" min="0" step="50"
                       value="${state.playlist_limit}"
                       onchange="window.__setPlaylistLimit(this.value)">
                <div class="setting-hint">0 — без ограничения. При превышении новые треки не добавятся.</div>
            </div>

            <div class="setting-group">
                <div class="setting-label">Обслуживание</div>
                <div class="action-row">
                    <button class="eq-btn" onclick="window.__clearWaveformCache()">🗑 Очистить кэш волн</button>
                    <span class="action-hint" id="waveformCacheSize">—</span>
                </div>
                <div class="action-row">
                    <button class="eq-btn" onclick="window.__rescanPlaylists()">🔄 Пересканировать плейлисты</button>
                    <span class="action-hint">Удаляет отсутствующие файлы</span>
                </div>
            </div>
        `;

        updateCacheSize();
    }

    async function updateCacheSize() {
        const el = document.getElementById('waveformCacheSize');
        if (!el) return;
        try {
            const size = await apiCall('get_waveform_cache_size');
            el.textContent = formatBytes(size || 0);
        } catch (e) {
            el.textContent = '—';
        }
    }

    function formatBytes(b) {
        if (b < 1024) return b + ' Б';
        if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' КБ';
        return (b / 1024 / 1024).toFixed(2) + ' МБ';
    }

    // ---------- О программе ----------
    function renderAbout(root) {
        root.innerHTML = `
            <h2>ℹ️ О программе</h2>

            <div class="setting-group">
                <div class="about-block">
                    <div class="about-name">✦ Музыкальный плеер</div>
                    <div class="about-version">Версия 2.0</div>
                </div>
            </div>

            <div class="setting-group">
                <div class="setting-label">Использует</div>
                <ul class="about-list">
                    <li>Python + pywebview</li>
                    <li>VLC (libvlc) — воспроизведение</li>
                    <li>tinytag — чтение метаданных</li>
                    <li>pydub + ffmpeg — waveform</li>
                </ul>
            </div>

            <div class="setting-group">
                <div class="setting-label">Опасная зона</div>
                <button class="eq-btn danger" onclick="window.__resetAllSettings()">⚠️ Сбросить все настройки</button>
                <div class="setting-hint">Тема, акцент, EQ, профили, лимиты — всё вернётся к значениям по умолчанию. Плейлисты и метаданные не тронутся.</div>
            </div>
        `;
    }

    // ============================================================
    // ===== ПУБЛИЧНЫЕ ФУНКЦИИ (window.__xxx) =====================
    // ============================================================

    window.__setTheme = function(theme) {
        state.theme = theme;
        if (typeof window.switchTheme === 'function') {
            window.switchTheme(theme, false);
        } else {
            document.documentElement.setAttribute('data-theme', theme);
        }
        document.querySelectorAll('.theme-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.theme === theme);
        });
        saveToAPI();
    };

    window.__setAccent = function(color) {
        state.accent = color;
        applyAccent(color);
        document.querySelectorAll('.accent-swatch').forEach(el => {
            el.classList.toggle('active', el.dataset.color === color);
        });
        saveToAPI();
    };

    window.__setCoverSize = function(size) {
        state.cover_size = size;
        applyCoverSize(size);
        document.querySelectorAll('[data-name="cover_size"] .seg-btn').forEach(el => {
            el.classList.toggle('active', el.dataset.value === size);
        });
        saveToAPI();
    };

    window.__setBool = function(key, value) {
        state[key] = value;
        saveToAPI();
    };

    window.__setWaveformPoints = function(points) {
        state.waveform_points = points;
        document.querySelectorAll('.segmented .seg-btn').forEach(el => {
            if (el.textContent.trim() === String(points)) el.classList.add('active');
        });
        // перерисуем всю секцию плеера, чтобы все переключатели были корректны
        renderSection('player');
        saveToAPI();
    };

    window.__setPlaylistLimit = function(value) {
        const v = parseInt(value);
        if (!isNaN(v) && v >= 0) {
            state.playlist_limit = v;
            saveToAPI();
        }
    };

    window.__applyPreset = function(name) {
        const vals = EQ_PRESETS[name];
        if (!vals) return;
        state.eq_values = vals.slice();
        state.eq_profile = name;
        redrawSliders();
        updateProfileHighlight();
        saveToAPI();
    };

    window.__resetEQ = function() {
        window.__applyPreset('Flat');
    };

    window.__saveProfile = function() {
        const name = prompt('Название профиля:', 'Мой профиль');
        if (!name) return;
        const trimmed = name.trim();
        if (!trimmed) return;
        if (EQ_PRESETS[trimmed]) {
            if (!confirm(`Перезаписать встроенный пресет «${trimmed}»?`)) return;
        }
        state.custom_profiles[trimmed] = state.eq_values.slice();
        state.eq_profile = trimmed;
        saveToAPI();
        renderSection('equalizer');
    };

    window.__loadProfile = function(name) {
        const vals = state.custom_profiles[name];
        if (!vals) return;
        state.eq_values = vals.slice();
        state.eq_profile = name;
        redrawSliders();
        updateProfileHighlight();
        saveToAPI();
    };

    window.__renameProfile = function(oldName) {
        const newName = prompt('Новое имя профиля:', oldName);
        if (!newName) return;
        const trimmed = newName.trim();
        if (!trimmed || trimmed === oldName) return;
        if (state.custom_profiles[trimmed]) {
            alert('Профиль с таким именем уже есть');
            return;
        }
        state.custom_profiles[trimmed] = state.custom_profiles[oldName];
        delete state.custom_profiles[oldName];
        if (state.eq_profile === oldName) state.eq_profile = trimmed;
        saveToAPI();
        renderSection('equalizer');
    };

    window.__deleteProfile = function(name) {
        if (!confirm(`Удалить профиль «${name}»?`)) return;
        delete state.custom_profiles[name];
        if (state.eq_profile === name) state.eq_profile = 'Flat';
        saveToAPI();
        renderSection('equalizer');
    };

    window.__clearWaveformCache = async function() {
        if (!confirm('Удалить весь кэш waveform? Он пересчитается при следующем воспроизведении.')) return;
        try {
            await apiCall('clear_waveform_cache');
            updateCacheSize();
        } catch (e) {
            alert('Ошибка очистки: ' + e.message);
        }
    };

    window.__rescanPlaylists = async function() {
        try {
            await apiCall('rescan_playlists');
            if (typeof loadStatus === 'function') loadStatus();
            alert('Готово. Отсутствующие файлы удалены из плейлистов.');
        } catch (e) {
            alert('Ошибка: ' + e.message);
        }
    };

    window.__resetAllSettings = async function() {
        if (!confirm('Сбросить ВСЕ настройки? Это не затронет плейлисты и метаданные.')) return;

        state.theme = 'dark';
        state.accent = '#7c8cff';
        state.cover_size = 'medium';
        state.eq_enabled = true;
        state.eq_values = new Array(10).fill(0);
        state.eq_profile = 'Flat';
        state.custom_profiles = {};
        state.waveform_enabled = true;
        state.waveform_points = 2000;
        state.playlist_limit = 1000;
        state.resume_on_start = true;

        applyAccent(state.accent);
        applyCoverSize(state.cover_size);
        if (typeof window.switchTheme === 'function') window.switchTheme('dark', false);

        await saveToAPI();
        renderSection(activeSection);
    };

    // ============================================================
    // ===== ОТКРЫТИЕ / ЗАКРЫТИЕ ==================================
    // ============================================================
    window.openSettings = async function() {
        if (overlay && overlay.style.display !== 'none') return;

        // Загружаем актуальные настройки из API
        try {
            const data = await apiCall('get_settings');
            if (data) {
                Object.assign(state, data);
                if (!state.custom_profiles) state.custom_profiles = {};
                if (!Array.isArray(state.eq_values) || state.eq_values.length !== 10) {
                    state.eq_values = new Array(10).fill(0);
                }
            }
        } catch (e) {
            console.error('Не удалось загрузить настройки:', e);
        }

        overlay = document.createElement('div');
        overlay.id = 'settingsOverlay';
        overlay.innerHTML = buildOverlayHTML();
        document.body.appendChild(overlay);

        // Обработчики навигации
        overlay.querySelectorAll('.settings-nav-item').forEach(btn => {
            btn.onclick = () => renderSection(btn.dataset.section);
        });

        renderSection('appearance');

        requestAnimationFrame(() => overlay.classList.add('visible'));
    };

    window.closeSettings = function() {
        if (!overlay) return;
        overlay.classList.remove('visible');
        setTimeout(() => {
            if (overlay) overlay.remove();
            overlay = null;
        }, 180);
    };

    // Закрытие по Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay) window.closeSettings();
    });

})();