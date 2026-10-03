import os
import vlc
import json
import time
import threading
import random
import hashlib
from pathlib import Path
from datetime import datetime

try:
    from tinytag import TinyTag
except ImportError:
    TinyTag = None


# ============================================================
# ===== ПОДДЕРЖИВАЕМЫЕ АУДИОФОРМАТЫ ==========================
# ============================================================
AUDIO_EXTENSIONS = {
    # lossy
    '.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wma', '.mpc', '.amr',
    # lossless
    '.flac', '.wav', '.aiff', '.aif', '.alac', '.ape', '.wv', '.tta',
    '.dsf', '.dff', '.caf', '.au',
    # прочее, что играет VLC
    '.mka', '.ac3', '.dts', '.mid', '.midi', '.mod', '.xm', '.it', '.s3m',
    '.m4b', '.ra', '.rm',
}


def is_audio_file(path):
    if not path:
        return False
    return Path(path).suffix.lower() in AUDIO_EXTENSIONS


class MusicPlayer:
    def __init__(self, index_file="playlists.json", state_file="state.json",
                 metadata_file="metadata.json", base_dir=None):
        # base_dir ОБЯЗАТЕЛЬНО передаётся из app.py — там мы точно знаем,
        # запущены мы из .app или из исходников.
        if base_dir is None:
            # Fallback на случай прямого запуска MusicPlayer без app.py
            import sys
            if getattr(sys, 'frozen', False):
                self.base_dir = Path.home() / 'Library' / 'Application Support' / 'MusicPlayer'
            else:
                self.base_dir = Path(__file__).parent
        else:
            self.base_dir = Path(base_dir)

        self.base_dir.mkdir(parents=True, exist_ok=True)

        self.vlc_instance = vlc.Instance()
        self.player = self.vlc_instance.media_player_new()

        self.index_file = self.base_dir / index_file
        self.state_file = self.base_dir / state_file
        self.metadata_file = self.base_dir / metadata_file
        self.covers_dir = self.base_dir / "covers"
        self.covers_dir.mkdir(exist_ok=True)

        self.playlists = {}
        self.current_playlist = None
        self.tracks = []
        self.current_index = -1
        self._current_track_path = None
        self._saved_position = 0.0

        self.repeat_mode = 0
        self.is_playing = False
        self._shuffle = False
        self._shuffle_order = []
        self._shuffle_index = -1

        self._theme = 'dark'
        self._eq_enabled = True
        self._eq_values = [0.0] * 10

        # ---- Настройки ----
        self._accent = '#7c8cff'
        self._cover_size = 'medium'
        self._eq_profile = 'Flat'
        self._custom_profiles = {}
        self._waveform_enabled = True
        self._waveform_points = 2000
        self._playlist_limit = 1000
        self._resume_on_start = True

        self.update_callback = None
        self.event_manager = None
        self._lock = threading.Lock()

        # Метаданные
        self.metadata = {}
        self._tag_cache = {}

        # Отложенная запись metadata.json
        self._meta_dirty = False
        self._meta_last_save = 0.0
        self._meta_save_interval = 5.0

        # Отложенная запись state.json
        self._state_dirty = False
        self._state_last_save = 0.0
        self._state_save_interval = 5.0

        # Виртуальные плейлисты
        self.VIRTUAL_FAVORITES = "⭐ Избранное"
        self.VIRTUAL_MOST_PLAYED = "🔥 Часто прослушиваемое"
        self.VIRTUAL_NAMES = {self.VIRTUAL_FAVORITES, self.VIRTUAL_MOST_PLAYED}
        self.MOST_PLAYED_LIMIT = 50

        self.load_index()
        self._load_metadata()
        self._load_state()
        self._prepare_media()

    def get_time_ms(self):
        """Текущая позиция в миллисекундах."""
        # Если играем — доверяем VLC
        if self.is_playing and self.player:
            try:
                t = self.player.get_time()
                if t is not None and t >= 0:
                    return int(t)
            except Exception:
                pass

        # Если на паузе (или ещё не играли) — берём из _saved_position
        d = self.get_duration_ms()
        if d > 0 and self._saved_position > 0:
            return int(self._saved_position * d)

        # Fallback на VLC (на случай, если _saved_position = 0, но VLC знает)
        if self.player:
            try:
                t = self.player.get_time()
                if t is not None and t >= 0:
                    return int(t)
            except Exception:
                pass
        return 0

    def get_duration_ms(self):
        """Длительность текущего медиа в миллисекундах."""
        if self.player:
            try:
                d = self.player.get_length()
                if d is not None and d > 0:
                    return int(d)
            except Exception:
                pass
        # Fallback из тегов
        if self._current_track_path:
            tags = self._tag_cache.get(self._current_track_path)
            if tags and tags.get('duration', 0) > 0:
                return int(tags['duration'] * 1000)
        return -1

    def seek_ms(self, ms):
        """Точная перемотка в миллисекундах."""
        if not self.player:
            return False
        try:
            self.player.set_time(int(ms))
        except Exception:
            return False
        d = self.get_duration_ms()
        if d > 0:
            self._saved_position = max(0.0, min(1.0, ms / d))
        self._save_state()
        return True

    # ==================== ПЛЕЙЛИСТЫ ====================

    def load_index(self):
        if self.index_file.exists():
            try:
                with open(self.index_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    self.playlists = data.get('playlists', {})
                    for name in list(self.playlists.keys()):
                        self.playlists[name] = [
                            p for p in self.playlists[name] if os.path.exists(p)
                        ]
                        if not self.playlists[name] and len(self.playlists) > 1:
                            del self.playlists[name]
            except Exception as e:
                print(f"❌ Ошибка загрузки: {e}")
                self._create_empty()
        else:
            self._create_empty()

        if not self.playlists:
            self._create_empty()

    def _create_empty(self):
        self.playlists = {'основной': []}
        self.current_playlist = 'основной'
        self.tracks = []
        self.current_index = -1
        self._save_index()

    def _save_index(self):
        try:
            data = {'playlists': self.playlists, 'last_updated': time.time()}
            with open(self.index_file, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"❌ Ошибка сохранения: {e}")

    # ==================== МЕТАДАННЫЕ ====================

    def _load_metadata(self):
        if self.metadata_file.exists():
            try:
                with open(self.metadata_file, 'r', encoding='utf-8') as f:
                    self.metadata = json.load(f) or {}
            except Exception as e:
                print(f"❌ Ошибка загрузки metadata.json: {e}")
                self.metadata = {}
        else:
            self.metadata = {}
            self._save_metadata(force=True)

    def _save_metadata(self, force=False):
        now = time.time()
        if not force and not self._meta_dirty:
            return
        if not force and (now - self._meta_last_save) < self._meta_save_interval:
            return
        try:
            with open(self.metadata_file, 'w', encoding='utf-8') as f:
                json.dump(self.metadata, f, indent=2, ensure_ascii=False)
            self._meta_dirty = False
            self._meta_last_save = now
        except Exception as e:
            print(f"❌ Ошибка сохранения metadata.json: {e}")

    def _mark_meta_dirty(self):
        self._meta_dirty = True
        self._save_metadata()

    def _meta_for(self, path):
        if path not in self.metadata:
            self.metadata[path] = {}
        return self.metadata[path]

    # ---------- Теги ----------

    def _extract_tags(self, path):
        if path in self._tag_cache:
            return self._tag_cache[path]

        fallback = {
            'title': Path(path).stem,
            'artist': '',
            'album': '',
            'duration': 0.0,
            'cover': None,
            'year': '',
            'genre': '',
        }

        if TinyTag is None:
            self._tag_cache[path] = fallback
            return fallback

        try:
            tag = TinyTag.get(path, image=True)
            info = {
                'title': (tag.title or '').strip() or Path(path).stem,
                'artist': (tag.artist or '').strip(),
                'album': (tag.album or '').strip(),
                'duration': float(tag.duration or 0.0),
                'year': str(tag.year or ''),
                'genre': (tag.genre or '').strip(),
                'cover': None,
            }
            try:
                img = tag.get_image()
            except Exception:
                img = None
            if img:
                info['cover'] = self._save_cover(path, img)
            self._tag_cache[path] = info
            return info
        except Exception:
            self._tag_cache[path] = fallback
            return fallback

    def _save_cover(self, path, image_bytes):
        if not image_bytes:
            return None
        h = hashlib.md5(str(path).encode('utf-8')).hexdigest()
        ext = 'jpg'
        if image_bytes[:8] == b'\x89PNG\r\n\x1a\n':
            ext = 'png'
        elif image_bytes[:3] == b'GIF':
            ext = 'gif'
        filename = f"{h}.{ext}"
        full = self.covers_dir / filename
        if not full.exists():
            try:
                with open(full, 'wb') as f:
                    f.write(image_bytes)
            except Exception as e:
                print(f"⚠️ Не удалось сохранить обложку: {e}")
                return None
        return f"covers/{filename}"

    # ---------- Объединённая информация ----------

    def get_track_info(self, path):
        if not path:
            return None
        tags = self._extract_tags(path)
        meta = self.metadata.get(path, {}) or {}

        title = meta.get('custom_title') or tags['title']
        artist = meta['artist'] if 'artist' in meta else tags['artist']
        album = meta['album'] if 'album' in meta else tags['album']
        cover = meta.get('cover') or tags['cover']

        return {
            'id': path,
            'filename': Path(path).name,
            'stem': Path(path).stem,
            'title': title,
            'artist': artist or '',
            'album': album or '',
            'cover': cover,
            'duration': tags['duration'],
            'year': tags.get('year', ''),
            'genre': tags.get('genre', ''),
            'favorite': bool(meta.get('favorite', False)),
            'play_count': int(meta.get('play_count', 0)),
            'last_played': meta.get('last_played'),
            'custom_title': meta.get('custom_title'),
        }

    def get_track_info_by_index(self, index):
        if 0 <= index < len(self.tracks):
            return self.get_track_info(self.tracks[index])
        return None

    # ---------- Правки метаданных ----------

    def set_track_meta(self, path, **fields):
        if not path:
            return False
        meta = self._meta_for(path)
        for key, value in fields.items():
            if value is None or value == '':
                meta.pop(key, None)
            else:
                meta[key] = value
        if not meta:
            self.metadata.pop(path, None)
        self._mark_meta_dirty()
        if self.update_callback:
            self.update_callback()
        return True

    def rename_track(self, path, new_title):
        new_title = (new_title or '').strip()
        if not new_title:
            return False
        return self.set_track_meta(path, custom_title=new_title)

    def reset_track_title(self, path):
        return self.set_track_meta(path, custom_title=None)

    def toggle_favorite(self, path):
        if not path:
            return False
        meta = self._meta_for(path)
        new_val = not bool(meta.get('favorite', False))
        meta['favorite'] = new_val
        self._mark_meta_dirty()
        if self.update_callback:
            self.update_callback()
        return new_val

    def _increment_play_count(self, path):
        if not path:
            return
        meta = self._meta_for(path)
        meta['play_count'] = int(meta.get('play_count', 0)) + 1
        meta['last_played'] = datetime.now().isoformat(timespec='seconds')
        self._mark_meta_dirty()

    # ==================== СОСТОЯНИЕ ====================

    def _load_state(self):
        try:
            if not self.state_file.exists():
                self._select_first_playlist()
                return
            with open(self.state_file, 'r', encoding='utf-8') as f:
                state = json.load(f)

            self._theme = state.get('theme', 'dark')
            self._eq_enabled = state.get('eq_enabled', True)
            self._eq_values = state.get('eq_values', [0.0] * 10)
            if len(self._eq_values) != 10:
                self._eq_values = [0.0] * 10

            self._accent = state.get('accent', '#7c8cff')
            self._cover_size = state.get('cover_size', 'medium')
            self._eq_profile = state.get('eq_profile', 'Flat')
            self._custom_profiles = state.get('custom_profiles', {}) or {}
            self._waveform_enabled = state.get('waveform_enabled', True)
            self._waveform_points = int(state.get('waveform_points', 2000))
            self._playlist_limit = int(state.get('playlist_limit', 1000))
            self._resume_on_start = state.get('resume_on_start', True)

            self._shuffle = state.get('shuffle', False)
            self._saved_position = state.get('saved_position', 0.0)

            last_playlist = state.get('last_playlist')
            last_track = state.get('last_track')
            # last_index игнорируем — источник правды только путь

            # ---- Плейлист ----
            if last_playlist and (last_playlist in self.playlists or last_playlist in self.VIRTUAL_NAMES):
                self.current_playlist = last_playlist
                self.tracks = self._tracks_for_playlist(last_playlist)
            else:
                self._select_first_playlist()
                last_track = None

            # ---- Трек: только по пути ----
            idx = -1
            if last_track:
                try:
                    idx = self.tracks.index(last_track)
                except ValueError:
                    idx = -1

            if idx < 0 and self.tracks:
                idx = 0

            if idx >= 0:
                self.current_index = idx
                self._current_track_path = self.tracks[idx]
            else:
                self.current_index = -1
                self._current_track_path = None

            # ---- Shuffle ----
            if self._shuffle and self.tracks:
                self._build_shuffle_order()

        except Exception as e:
            print(f"❌ Ошибка загрузки состояния: {e}")
            import traceback
            traceback.print_exc()
            self._select_first_playlist()

    def _select_first_playlist(self):
        if self.playlists:
            self.current_playlist = list(self.playlists.keys())[0]
            self.tracks = self.playlists[self.current_playlist]
            self.current_index = 0 if self.tracks else -1
            if self.tracks:
                self._current_track_path = self.tracks[0]
        else:
            self.current_playlist = None
            self.tracks = []
            self.current_index = -1
            self._current_track_path = None

    def _save_state(self, force=False):
        now = time.time()
        if not force and (now - self._state_last_save) < self._state_save_interval:
            self._state_dirty = True
            return
        try:
            state = {
                'last_playlist': self.current_playlist,
                'last_track': self._current_track_path,
                'saved_position': self._saved_position,
                'shuffle': self._shuffle,

                'theme': self._theme,
                'eq_enabled': self._eq_enabled,
                'eq_values': self._eq_values,

                'accent': self._accent,
                'cover_size': self._cover_size,
                'eq_profile': self._eq_profile,
                'custom_profiles': self._custom_profiles,
                'waveform_enabled': self._waveform_enabled,
                'waveform_points': self._waveform_points,
                'playlist_limit': self._playlist_limit,
                'resume_on_start': self._resume_on_start,

                'updated_at': time.time(),
            }
            with open(self.state_file, 'w', encoding='utf-8') as f:
                json.dump(state, f, indent=2, ensure_ascii=False)
            self._state_dirty = False
            self._state_last_save = now
        except Exception as e:
            print(f"❌ Ошибка сохранения состояния: {e}")

    # ==================== ВИРТУАЛЬНЫЕ ПЛЕЙЛИСТЫ ====================

    def _tracks_for_playlist(self, name):
        if name == self.VIRTUAL_FAVORITES:
            return [p for p, meta in self.metadata.items()
                    if meta.get('favorite') and os.path.exists(p)]
        if name == self.VIRTUAL_MOST_PLAYED:
            items = [(p, meta.get('play_count', 0))
                     for p, meta in self.metadata.items()
                     if meta.get('play_count', 0) > 0 and os.path.exists(p)]
            items.sort(key=lambda x: x[1], reverse=True)
            return [p for p, _ in items[:self.MOST_PLAYED_LIMIT]]
        return list(self.playlists.get(name, []))

    def _is_virtual(self, name):
        return name in self.VIRTUAL_NAMES

    def _build_shuffle_order(self):
        self._shuffle_order = list(range(len(self.tracks)))
        random.shuffle(self._shuffle_order)
        if self.current_index >= 0 and self.current_index in self._shuffle_order:
            self._shuffle_index = self._shuffle_order.index(self.current_index)
        else:
            self._shuffle_index = 0 if self._shuffle_order else -1

    def _clean_broken_tracks(self):
        removed = {}
        for name in list(self.playlists.keys()):
            original = self.playlists[name]
            valid = [p for p in original if os.path.exists(p)]
            if len(valid) != len(original):
                self.playlists[name] = valid
                removed[name] = len(original) - len(valid)

        if any(removed.values()):
            if self.current_playlist in self.playlists:
                self.tracks = self.playlists[self.current_playlist]
            elif self._is_virtual(self.current_playlist):
                self.tracks = self._tracks_for_playlist(self.current_playlist)

            if self._current_track_path and self._current_track_path in self.tracks:
                self.current_index = self.tracks.index(self._current_track_path)
            elif self.tracks:
                self.current_index = min(max(self.current_index, 0), len(self.tracks) - 1)
                self._current_track_path = self.tracks[self.current_index]
            else:
                self.current_index = -1
                self._current_track_path = None

            self._save_index()
            if self.update_callback:
                self.update_callback()
        return removed

    # ==================== УПРАВЛЕНИЕ ПЛЕЙЛИСТАМИ ====================

    def create_playlist(self, name):
        if not name or name.strip() == '':
            return False
        name = name.strip()
        if name in self.playlists or name in self.VIRTUAL_NAMES:
            return False
        with self._lock:
            self.playlists[name] = []
            self._save_index()
            if self.update_callback:
                self.update_callback()
            return True

    def delete_playlist(self, name):
        if name in self.VIRTUAL_NAMES:
            return False
        if name not in self.playlists or len(self.playlists) <= 1:
            return False
        with self._lock:
            del self.playlists[name]
            if self.current_playlist == name:
                self._select_first_playlist()
            self._save_index()
            self._save_state()
            if self.update_callback:
                self.update_callback()
            return True

    def switch_playlist(self, name):
        if name not in self.playlists and name not in self.VIRTUAL_NAMES:
            return False
        with self._lock:
            self.current_playlist = name
            self.tracks = self._tracks_for_playlist(name)
            self.current_index = 0 if self.tracks else -1
            self._current_track_path = self.tracks[0] if self.tracks else None
            if self._shuffle:
                self._build_shuffle_order()
            self._save_state()
            if self.update_callback:
                self.update_callback()
            return True

    def add_files_to_playlist(self, playlist_name, file_paths):
        if self._is_virtual(playlist_name):
            return {"added": 0, "files": [], "truncated": 0}
        if playlist_name not in self.playlists:
            return {"added": 0, "files": [], "truncated": 0}
        added = []
        truncated = 0
        with self._lock:
            current = self.playlists[playlist_name]
            limit = self._playlist_limit
            for path in file_paths:
                if limit > 0 and len(current) >= limit:
                    truncated += 1
                    continue
                if os.path.exists(path) and is_audio_file(path) and path not in current:
                    current.append(path)
                    added.append(path)
            if added:
                if self.current_playlist == playlist_name:
                    self.tracks = self.playlists[playlist_name]
                self._save_index()
                self._save_state()
                if self.update_callback:
                    self.update_callback()
        return {"added": len(added), "files": added, "truncated": truncated}

    def remove_from_playlist(self, playlist_name, index):
        if self._is_virtual(playlist_name):
            return False
        if playlist_name not in self.playlists:
            return False
        with self._lock:
            if 0 <= index < len(self.playlists[playlist_name]):
                del self.playlists[playlist_name][index]
                if self.current_playlist == playlist_name:
                    self.tracks = self.playlists[playlist_name]
                    if self.current_index >= len(self.tracks):
                        self.current_index = len(self.tracks) - 1
                self._save_index()
                self._save_state()
                if self.update_callback:
                    self.update_callback()
                return True
        return False

    def remove_from_playlist_by_path(self, playlist_name, path):
        if self._is_virtual(playlist_name):
            return False
        if playlist_name not in self.playlists:
            return False
        try:
            idx = self.playlists[playlist_name].index(path)
        except ValueError:
            return False
        return self.remove_from_playlist(playlist_name, idx)

    # ==================== ПОДГОТОВКА МЕДИА ====================

    def _prepare_media(self):
        """
        Готовит VLC к воспроизведению текущего трека без запуска.
        Нужно при старте, чтобы play()/resume() сразу работали.
        """
        if not self._current_track_path or not os.path.exists(self._current_track_path):
            return
        try:
            with self._lock:
                media = self.vlc_instance.media_new(self._current_track_path)
                self.player.set_media(media)
                self._apply_eq()
                if not self.event_manager:
                    self.event_manager = self.player.event_manager()
                    self.event_manager.event_attach(
                        vlc.EventType.MediaPlayerEndReached,
                        self._on_track_end
                    )
        except Exception as e:
            print(f"prepare_media error: {e}")

    # ==================== ВОСПРОИЗВЕДЕНИЕ ====================

    def play(self, index=None):
        self._clean_broken_tracks()

        if self._is_virtual(self.current_playlist):
            self.tracks = self._tracks_for_playlist(self.current_playlist)

        if index is not None:
            if 0 <= index < len(self.tracks):
                self.current_index = index
                self._current_track_path = self.tracks[index]
            else:
                return False

        if self.current_index < 0 or not self.tracks:
            return False

        track_path = self.tracks[self.current_index]
        self._current_track_path = track_path

        with self._lock:
            if not os.path.exists(track_path):
                self._clean_broken_tracks()
                return False

            if self.player:
                self.player.stop()

            media = self.vlc_instance.media_new(track_path)
            self.player.set_media(media)

            if not self.event_manager:
                self.event_manager = self.player.event_manager()
                self.event_manager.event_attach(
                    vlc.EventType.MediaPlayerEndReached,
                    self._on_track_end
                )

            self._apply_eq()
            self.player.play()
            self.is_playing = True
            self._saved_position = 0.0

            self._increment_play_count(track_path)
            self._save_state()

            if self.update_callback:
                self.update_callback()
            return True

    def pause(self):
        if not self.player:
            return False
        with self._lock:
            try:
                vlc_state = self.player.get_state()
            except Exception as e:
                vlc_state = f"err: {e}"

            try:
                vlc_time = self.player.get_time()
            except Exception as e:
                vlc_time = f"err: {e}"

            print(f"[PAUSE] py_is_playing={self.is_playing}, vlc_state={vlc_state}, vlc_time={vlc_time}, saved={self._saved_position:.4f}")

            if vlc_state == vlc.State.Playing:
                self.player.pause()
                self.is_playing = False
                time.sleep(0.05)
                ms = self.player.get_time()
                d = self.get_duration_ms()
                print(f"[PAUSE] after: ms={ms}, d={d}")
                if d > 0 and ms is not None and ms >= 0:
                    self._saved_position = max(0.0, min(1.0, ms / d))
            else:
                print(f"[PAUSE] not playing → resume")
                return self.resume()

            self._save_state()
            return True

    def stop(self):
        if self.player:
            self.player.stop()
            self.is_playing = False
            self._saved_position = 0.0
            self._save_state()
            return True
        return False

    def resume(self):
        if not self._current_track_path or not os.path.exists(self._current_track_path):
            return False
        with self._lock:
            current_media = None
            try:
                current_media = self.player.get_media()
            except Exception:
                current_media = None

            if current_media is None:
                media = self.vlc_instance.media_new(self._current_track_path)
                self.player.set_media(media)
                self._apply_eq()

            duration = self.get_duration_ms()
            if duration <= 0:
                for _ in range(10):
                    time.sleep(0.05)
                    duration = self.get_duration_ms()
                    if duration > 0:
                        break

            saved_ms = int(self._saved_position * duration) if duration > 0 and self._saved_position > 0 else 0

            self.player.play()
            self.is_playing = True

            if saved_ms > 0:
                # Ждём Playing
                deadline = time.time() + 2.0
                while time.time() < deadline:
                    try:
                        if self.player.get_state() == vlc.State.Playing:
                            break
                    except Exception:
                        pass
                    time.sleep(0.02)

                # Пытаемся set_time без pause
                for _ in range(5):
                    try:
                        self.player.set_time(saved_ms)
                    except Exception:
                        pass
                    time.sleep(0.03)
                    try:
                        real = self.player.get_time()
                        if real is not None and abs(real - saved_ms) < 500:
                            break
                    except Exception:
                        pass

            self._save_state()
            return True

    def next(self):
        if not self.tracks:
            return False
        if self._shuffle and self._shuffle_order:
            if self._shuffle_index < len(self._shuffle_order) - 1:
                self._shuffle_index += 1
                self.current_index = self._shuffle_order[self._shuffle_index]
            else:
                self._shuffle_index = 0
                self.current_index = self._shuffle_order[0]
        else:
            self.current_index = (self.current_index + 1) % len(self.tracks)
        return self.play(self.current_index)

    def previous(self):
        if not self.tracks:
            return False
        if self._shuffle and self._shuffle_order:
            if self._shuffle_index > 0:
                self._shuffle_index -= 1
                self.current_index = self._shuffle_order[self._shuffle_index]
            else:
                self._shuffle_index = len(self._shuffle_order) - 1
                self.current_index = self._shuffle_order[-1]
        else:
            self.current_index = (self.current_index - 1) % len(self.tracks)
        return self.play(self.current_index)

    def shuffle(self):
        self._shuffle = not self._shuffle
        if self._shuffle:
            self._build_shuffle_order()
        else:
            self._shuffle_order = []
            self._shuffle_index = -1
        self._save_state()
        return self._shuffle

    def toggle_repeat(self):
        self.repeat_mode = (self.repeat_mode + 1) % 3
        self._save_state()
        return self.repeat_mode

    def seek(self, position):
        if not self.player:
            return False
        position = max(0.0, min(1.0, position))
        d = self.get_duration_ms()
        if d > 0:
            ms = int(position * d)
            self.player.set_time(ms)
        else:
            self.player.set_position(position)
        self._saved_position = position
        self._save_state()
        return True

    def set_volume(self, volume):
        if self.player:
            volume = max(0, min(100, volume))
            self.player.audio_set_volume(volume)
            return volume
        return 0

    def get_volume(self):
        if self.player:
            try:
                vol = self.player.audio_get_volume()
                if vol >= 0:
                    return vol
            except Exception:
                pass
        return 50

    def get_position(self):
        ms = self.get_time_ms()
        d = self.get_duration_ms()
        if d > 0 and ms >= 0:
            return max(0.0, min(1.0, ms / d))
        return self._saved_position

    def get_current_track(self):
        if 0 <= self.current_index < len(self.tracks):
            return Path(self.tracks[self.current_index]).stem
        return None

    def get_current_track_info(self):
        if self._current_track_path and self._current_track_path in self.tracks:
            idx = self.tracks.index(self._current_track_path)
            if idx != self.current_index:
                self.current_index = idx
            return self.get_track_info(self._current_track_path)

        if 0 <= self.current_index < len(self.tracks):
            self._current_track_path = self.tracks[self.current_index]
            return self.get_track_info(self._current_track_path)

        return None

    def get_status(self):
        # Лечим рассинхрон индекс/путь
        if self._current_track_path and self._current_track_path in self.tracks:
            real_idx = self.tracks.index(self._current_track_path)
            if real_idx != self.current_index:
                self.current_index = real_idx
        elif 0 <= self.current_index < len(self.tracks):
            self._current_track_path = self.tracks[self.current_index]

        self._clean_broken_tracks()

        current_info = self.get_current_track_info() or {
            'title': None, 'artist': '', 'album': '', 'cover': None,
            'favorite': False, 'duration': 0.0, 'id': None,
        }

        return {
            "track": current_info['title'],
            "track_info": current_info,
            "playing": self.is_playing,
            "position": self.get_position(),
            "volume": self.get_volume(),
            "repeat": self.repeat_mode,
            "playlist": self.current_playlist,
            "playlists": self.get_playlists_info(),
            "index": self.current_index,
            "total": len(self.tracks),
            "shuffle": self._shuffle,
        }

    def get_playlists_info(self):
        result = {}
        for name, tracks in self.playlists.items():
            result[name] = {'count': len(tracks), 'is_virtual': False}
        result[self.VIRTUAL_FAVORITES] = {
            'count': len(self._tracks_for_playlist(self.VIRTUAL_FAVORITES)),
            'is_virtual': True,
        }
        result[self.VIRTUAL_MOST_PLAYED] = {
            'count': len(self._tracks_for_playlist(self.VIRTUAL_MOST_PLAYED)),
            'is_virtual': True,
        }
        return result

    def get_playlist_tracks(self):
        if self._is_virtual(self.current_playlist):
            self.tracks = self._tracks_for_playlist(self.current_playlist)

        result = []
        for path in self.tracks:
            info = self.get_track_info(path)
            if info:
                result.append(info)
        return result

    def set_update_callback(self, callback):
        self.update_callback = callback

    def _on_track_end(self, event):
        threading.Thread(target=self._play_next, daemon=True).start()

    def _play_next(self):
        time.sleep(0.1)
        if self.repeat_mode == 1:
            self.play(self.current_index)
        elif self.repeat_mode == 2:
            self.next()
        else:
            if self._shuffle and self._shuffle_order:
                if self._shuffle_index < len(self._shuffle_order) - 1:
                    self.next()
                else:
                    self.stop()
            else:
                if self.current_index < len(self.tracks) - 1:
                    self.next()
                else:
                    self.stop()

    # ==================== НАСТРОЙКИ / ЭКВАЛАЙЗЕР ====================

    def get_settings(self):
        return {
            "theme": self._theme,
            "eq_enabled": self._eq_enabled,
            "eq_values": self._eq_values,
            "accent": self._accent,
            "cover_size": self._cover_size,
            "eq_profile": self._eq_profile,
            "custom_profiles": self._custom_profiles,
            "waveform_enabled": self._waveform_enabled,
            "waveform_points": self._waveform_points,
            "playlist_limit": self._playlist_limit,
            "resume_on_start": self._resume_on_start,
        }

    def save_settings(self, **kwargs):
        if 'theme' in kwargs and kwargs['theme'] is not None:
            self._theme = kwargs['theme']
        if 'eq_enabled' in kwargs and kwargs['eq_enabled'] is not None:
            self._eq_enabled = bool(kwargs['eq_enabled'])
        if 'eq_values' in kwargs and kwargs['eq_values'] is not None:
            vals = list(kwargs['eq_values'])
            if len(vals) == 10:
                self._eq_values = vals
        if 'accent' in kwargs and kwargs['accent']:
            self._accent = kwargs['accent']
        if 'cover_size' in kwargs and kwargs['cover_size'] in ('small', 'medium', 'large'):
            self._cover_size = kwargs['cover_size']
        if 'eq_profile' in kwargs and kwargs['eq_profile']:
            self._eq_profile = kwargs['eq_profile']
        if 'custom_profiles' in kwargs and isinstance(kwargs['custom_profiles'], dict):
            self._custom_profiles = kwargs['custom_profiles']
        if 'waveform_enabled' in kwargs and kwargs['waveform_enabled'] is not None:
            self._waveform_enabled = bool(kwargs['waveform_enabled'])
        if 'waveform_points' in kwargs:
            try:
                pts = int(kwargs['waveform_points'])
                if pts in (1000, 2000, 4000):
                    self._waveform_points = pts
            except (TypeError, ValueError):
                pass
        if 'playlist_limit' in kwargs:
            try:
                lim = int(kwargs['playlist_limit'])
                if lim >= 0:
                    self._playlist_limit = lim
            except (TypeError, ValueError):
                pass
        if 'resume_on_start' in kwargs and kwargs['resume_on_start'] is not None:
            self._resume_on_start = bool(kwargs['resume_on_start'])

        self._apply_eq()
        self._save_state(force=True)
        if self.update_callback:
            self.update_callback()
        return True

    def _apply_eq(self):
        if not self.player:
            return
        if not self._eq_enabled:
            try:
                self.player.set_equalizer(None)
            except Exception as e:
                print(f"❌ Ошибка отключения EQ: {e}")
            return
        try:
            eq = vlc.AudioEqualizer('flat')
            for i in range(10):
                value = max(-20.0, min(20.0, self._eq_values[i]))
                eq.set_amp_at_index(value, i)
            self.player.set_equalizer(eq)
        except Exception as e:
            print(f"❌ Ошибка EQ: {e}")

    def rescan(self):
        self._clean_broken_tracks()
        if self.update_callback:
            self.update_callback()
        return self.get_playlists_info()

    # ==================== ЗАВЕРШЕНИЕ ====================

    def shutdown(self):
        self._meta_dirty = True
        self._save_metadata(force=True)
        self._save_state(force=True)