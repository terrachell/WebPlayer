// ============================================================
// ===== АДАПТЕР API ==========================================
// ============================================================
const isWebview = () => typeof window.pywebview !== 'undefined' && window.pywebview.api;

const api = {
    async call(method, ...args) {
        if (isWebview()) {
            return await window.pywebview.api[method](...args);
        }
        const res = await fetch(`/api/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ args })
        });
        if (!res.ok) throw new Error(`API ${method}: ${res.status}`);
        const data = await res.json();
        return data.result;
    }
};

// ============================================================
// ===== ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ================================
// ============================================================
let apiReady = false;
let initRetries = 0;
let waveformData = [];
let waveformDuration = 0;
let currentPosition = 0;
let isDraggingWaveform = false;
let canvas = null;
let ctx = null;
let tracks = [];
let tooltip = null;
let currentStatus = null;
let editingTrackPath = null;

// ============================================================
// ===== ОЖИДАНИЕ API =========================================
// ============================================================
function waitForApi(callback) {
    if (isWebview() && typeof window.pywebview.api.ready === 'function') {
        window.pywebview.api.ready().then((result) => {
            if (result === true) {
                apiReady = true;
                callback();
            } else {
                scheduleRetry(callback);
            }
        }).catch(() => scheduleRetry(callback));
    } else {
        scheduleRetry(callback);
    }
}

function scheduleRetry(callback) {
    initRetries++;
    if (initRetries > 20) {
        console.warn('API не отвечает после 20 попыток.');
        return;
    }
    setTimeout(() => waitForApi(callback), 400);
}

// ============================================================
// ===== БЕГУЩАЯ СТРОКА =======================================
// ============================================================
function setupMarquee(el) {
    if (!el) return;
    el.classList.remove('marquee-active');
    el.style.removeProperty('--marquee-duration');

    const wrapper = el.parentElement;
    if (!wrapper) return;

    requestAnimationFrame(() => requestAnimationFrame(() => {
        const textWidth = el.scrollWidth;
        const containerWidth = wrapper.clientWidth;
        if (textWidth > containerWidth + 2) {
            const duration = Math.max(8, textWidth / 40);
            el.style.setProperty('--marquee-duration', `${duration}s`);
            el.classList.add('marquee-active');
        }
    }));
}

// ============================================================
// ===== WAVEFORM =============================================
// ============================================================
function initWaveform() {
    canvas = document.getElementById('waveformCanvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');

    resizeWaveform();
    window.addEventListener('resize', resizeWaveform);

    canvas.addEventListener('mousedown', function(e) {
        isDraggingWaveform = true;
        doSeek(e);
    });

    canvas.addEventListener('click', function(e) {
        if (isDraggingWaveform) return;
        doSeek(e);
        applySeek();
    });

    document.addEventListener('mousemove', handleWaveformMouseMove);
    document.addEventListener('mouseup', handleWaveformMouseUp);
}

function handleWaveformMouseMove(e) {
    if (!isDraggingWaveform || !canvas) return;
    const rect = canvas.getBoundingClientRect();

    if (e.clientX < rect.left) {
        currentPosition = 0;
        drawWaveform();
        api.call('seek', 0).then(() => api.call('play')).then(loadStatus).catch(() => {});
        isDraggingWaveform = false;
        return;
    }
    if (e.clientX > rect.right) {
        currentPosition = 1;
        drawWaveform();
        api.call('stop').then(() => {
            currentPosition = 0;
            drawWaveform();
            loadStatus();
        }).catch(() => {});
        isDraggingWaveform = false;
        return;
    }
    if (e.clientX >= rect.left && e.clientX <= rect.right) {
        doSeek(e);
    }
}

function handleWaveformMouseUp(e) {
    if (!isDraggingWaveform || !canvas) return;
    const rect = canvas.getBoundingClientRect();

    if (e.clientX < rect.left) {
        currentPosition = 0;
        drawWaveform();
        api.call('seek', 0).then(() => api.call('play')).then(loadStatus).catch(() => {});
    } else if (e.clientX > rect.right) {
        currentPosition = 1;
        drawWaveform();
        api.call('stop').then(() => {
            currentPosition = 0;
            drawWaveform();
            loadStatus();
        }).catch(() => {});
    } else if (e.clientX >= rect.left && e.clientX <= rect.right) {
        if (currentPosition <= 0.02) {
            api.call('seek', 0).then(() => api.call('play')).then(loadStatus).catch(() => {});
        } else if (currentPosition >= 0.98) {
            api.call('stop').then(() => {
                currentPosition = 0;
                drawWaveform();
                loadStatus();
            }).catch(() => {});
        } else {
            applySeek();
        }
    }
    isDraggingWaveform = false;
}

function resizeWaveform() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    drawWaveform();
}

function loadWaveform(data) {
    if (!data || !data.waveform) {
        waveformData = [];
        waveformDuration = 0;
        drawWaveform();
        return;
    }
    waveformData = data.waveform;
    waveformDuration = data.duration;
    drawWaveform();
}

let lastKnownPosition = 0;
let lastStatusAt = 0;

function updateProgress(position) {
    if (isDraggingWaveform) return;
    // Если UI только что отправил запрос — не принимаем обновления
    if (playBusy) return;
    currentPosition = Math.max(0, Math.min(1, position));
    drawWaveform();
}

function drawWaveform() {
    if (!canvas || !ctx) return;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const dpr = window.devicePixelRatio || 1;

    if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(dpr, dpr);
    }

    ctx.clearRect(0, 0, width, height);

    if (!waveformData || waveformData.length === 0) {
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-muted') || '#3a4a6a';
        ctx.font = '14px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('🎵 Нет трека', width / 2, height / 2);
        return;
    }

    const centerY = height / 2;
    const maxVal = Math.max(...waveformData);
    const scale = maxVal > 0 ? 1 / maxVal : 1;

    ctx.beginPath();
    ctx.moveTo(0, centerY);
    for (let i = 0; i < waveformData.length; i++) {
        const x = (i / waveformData.length) * width;
        const y = centerY - (waveformData[i] * scale * height * 0.42);
        ctx.lineTo(x, y);
    }
    ctx.lineTo(width, centerY);
    ctx.closePath();
    ctx.fillStyle = '#4a5a8a';
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(0, centerY);
    for (let i = 0; i < waveformData.length; i++) {
        const x = (i / waveformData.length) * width;
        const y = centerY + (waveformData[i] * scale * height * 0.42);
        ctx.lineTo(x, y);
    }
    ctx.lineTo(width, centerY);
    ctx.closePath();
    ctx.fillStyle = '#2a3a6a';
    ctx.fill();

    if (currentPosition > 0) {
        const progressWidth = currentPosition * width;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, progressWidth, height);
        ctx.clip();

        ctx.beginPath();
        ctx.moveTo(0, centerY);
        for (let i = 0; i < waveformData.length; i++) {
            const x = (i / waveformData.length) * width;
            const y = centerY - (waveformData[i] * scale * height * 0.42);
            ctx.lineTo(x, y);
        }
        ctx.lineTo(progressWidth, centerY);
        ctx.closePath();
        ctx.fillStyle = '#6c8cff';
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(0, centerY);
        for (let i = 0; i < waveformData.length; i++) {
            const x = (i / waveformData.length) * width;
            const y = centerY + (waveformData[i] * scale * height * 0.42);
            ctx.lineTo(x, y);
        }
        ctx.lineTo(progressWidth, centerY);
        ctx.closePath();
        ctx.fillStyle = '#4a6cff';
        ctx.fill();
        ctx.restore();
    }
}

function doSeek(e) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    let x = (e.clientX - rect.left) / rect.width;
    x = Math.max(0, Math.min(1, x));
    currentPosition = x;
    drawWaveform();
    if (waveformDuration > 0) {
        const timeElement = document.getElementById('trackTime');
        if (timeElement) {
            timeElement.textContent = `${formatTime(currentPosition * waveformDuration)} / ${formatTime(waveformDuration)}`;
        }
    }
}

function applySeek() {
    if (!apiReady) return;
    if (currentPosition >= 0.98) {
        api.call('stop').then(() => {
            currentPosition = 0;
            drawWaveform();
            loadStatus();
        }).catch(() => {});
        return;
    }
    if (currentPosition <= 0.02) {
        api.call('seek', 0).then(() => api.call('play')).then(loadStatus).catch(() => {});
        return;
    }
    api.call('seek', currentPosition).then(loadStatus).catch(() => {});
}

function formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// ============================================================
// ===== РЕНДЕР ПЛЕЙЛИСТОВ ====================================
// ============================================================
function renderPlaylists(playlistsData, currentPlaylist) {
    const container = document.getElementById('playlistList');
    console.log('[renderPlaylists]', playlistsData, currentPlaylist);
    if (!container) return;
    container.innerHTML = '';

    const names = Object.keys(playlistsData || {});
    if (names.length === 0) {
        container.innerHTML = '<li class="playlist-item empty-state">Нет плейлистов</li>';
        return;
    }

    // Сортируем: сначала обычные (по алфавиту), потом виртуальные (по алфавиту)
    const regular = names.filter(n => !playlistsData[n].is_virtual).sort((a, b) => a.localeCompare(b));
    const virtual = names.filter(n => playlistsData[n].is_virtual).sort((a, b) => a.localeCompare(b));
    const ordered = [...regular, ...virtual];

    ordered.forEach(name => {
        const info = playlistsData[name];
        const li = document.createElement('li');
        li.className = 'playlist-item';
        if (name === currentPlaylist) li.classList.add('active');
        if (info.is_virtual) li.classList.add('virtual');

        const left = document.createElement('span');
        left.className = 'playlist-left';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'playlist-name';
        nameSpan.textContent = name;
        if (info.is_virtual) nameSpan.title = 'Виртуальный плейлист (только для чтения)';

        const countSpan = document.createElement('span');
        countSpan.className = 'count';
        countSpan.textContent = info.count;

        left.appendChild(nameSpan);
        left.appendChild(countSpan);
        left.onclick = (e) => {
            e.stopPropagation();
            switchPlaylist(name);
        };

        li.appendChild(left);

        if (!info.is_virtual) {
            const del = document.createElement('span');
            del.className = 'playlist-delete';
            del.textContent = '✕';
            del.title = `Удалить плейлист "${name}"`;
            del.onclick = (e) => {
                e.stopPropagation();
                deletePlaylist(name);
            };
            if (regular.length <= 1) del.style.display = 'none';
            li.appendChild(del);
        }

        container.appendChild(li);
    });
}

// ============================================================
// ===== РЕНДЕР СПИСКА ТРЕКОВ =================================
// ============================================================
function renderTrackList(list, status) {
    const container = document.getElementById('trackList');
    if (!container) return;

    tracks = list || [];
    container.innerHTML = '';

    if (!tracks.length) {
        container.innerHTML = '<li class="track-item empty">Перетащи трек или директорию сюда</li>';
        return;
    }

    const isVirtual = status && status.playlists && status.playlists[status.playlist] &&
                      status.playlists[status.playlist].is_virtual;

    tracks.forEach((track, index) => {
        const li = document.createElement('li');
        li.className = 'track-item';
        if (index === status.index) li.classList.add('active');
        li.dataset.path = track.id;

        // --- Обложка ---
        const cover = document.createElement('div');
        cover.className = 'track-cover';
        if (track.cover) {
            const img = document.createElement('img');
            img.src = track.cover;
            img.alt = '';
            img.loading = 'lazy';
            cover.appendChild(img);
        } else {
            cover.innerHTML = '<span class="cover-placeholder">♪</span>';
        }

        // --- Номер ---
        const indexSpan = document.createElement('span');
        indexSpan.className = 'track-index';
        indexSpan.textContent = index + 1;

        // --- Инфо ---
        const infoWrapper = document.createElement('div');
        infoWrapper.className = 'track-info-list';

        const titleWrap = document.createElement('div');
        titleWrap.className = 'track-name-wrapper-list';

        const titleSpan = document.createElement('span');
        titleSpan.className = 'track-name-text-list';
        titleSpan.textContent = track.title || track.stem;
        titleSpan.dataset.title = track.title || track.stem;
        titleSpan.dataset.path = track.id;

        titleWrap.appendChild(titleSpan);

        const subSpan = document.createElement('span');
        subSpan.className = 'track-subline-list';
        const parts = [];
        if (track.artist) parts.push(track.artist);
        if (track.album) parts.push(track.album);
        subSpan.textContent = parts.join(' • ');

        infoWrapper.appendChild(titleWrap);
        if (parts.length) infoWrapper.appendChild(subSpan);

        // --- Сердечко ---
        const favBtn = document.createElement('span');
        favBtn.className = 'track-fav' + (track.favorite ? ' active' : '');
        favBtn.textContent = track.favorite ? '♥' : '♡';
        favBtn.title = track.favorite ? 'Убрать из избранного' : 'В избранное';
        favBtn.onclick = (e) => {
            e.stopPropagation();
            toggleFavorite(track.id);
        };

        // --- Крестик ---
        const deleteBtn = document.createElement('span');
        deleteBtn.className = 'track-delete';
        deleteBtn.textContent = '✕';
        deleteBtn.title = 'Удалить из плейлиста';
        deleteBtn.onclick = (e) => {
            e.stopPropagation();
            deleteTrackFromPlaylist(track.id, index);
        };

        li.appendChild(cover);
        li.appendChild(indexSpan);
        li.appendChild(infoWrapper);
        li.appendChild(favBtn);
        li.appendChild(deleteBtn);

        li.onclick = () => playTrack(index);
        li.oncontextmenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            openContextMenu(e.clientX, e.clientY, track, index, isVirtual);
        };
        container.appendChild(li);
    });
}

// ============================================================
// ===== INLINE ПЕРЕИМЕНОВАНИЕ ================================
// ============================================================
function startRename(path, spanEl) {
    if (editingTrackPath) return;
    editingTrackPath = path;

    const original = spanEl.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'track-rename-input';
    input.value = original;

    spanEl.replaceWith(input);
    input.focus();
    input.select();

    let finished = false;
    const finish = async (save) => {
        if (finished) return;
        finished = true;
        editingTrackPath = null;
        const newTitle = input.value.trim();
        if (save && newTitle && newTitle !== original) {
            try {
                await api.call('rename_track', path, newTitle);
            } catch (e) {
                console.error(e);
            }
        }
        // вернём span и перерисуем
        await loadStatus();
    };

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
}

// ============================================================
// ===== РЕНДЕР ПЛЕЕРА ========================================
// ============================================================
function renderPlayer(status) {
    const info = status.track_info || {};
    const nameEl = document.getElementById('trackName');
    const artistEl = document.getElementById('trackArtist');
    const albumEl = document.getElementById('trackAlbum');
    const dotEl = document.getElementById('trackDot');
    const favBtn = document.getElementById('favBtn');
    const coverEl = document.getElementById('playerCover');

    if (info.title) {
        nameEl.textContent = info.title;
        nameEl.setAttribute('data-text', info.title);
        nameEl.className = 'track-name-player';
        setupMarquee(nameEl);

        artistEl.textContent = info.artist || '';
        albumEl.textContent = info.album || '';
        dotEl.hidden = !(info.artist && info.album);

        if (info.cover) {
            coverEl.innerHTML = `<img src="${info.cover}" alt="">`;
        } else {
            coverEl.innerHTML = '<span class="cover-placeholder">♪</span>';
        }

        favBtn.textContent = info.favorite ? '♥' : '♡';
        favBtn.classList.toggle('active', !!info.favorite);
        favBtn.dataset.path = info.id || '';
    } else {
        nameEl.textContent = 'Нет треков';
        nameEl.setAttribute('data-text', '');
        nameEl.className = 'track-name-player empty';
        nameEl.classList.remove('marquee-active');
        artistEl.textContent = '';
        albumEl.textContent = '';
        dotEl.hidden = true;
        favBtn.textContent = '♡';
        favBtn.classList.remove('active');
        favBtn.dataset.path = '';
        coverEl.innerHTML = '<span class="cover-placeholder">♪</span>';
    }

    const playBtn = document.getElementById('playBtn');
    if (status.playing) {
        playBtn.textContent = '⏸';
        playBtn.className = 'ctrl-btn play-btn playing';
        playBtn.title = 'Пауза';
    } else {
        playBtn.textContent = '▶';
        playBtn.className = 'ctrl-btn play-btn';
        playBtn.title = 'Воспроизвести';
    }

    // Shuffle / Repeat — стилизация как было, оставил без изменений логики
    const shuffleBtn = document.getElementById('shuffleBtn');
    const repeatBtn = document.getElementById('repeatBtn');
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';

    if (status.shuffle) {
        shuffleBtn.style.backgroundColor = isLight ? 'rgb(189,189,189)' : 'rgba(128,255,128,0.05)';
        shuffleBtn.style.color = isLight ? '#4A6CF7' : '#4ade80';
        shuffleBtn.style.borderColor = isLight ? '#d0d0d0' : 'rgba(74,222,128,0.3)';
    } else {
        shuffleBtn.style.backgroundColor = isLight ? 'rgba(232,232,232,0.5)' : 'rgba(20,25,50,0.4)';
        shuffleBtn.style.color = isLight ? '#999' : '#7a8aaa';
        shuffleBtn.style.borderColor = isLight ? '#d0d0d0' : 'rgba(100,120,255,.04)';
    }

    const repeatModes = ['🔁', '🔂', '🔁'];
    const repeatTitles = ['Повтор выключен', 'Повтор одного трека', 'Повтор всех треков'];
    repeatBtn.textContent = repeatModes[status.repeat] || '🔁';
    repeatBtn.title = repeatTitles[status.repeat] || 'Повтор выключен';

    if (status.repeat === 0) {
        repeatBtn.style.backgroundColor = isLight ? 'rgba(232,232,232,0.5)' : 'rgba(20,25,50,0.2)';
        repeatBtn.style.color = isLight ? '#999' : '#7a8aaa';
        repeatBtn.style.borderColor = isLight ? '#d0d0d0' : 'rgba(100,120,255,.04)';
    } else {
        repeatBtn.style.backgroundColor = isLight ? 'rgb(189,189,189)' : 'rgba(128,128,255,0.05)';
        repeatBtn.style.color = isLight ? '#4A6CF7' : '#7c8cff';
        repeatBtn.style.borderColor = isLight ? '#d0d0d0' : 'rgba(124,140,255,0.3)';
    }

    // Тайминг
    const timeElement = document.getElementById('trackTime');
    if (timeElement) {
        const total = info.duration || waveformDuration || 0;
        const pos = status.position * total;
        timeElement.textContent = `${formatTime(pos)} / ${formatTime(total)}`;
    }

    document.getElementById('trackCount').textContent = status.total || 0;
}
function applySettingsToUI(settings) {
    if (!settings) return;
    if (settings.accent) {
        document.documentElement.style.setProperty('--accent', settings.accent);
        const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(settings.accent);
        if (m) {
            const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
            document.documentElement.style.setProperty('--accent-dim', `rgba(${r},${g},${b},0.12)`);
            document.documentElement.style.setProperty('--accent-glow', `rgba(${r},${g},${b},0.15)`);
            document.documentElement.style.setProperty('--border-active', `rgba(${r},${g},${b},0.3)`);
        }
    }
    if (settings.cover_size) {
        document.body.setAttribute('data-cover-size', settings.cover_size);
    }
}
// ============================================================
// ===== ЗАГРУЗКА СТАТУСА =====================================
// ============================================================
async function loadStatus() {
    if (!apiReady) return;
    try {
        const status = await api.call('get_status');
        currentStatus = status;
        applySettingsToUI(status.settings);
        renderPlayer(status);

        // ← ВОТ ЭТУ СТРОКУ ДОБАВИТЬ
        renderPlaylists(status.playlists, status.playlist);

        const list = await api.call('get_playlist_tracks');
        renderTrackList(list, status);

        const volSlider = document.getElementById('volumeSlider');
        const volValue = document.getElementById('volumeValue');
        if (volSlider && document.activeElement !== volSlider) {
            volSlider.value = status.volume;
            volValue.textContent = status.volume + '%';
        }
    } catch (e) {
        console.error('loadStatus error:', e);
    }
}

async function loadPlaylists() {
    if (!apiReady) return;
    try {
        const data = await api.call('get_playlists');
        const status = await api.call('get_status');
        renderPlaylists(data, status.playlist);
    } catch (e) {
        console.error(e);
    }
}

// ============================================================
// ===== ДЕЙСТВИЯ =============================================
// ============================================================
function playTrack(index) {
    if (!apiReady) return;
    api.call('play', index).then(loadStatus).catch(console.error);
}
let playBusy = false;

async function togglePlay() {
    if (!apiReady || playBusy) return;
    playBusy = true;
    try {
        await api.call('pause');
        await loadStatus();
    } catch (e) {
        console.error(e);
    } finally {
        playBusy = false;
    }
}
function stopTrack() {
    if (!apiReady) return;
    api.call('stop').then(loadStatus).catch(console.error);
}
function nextTrack() {
    if (!apiReady) return;
    api.call('next').then(loadStatus).catch(console.error);
}
function previousTrack() {
    if (!apiReady) return;
    api.call('previous').then(loadStatus).catch(console.error);
}
function toggleShuffle() {
    if (!apiReady) return;
    api.call('shuffle').then(loadStatus).catch(console.error);
}
function toggleRepeat() {
    if (!apiReady) return;
    api.call('toggle_repeat').then(loadStatus).catch(console.error);
}
function setVolume(value) {
    const vol = parseInt(value);
    document.getElementById('volumeValue').textContent = vol + '%';
    if (apiReady) api.call('set_volume', vol).catch(console.error);
}

async function toggleFavorite(path) {
    if (!apiReady || !path) return;
    try {
        await api.call('toggle_favorite', path);
        await loadStatus();
    } catch (e) {
        console.error(e);
    }
}

function toggleCurrentFavorite() {
    const btn = document.getElementById('favBtn');
    const path = btn.dataset.path;
    if (path) toggleFavorite(path);
}

async function switchPlaylist(name) {
    if (!apiReady) return;
    try {
        await api.call('switch_playlist', name);
        await loadStatus();
    } catch (e) {
        console.error(e);
    }
}

async function deletePlaylist(name) {
    if (!apiReady) return;
    if (!confirm(`Удалить плейлист "${name}"?`)) return;
    try {
        const ok = await api.call('delete_playlist', name);
        if (ok) await loadStatus();
        else alert('Нельзя удалить последний плейлист');
    } catch (e) {
        console.error(e);
    }
}

async function deleteTrackFromPlaylist(path, index) {
    if (!apiReady) return;
    if (!confirm('Удалить этот трек из плейлиста?')) return;
    try {
        // Если плейлист виртуальный — удаление по индексу не сработает;
        // там треки удаляются только через сердечко.
        const ok = await api.call('remove_from_playlist_by_path', currentStatus.playlist, path);
        if (ok) await loadStatus();
        else alert('Не удалось удалить трек (возможно, виртуальный плейлист).');
    } catch (e) {
        console.error(e);
    }
}

// ============================================================
// ===== МОДАЛЬНОЕ ОКНО =======================================
// ============================================================
function showModal() {
    document.getElementById('modalOverlay').classList.add('active');
    document.getElementById('modalInput').value = '';
    setTimeout(() => document.getElementById('modalInput').focus(), 100);
}
function closeModal() {
    document.getElementById('modalOverlay').classList.remove('active');
}
async function confirmCreate() {
    const input = document.getElementById('modalInput');
    const name = input.value.trim();
    if (!name) { alert('Введите название'); return; }
    if (!apiReady) return;
    try {
        const ok = await api.call('create_playlist', name);
        if (ok) {
            closeModal();
            await loadStatus();
            await switchPlaylist(name);
        } else {
            alert('Плейлист с таким названием уже существует');
        }
    } catch (e) { console.error(e); }
}

// ============================================================
// ===== ДОБАВЛЕНИЕ ФАЙЛОВ ====================================
// ============================================================
async function openFileDialog() {
    if (!apiReady) return;
    try {
        const paths = await api.call('open_file_dialog');
        if (paths && paths.length) await addFilesToPlaylist(paths);
    } catch (e) { console.error(e); }
}

async function addFilesToPlaylist(filePaths) {
    if (!filePaths || !filePaths.length) return;
    if (!apiReady) return;
    try {
        const status = await api.call('get_status');
        const playlist = status.playlist;
        await api.call('add_files_to_playlist', playlist, filePaths);
        await loadStatus();
    } catch (e) { console.error(e); }
}

function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// ============================================================
// ===== DRAG & DROP ==========================================
// ============================================================
function setupDragAndDrop() {
    const dropOverlay = document.getElementById('dropOverlay');

    document.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (dropOverlay && !dropOverlay.classList.contains('active')) {
            dropOverlay.classList.add('active');
        }
    });

    document.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (dropOverlay) dropOverlay.classList.remove('active');
    });

    document.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (dropOverlay) dropOverlay.classList.remove('active');
        if (!apiReady) return;

        try {
            const result = await api.call('get_dropped_folder_path');
            if (result && result.path) {
                const folderName = result.name || 'Unknown';
                if (result.is_folder) {
                    await api.call('create_playlist', folderName);
                    await api.call('switch_playlist', folderName);
                    const scan = await api.call('scan_folder_for_audio', result.path);
                    if (scan && scan.files && scan.files.length) {
                        await api.call('add_files_to_playlist', folderName, scan.files);
                        await loadStatus();
                    } else {
                        alert('В этой папке нет аудиофайлов');
                    }
                } else if (result.is_file) {
                    const status = await api.call('get_status');
                    await api.call('add_files_to_playlist', status.playlist, [result.path]);
                    await loadStatus();
                }
                return;
            }

            // Fallback: файлы из dataTransfer
            const dt = e.dataTransfer;
            if (dt && dt.files && dt.files.length) {
                const files = Array.from(dt.files);
                const audioFiles = files.filter(f => /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus|wma|aiff|aif|alac|ape|wv|tta|caf|au|mka|ac3|dts|mid|midi|mod|xm|it|s3m|m4b|ra|rm)$/i.test(f.name));
                if (audioFiles.length) {
                    const filesData = await Promise.all(
                        audioFiles.map(f => readFileAsDataURL(f).then(data => ({ name: f.name, data })))
                    );
                    await api.call('add_files_from_data', filesData);
                    await loadStatus();
                }
            }
        } catch (err) {
            console.error('drop error:', err);
            alert('Ошибка при обработке. Убедитесь, что объект выделен в Finder.');
        }
    });
}

// ============================================================
// ===== ГОРЯЧИЕ КЛАВИШИ ======================================
// ============================================================
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;

    switch (e.key) {
        case ' ':
            e.preventDefault();
            togglePlay();
            break;
        case 'ArrowRight': nextTrack(); break;
        case 'ArrowLeft': previousTrack(); break;
        case 'ArrowUp': {
            const v = Math.min(100, parseInt(document.getElementById('volumeSlider').value) + 5);
            document.getElementById('volumeSlider').value = v;
            setVolume(v);
            break;
        }
        case 'ArrowDown': {
            const v = Math.max(0, parseInt(document.getElementById('volumeSlider').value) - 5);
            document.getElementById('volumeSlider').value = v;
            setVolume(v);
            break;
        }
        case 'r': case 'R': toggleRepeat(); break;
        case 'b': case 'B': toggleSidebar(); break;
        case 's': case 'S': toggleShuffle(); break;
    }
});

// ============================================================
// ===== САЙДБАР ==============================================
// ============================================================
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const content = document.querySelector('.content');
    sidebar.classList.toggle('hidden');
    requestAnimationFrame(() => {
        const mainRect = document.querySelector('.main').getBoundingClientRect();
        const sidebarWidth = sidebar.classList.contains('hidden') ? 0 : sidebar.offsetWidth;
        const gap = 12;
        content.style.width = `${mainRect.width - sidebarWidth - gap}px`;
    });
}

// ============================================================
// ===== КОНТЕКСТНОЕ МЕНЮ =====================================
// ============================================================
let ctxTarget = null; // { track, index, isVirtual }

function openContextMenu(x, y, track, index, isVirtual) {
    const menu = document.getElementById('ctxMenu');
    if (!menu) return;

    ctxTarget = { track, index, isVirtual };

    // Обновляем текст и доступность пунктов
    menu.querySelector('[data-action="favorite"]').textContent =
        track.favorite ? '♡ Убрать из избранного' : '♥ В избранное';

    const renameItem = menu.querySelector('[data-action="rename"]');
    const artistItem = menu.querySelector('[data-action="artist"]');
    const albumItem  = menu.querySelector('[data-action="album"]');
    const deleteItem = menu.querySelector('[data-action="delete"]');

    if (isVirtual) {
        // В виртуальных плейлистах нельзя ни переименовывать трек, ни удалять его из списка
        renameItem.classList.add('disabled');
        artistItem.classList.add('disabled');
        albumItem.classList.add('disabled');
        deleteItem.classList.add('disabled');
    } else {
        renameItem.classList.remove('disabled');
        artistItem.classList.remove('disabled');
        albumItem.classList.remove('disabled');
        deleteItem.classList.remove('disabled');
    }

    // Позиционируем с учётом краёв экрана
    menu.hidden = false;
    menu.style.left = '0px';
    menu.style.top = '0px';
    const rect = menu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 8;
    const maxY = window.innerHeight - rect.height - 8;
    menu.style.left = Math.min(x, maxX) + 'px';
    menu.style.top = Math.min(y, maxY) + 'px';
}

function closeContextMenu() {
    const menu = document.getElementById('ctxMenu');
    if (menu) menu.hidden = true;
    ctxTarget = null;
}

// Обработчик кликов по пунктам меню
document.addEventListener('click', (e) => {
    const item = e.target.closest('.ctx-item');
    if (!item) {
        closeContextMenu();
        return;
    }
    if (item.classList.contains('disabled')) return;
    if (!ctxTarget) return;

    const action = item.dataset.action;
    const { track, index, isVirtual } = ctxTarget;
    const path = track.id;
    closeContextMenu();

    switch (action) {
        case 'rename':
            promptRenameTrack(path, track.title || track.stem);
            break;
        case 'artist':
            promptSetField(path, 'artist', 'Исполнитель', track.artist || '');
            break;
        case 'album':
            promptSetField(path, 'album', 'Альбом', track.album || '');
            break;
        case 'favorite':
            toggleFavorite(path);
            break;
        case 'delete':
            deleteTrackFromPlaylist(path, index);
            break;
    }
});

// Закрытие при клике в любом другом месте и по Escape
document.addEventListener('contextmenu', (e) => {
    // Если клик не по треку — закроем открытое меню
    if (!e.target.closest('.track-item')) closeContextMenu();
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeContextMenu();
});
window.addEventListener('blur', closeContextMenu);
window.addEventListener('resize', closeContextMenu);

// ============================================================
// ===== ДИАЛОГИ ДЛЯ ПОЛЕЙ ====================================
// ============================================================
function promptRenameTrack(path, current) {
    const value = prompt('Новое название трека:', current || '');
    if (value === null) return;
    const trimmed = value.trim();
    if (!trimmed) {
        // Пусто → сброс кастомного названия, вернётся тег/имя файла
        api.call('reset_track_title', path).then(loadStatus).catch(console.error);
        return;
    }
    api.call('rename_track', path, trimmed).then(loadStatus).catch(console.error);
}

function promptSetField(path, field, label, current) {
    const value = prompt(`${label}:`, current || '');
    if (value === null) return;
    const trimmed = value.trim();
    // Пустая строка → сброс поля (вернётся значение из тега)
    api.call('set_track_meta', path, { [field]: trimmed || null })
        .then(loadStatus)
        .catch(console.error);
}

// ============================================================
// ===== ИНИЦИАЛИЗАЦИЯ ========================================
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    waitForApi(async () => {
        await loadStatus();
        setupDragAndDrop();
        initWaveform();

        // Применяем сохранённую тему
        try {
            const settings = await api.call('get_settings');
            if (settings && settings.theme && typeof window.switchTheme === 'function') {
                window.switchTheme(settings.theme, false);
            }
        } catch (e) {}

        // Периодический опрос позиции
setInterval(async () => {
    if (!apiReady || playBusy) return;
    try {
        const status = await api.call('get_status');
        currentStatus = status;
        if (status.track_info && status.track_info.duration) {
            const total = status.track_info.duration;
            const timeEl = document.getElementById('trackTime');
            if (timeEl) {
                timeEl.textContent = `${formatTime(status.position * total)} / ${formatTime(total)}`;
            }
        }
        updateProgress(status.position);
    } catch (e) {}
}, 1000);
    });
});

// ============================================================
// ===== ТУЛТИПЫ ==============================================
// ============================================================
(function initTooltips() {
    tooltip = document.createElement('div');
    tooltip.className = 'tooltip-custom';
    document.body.appendChild(tooltip);

    const list = document.getElementById('trackList');
    if (!list) return;

    let timeout = null;
    let active = null;

    list.addEventListener('mousemove', (e) => {
        const target = e.target.closest('.track-name-text-list');
        if (!target && tooltip) {
            clearTimeout(timeout);
            tooltip.style.display = 'none';
            active = null;
        }
    });

    list.addEventListener('mouseenter', (e) => {
        const target = e.target.closest('.track-name-text-list');
        if (!target) return;
        if (active !== target) {
            clearTimeout(timeout);
            tooltip.style.display = 'none';
            active = target;
        }
        timeout = setTimeout(() => {
            if (tooltip && active) {
                tooltip.textContent = active.dataset.title;
                const r = active.getBoundingClientRect();
                tooltip.style.left = (r.left + r.width / 2 - tooltip.offsetWidth / 2) + 'px';
                tooltip.style.top = (r.bottom + 8) + 'px';
                tooltip.style.display = 'block';
            }
        }, 700);
    }, true);

    list.addEventListener('mouseleave', () => {
        clearTimeout(timeout);
        if (tooltip) tooltip.style.display = 'none';
        active = null;
    });
})();