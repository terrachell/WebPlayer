# app.py

import os
import sys
import platform
import json
import threading
import time
import base64
import subprocess
import socket
from pathlib import Path

# ============================================================
# 1. VLC: настраиваем ДО всего, что импортирует vlc
# ============================================================
from vlc_loader import setup as setup_vlc

_vlc_ok = setup_vlc()
if not _vlc_ok:
    print("⚠️  VLC не найден.")
    print("    Установите VLC: https://www.videolan.org/vlc/")
    print("    Или используйте собранный .dmg (VLC встроен).")

# ============================================================
# 2. ffmpeg: ищем в системе и в бандле
# ============================================================
_FFMPEG_PATHS = []
if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
    _FFMPEG_PATHS.append(str(Path(sys._MEIPASS) / "ffmpeg"))
_FFMPEG_PATHS += [
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
]
for _path in _FFMPEG_PATHS:
    if os.path.exists(_path):
        os.environ['PATH'] = os.path.dirname(_path) + ':' + os.environ.get('PATH', '')
        print(f"✅ ffmpeg: {_path}")
        break

import webview
import http.server
import socketserver

from music_player import MusicPlayer, AUDIO_EXTENSIONS, is_audio_file

# ... дальше всё как было


# ============================================================
# ПЛАГИНЫ
# ============================================================

class PluginApi:
    """
    Ограниченный API, который видит плагин.
    Никакого os.system, open(), subprocess.
    Только чтение состояния плеера.
    """
    def __init__(self, player, plugin_id: str):
        self._player = player
        self._plugin_id = plugin_id

    def get_status(self):
        return self._player.get_status()

    def get_position(self):
        return self._player.get_position()

    def get_current_track(self):
        return self._player.get_current_track()

    def get_current_track_path(self):
        return self._player._public_track_path

    def read_file_next_to_track(self, extension: str, mode: str = 'text'):
        track_path = self._player.get_current_track_path()
        if not track_path:
            return None
        file_path = Path(track_path).with_suffix(extension)
        if not file_path.exists():
            return None
        print(f"[lyrics-debug] looking for: {file_path}, exists={file_path.exists()}")
        try:
            if mode == 'text':
                return file_path.read_text(encoding='utf-8')
            if mode == 'base64':
                return base64.b64encode(file_path.read_bytes()).decode('ascii')
            return None
        except Exception as e:
            print(f"❌ [plugin:{self._plugin_id}] read_file_next_to_track({extension}, {mode}): {e}")
            return None

    def log(self, message: str):
        print(f"[plugin:{self._plugin_id}] {message}")


class PluginLoader:
    def __init__(self, plugins_dir: Path, player):
        self.plugins_dir = plugins_dir
        self.player = player
        self.plugins = {}
        self._load_all()

    def _load_all(self):
        if not self.plugins_dir.exists():
            print(f"ℹ️  Папка плагинов не найдена: {self.plugins_dir}")
            return

        for folder in sorted(self.plugins_dir.iterdir()):
            if not folder.is_dir():
                continue
            manifest_path = folder / "manifest.json"
            if not manifest_path.exists():
                continue
            try:
                data = json.loads(manifest_path.read_text(encoding="utf-8"))
                pid = data["id"]
                self.plugins[pid] = {
                    "manifest": data,
                    "path": folder,
                    "api": PluginApi(self.player, pid),
                }
                print(f"✅ Плагин загружен: {pid} v{data.get('version', '?')}")
            except Exception as e:
                print(f"❌ Плагин {folder.name} не загружен: {e}")

    def _is_enabled(self, plugin_id: str) -> bool:
        try:
            settings = self.player.get_settings() or {}
            disabled = settings.get('plugins_disabled') or []
            return plugin_id not in disabled
        except Exception:
            return True

    def get_all_manifests(self):
        return [
            {
                "id": pid,
                "manifest": p["manifest"],
                "enabled": self._is_enabled(pid),
            }
            for pid, p in self.plugins.items()
        ]

    def get_api(self, plugin_id: str):
        p = self.plugins.get(plugin_id)
        return p["api"] if p else None

    def set_enabled(self, plugin_id: str, enabled: bool):
        if plugin_id not in self.plugins:
            return False
        try:
            settings = self.player.get_settings() or {}
            disabled = list(settings.get('plugins_disabled') or [])
            if enabled:
                if plugin_id in disabled:
                    disabled.remove(plugin_id)
            else:
                if plugin_id not in disabled:
                    disabled.append(plugin_id)
            self.player.save_settings(plugins_disabled=disabled)
            return True
        except Exception as e:
            print(f"set_enabled error: {e}")
            return False


# ============================================================
# ===== HTTP СЕРВЕР: frontend + covers + plugins =============
# ============================================================
class CustomHTTPHandler(http.server.SimpleHTTPRequestHandler):
    base_dir = None
    frontend_dir = None
    covers_dir = None
    plugins_dir = None

    def translate_path(self, path):
        path = path.split('?', 1)[0].split('#', 1)[0]

        if path.startswith('/covers/'):
            rel = path[len('/covers/'):].lstrip('/').replace('..', '')
            full = self.covers_dir / rel
            return str(full)

        if path.startswith('/plugins/'):
            rel = path[len('/plugins/'):].lstrip('/').replace('..', '')
            full = self.plugins_dir / rel
            return str(full)

        if path == '/' or path == '':
            path = '/index.html'
        rel = path.lstrip('/').replace('..', '')
        return str(self.frontend_dir / rel)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

    def log_message(self, format, *args):
        pass


class ReusableThreadingTCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def _try_bind(handler_class, port, attempts=20):
    for offset in range(attempts):
        p = port + offset
        try:
            httpd = ReusableThreadingTCPServer(("0.0.0.0", p), handler_class)
            return httpd, p
        except OSError as e:
            if e.errno in (48, 98):
                print(f"⚠️  Порт {p} занят, пробую {p + 1}...")
                continue
            raise
    raise OSError(f"Не удалось найти свободный порт {port}..{port + attempts - 1}")


def start_server(base_dir, frontend_dir, covers_dir, plugins_dir, port, port_holder):
    CustomHTTPHandler.base_dir = base_dir
    CustomHTTPHandler.frontend_dir = frontend_dir
    CustomHTTPHandler.covers_dir = covers_dir
    CustomHTTPHandler.plugins_dir = plugins_dir
    httpd, real_port = _try_bind(CustomHTTPHandler, port)

    port_holder[0] = real_port
    print(f"✅ Сервер слушает порт {real_port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


def get_local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    finally:
        s.close()


# ============================================================
# ===== API =================================================
# ============================================================
class Api:
    def __init__(self):
        self.window = None

        import sys
        if getattr(sys, 'frozen', False):
            data_dir = Path.home() / 'Library' / 'Application Support' / 'MusicPlayer'
        else:
            data_dir = Path(__file__).parent
        data_dir.mkdir(parents=True, exist_ok=True)

        print(f"📂 Данные: {data_dir}")

        self.player = MusicPlayer(base_dir=data_dir)
        self.player.set_update_callback(self._on_player_update)
        self._running = True
        self._waveform_cache_dir = self.player.base_dir / "waveform_cache"
        self._waveform_cache_dir.mkdir(exist_ok=True)

        plugins_dir = Path(__file__).resolve().parent / "plugins"
        self.plugin_loader = PluginLoader(plugins_dir, self.player)

        self._start_progress_updater()
        self._current_waveform = None

    # ---------------- Кэш waveform ----------------

    def get_waveform_cache_size(self):
        try:
            total = 0
            for f in self._waveform_cache_dir.iterdir():
                if f.is_file():
                    total += f.stat().st_size
            return total
        except Exception:
            return 0

    def clear_waveform_cache(self):
        try:
            count = 0
            for f in self._waveform_cache_dir.iterdir():
                if f.is_file():
                    f.unlink()
                    count += 1
            return count
        except Exception as e:
            print(f"clear_waveform_cache error: {e}")
            return 0

    def rescan_playlists(self):
        return self.player.rescan()

    # ---------------- Обновления UI ----------------

    def _start_progress_updater(self):
        def update_loop():
            while self._running:
                if self.window:
                    try:
                        if self.player._switching_track:
                            time.sleep(0.016)
                            continue

                        # Даём VLC 300 мс после play(), чтобы время не прыгало
                        if self.player._last_play_at and (time.time() - self.player._last_play_at) < 0.3:
                            time.sleep(0.016)
                            continue

                        position = self.player.get_position()
                        playing = self.player.is_playing
                        duration_ms = self.player.get_duration_ms()
                        offset_ms = self.player.get_position_offset_ms()

                        if duration_ms > 0:
                            position += offset_ms / duration_ms
                            position = max(0.0, min(1.0, position))

                        self.window.evaluate_js(f"""
                            if (typeof updateProgress === 'function') {{
                                updateProgress({position});
                            }}
                            if (typeof Visualizer !== 'undefined') {{
                                Visualizer.setPlaying({str(playing).lower()});
                            }}
                        """)
                    except Exception:
                        pass
                time.sleep(0.016)

        threading.Thread(target=update_loop, daemon=True).start()

    def _on_player_update(self):
        if self.window:
            try:
                self.window.evaluate_js("""
                    if (typeof loadStatus === 'function') {
                        loadStatus();
                    }
                """)
            except Exception:
                pass

    def log(self, message):
        pass

    # ---------------- Воспроизведение ----------------

    def play(self, index=None):
        result = self.player.play(index)
        self._on_player_update()
        if result:
            threading.Thread(target=self._deliver_waveform, daemon=True).start()
        return result

    def _deliver_waveform(self):
        """
        Пытается отдать waveform для текущего трека максимально быстро.
        Сначала — из кэша (мгновенно). Если кэша нет — генерирует в фоне.
        """
        if not self.player._waveform_enabled:
            if self.window:
                try:
                    self.window.evaluate_js(
                        "if (typeof loadWaveform === 'function') { loadWaveform(null); }"
                    )
                except Exception:
                    pass
            return

        try:
            status = self.player.get_status()
            info = status.get('track_info') or {}
            path = info.get('id')
            if not path:
                return

            # 1. Пробуем отдать из кэша (мгновенно)
            cached = self._read_waveform_from_cache(path)
            if cached:
                if self.window:
                    self.window.evaluate_js(f"""
                        if (typeof loadWaveform === 'function') {{
                            loadWaveform({json.dumps(cached)});
                        }}
                    """)
                return

            # 2. Кэша нет — считаем ffmpeg'ом
            waveform_data = self.generate_waveform(path)
            if waveform_data and self.window:
                self.window.evaluate_js(f"""
                    if (typeof loadWaveform === 'function') {{
                        loadWaveform({json.dumps(waveform_data)});
                    }}
                """)
        except Exception as e:
            print(f"waveform deliver: {e}")

    def _read_waveform_from_cache(self, file_path, points=None):
        """Только читает кэш. Возвращает dict или None."""
        try:
            import struct
            import hashlib

            if points is None:
                points = self.player._waveform_points

            try:
                mtime = os.path.getmtime(file_path)
                fsize = os.path.getsize(file_path)
            except OSError:
                return None

            key_src = f"{file_path}|{mtime}|{fsize}|{points}".encode('utf-8')
            key = hashlib.md5(key_src).hexdigest()
            cache_file = self._waveform_cache_dir / f"{key}.bin"

            if not cache_file.exists():
                return None

            with open(cache_file, 'rb') as f:
                header = f.read(20)
                if len(header) != 20:
                    return None
                magic, n_points, duration, _ = struct.unpack('<4sIdI', header)
                if magic != b'WAV1' or n_points != points:
                    return None
                data = f.read(n_points)
                if len(data) != n_points:
                    return None
                return {'waveform': list(data), 'duration': float(duration)}
        except Exception as e:
            print(f"_read_waveform_from_cache: {e}")
            return None

    def generate_waveform(self, file_path, points=None):
        try:
            import struct
            import hashlib
            import subprocess
            import numpy as np

            if not self.player._waveform_enabled:
                return None

            if points is None:
                points = self.player._waveform_points

            # Сначала — кэш
            cached = self._read_waveform_from_cache(file_path, points)
            if cached:
                return cached

            ffmpeg_bin = None
            for p in ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']:
                if os.path.exists(p):
                    ffmpeg_bin = p
                    break
            if not ffmpeg_bin:
                print("waveform: ffmpeg not found")
                return None

            cmd = [
                ffmpeg_bin, '-i', file_path,
                '-f', 's16le', '-acodec', 'pcm_s16le',
                '-ac', '1', '-ar', '8000',
                '-'
            ]
            proc = subprocess.run(cmd, capture_output=True, timeout=60)
            if proc.returncode != 0:
                print(f"waveform: ffmpeg failed: {proc.stderr[-200:]}")
                return None

            raw = proc.stdout
            if not raw:
                return None

            samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
            duration = len(samples) / 8000.0

            step = max(1, len(samples) // points)
            peaks = np.zeros(points, dtype=np.float32)
            for i in range(points):
                start = i * step
                end = min(start + step, len(samples))
                seg = samples[start:end]
                if len(seg):
                    peaks[i] = np.sqrt(np.mean(seg * seg))

            max_val = float(peaks.max()) if peaks.size else 0.0
            if max_val > 0:
                peaks = peaks / max_val
            peaks_u8 = np.clip(peaks * 255.0, 0, 255).astype(np.uint8)

            try:
                with open(cache_file, 'wb') as f:
                    f.write(struct.pack('<4sIdI', b'WAV1', points, duration, 0))
                    f.write(peaks_u8.tobytes())
            except Exception as e:
                print(f"waveform cache write: {e}")

            return {'waveform': peaks_u8.tolist(), 'duration': duration}

        except Exception as e:
            print(f"waveform error: {e}")
            return None

    def pause(self):
        if not self.player:
            return {"playing": False, "position": 0.0}
        if self.player.is_playing:
            self.player.pause()
        else:
            self.player.resume()
        return {
            "playing": self.player.is_playing,
            "position": self.player.get_position(),
        }

    def stop(self):
        result = self.player.stop()
        self._on_player_update()
        return result

    def next(self):
        result = self.player.next()
        self._on_player_update()
        if result:
            threading.Thread(target=self._deliver_waveform, daemon=True).start()
        return result

    def previous(self):
        result = self.player.previous()
        self._on_player_update()
        if result:
            threading.Thread(target=self._deliver_waveform, daemon=True).start()
        return result

    def shuffle(self):
        result = self.player.shuffle()
        self._on_player_update()
        return result

    def set_volume(self, volume):
        return self.player.set_volume(volume)

    def toggle_repeat(self):
        result = self.player.toggle_repeat()
        self._on_player_update()
        return result

    def seek(self, position):
        return self.player.seek(position)

    # ---------------- Статус / плейлисты ----------------

    def get_status(self):
        try:
            status = self.player.get_status()
            status['settings'] = self.player.get_settings()
            return status
        except Exception:
            return {
                "track": None, "track_info": None, "playing": False,
                "position": 0, "volume": 50, "repeat": 0,
                "playlist": None, "playlists": {}, "index": -1,
                "total": 0, "shuffle": False, "settings": {},
            }

    def get_playlists(self):
        return self.player.get_playlists_info()

    def get_playlist_tracks(self):
        return self.player.get_playlist_tracks()

    def get_track_info(self, path):
        return self.player.get_track_info(path)

    def create_playlist(self, name):
        return self.player.create_playlist(name)

    def delete_playlist(self, name):
        return self.player.delete_playlist(name)

    def switch_playlist(self, name):
        result = self.player.switch_playlist(name)
        self._on_player_update()
        if result:
            threading.Thread(target=self._deliver_waveform, daemon=True).start()
        return result

    def remove_from_playlist(self, playlist_name, index):
        return self.player.remove_from_playlist(playlist_name, index)

    def remove_from_playlist_by_path(self, playlist_name, path):
        return self.player.remove_from_playlist_by_path(playlist_name, path)

    def add_files_to_playlist(self, playlist_name, file_paths):
        if not isinstance(file_paths, list):
            file_paths = [file_paths]

        valid_paths = [str(p) for p in file_paths if os.path.exists(str(p)) and is_audio_file(str(p))]

        if not valid_paths:
            return {"added": 0, "files": []}

        result = self.player.add_files_to_playlist(playlist_name, valid_paths)
        self._on_player_update()
        return result

    def add_files_from_data(self, files_data):
        if not files_data:
            return {"added": 0, "files": []}

        added = []
        for item in files_data:
            name = item.get('name')
            data = item.get('data')

            if not name or not data:
                continue

            if not is_audio_file(name):
                continue

            if data.startswith('data:'):
                data = data.split(',')[1]

            try:
                file_bytes = base64.b64decode(data)
                tracks_dir = self.player.base_dir / 'tracks'
                tracks_dir.mkdir(exist_ok=True)

                safe_name = name.replace('/', '_').replace('\\', '_')
                file_path = tracks_dir / safe_name

                with open(file_path, 'wb') as f:
                    f.write(file_bytes)

                if self.player.current_playlist and self.player.current_playlist in self.player.playlists:
                    if str(file_path) not in self.player.playlists[self.player.current_playlist]:
                        self.player.playlists[self.player.current_playlist].append(str(file_path))
                        added.append(str(file_path))

            except Exception as e:
                print(f"add_files_from_data error: {e}")

        if added:
            self.player._save_index()
            self.player._save_state()
            if self.player.update_callback:
                self.player.update_callback()

        return {"added": len(added), "files": added}

    # ---------------- Метаданные ----------------

    def rename_track(self, path, new_title):
        result = self.player.rename_track(path, new_title)
        self._on_player_update()
        return result

    def reset_track_title(self, path):
        result = self.player.reset_track_title(path)
        self._on_player_update()
        return result

    def set_track_meta(self, path, fields):
        result = self.player.set_track_meta(path, **(fields or {}))
        self._on_player_update()
        return result

    def toggle_favorite(self, path):
        result = self.player.toggle_favorite(path)
        self._on_player_update()
        return result

    # ---------------- Файлы ----------------

    def open_file_dialog(self):
        try:
            result = webview.windows[0].create_file_dialog(
                webview.FileDialog.OPEN,
                allow_multiple=True,
                file_types=(
                    'Аудио (*.mp3;*.m4a;*.flac;*.wav;*.ogg;*.opus;*.aac;*.wma;*.aiff;*.alac;*.ape)',
                    'Все файлы (*.*)'
                )
            )
            if result:
                if isinstance(result, tuple):
                    return list(result)
                elif isinstance(result, str):
                    return [result]
                elif isinstance(result, list):
                    return result
            return []
        except Exception as e:
            print(f"open_file_dialog error: {e}")
            return []

    def ready(self):
        return {"ok" : True}

    def get_dropped_folder_path(self):
        script = '''
            tell application "Finder"
                set selectedItems to selection
                if (count of selectedItems) > 0 then
                    set firstItem to item 1 of selectedItems
                    return POSIX path of (firstItem as alias)
                end if
                return ""
            end tell
        '''
        try:
            result = subprocess.run(['osascript', '-e', script],
                                    capture_output=True, text=True, timeout=2)
            if result.returncode == 0 and result.stdout.strip():
                full_path = result.stdout.strip()
                clean_path = full_path.rstrip('/')
                if os.path.exists(clean_path):
                    return {
                        "path": clean_path,
                        "name": os.path.basename(clean_path),
                        "is_folder": os.path.isdir(clean_path),
                        "is_file": os.path.isfile(clean_path),
                    }
        except Exception:
            pass
        return None

    def open_in_vlc(self, path):
        if not path or not os.path.exists(path):
            return False
        try:
            subprocess.Popen(['open', '-a', 'VLC', path])
            return True
        except Exception as e:
            print(f"open_in_vlc error: {e}")
            return False

    def scan_folder_for_audio(self, folder_path):
        if not os.path.exists(folder_path) or not os.path.isdir(folder_path):
            return {"files": [], "count": 0}
        files_found = []
        try:
            for root, dirs, files in os.walk(folder_path):
                for file in files:
                    if is_audio_file(file):
                        files_found.append(os.path.join(root, file))
            return {"files": files_found, "count": len(files_found)}
        except Exception as e:
            return {"files": [], "count": 0, "error": str(e)}

    def scan_folder_for_mp3(self, folder_path):
        return self.scan_folder_for_audio(folder_path)

    # ---------------- Настройки ----------------

    def get_settings(self):
        return self.player.get_settings()

    def save_settings(self, settings):
        result = self.player.save_settings(**(settings or {}))
        self._on_player_update()
        return result

    # ---------------- API для плагинов ----------------

    def get_plugins(self):
        return self.plugin_loader.get_all_manifests()

    def set_plugin_enabled(self, plugin_id: str, enabled: bool):
        return self.plugin_loader.set_enabled(plugin_id, enabled)

    def plugin_call(self, plugin_id: str, method: str, *args):
        api = self.plugin_loader.get_api(plugin_id)
        if not api:
            print(f"❌ [plugin:{plugin_id}] не найден")
            return {"error": f"plugin '{plugin_id}' not found"}
        fn = getattr(api, method, None)
        if not fn:
            print(f"❌ [plugin:{plugin_id}] метод '{method}' не найден")
            return {"error": f"method '{method}' not found"}
        try:
            return fn(*args)
        except Exception as e:
            print(f"❌ [plugin:{plugin_id}] {method}: {e}")
            return {"error": str(e)}


# ============================================================
# ===== ЗАПУСК ==============================================
# ============================================================

def _check_port_free(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.1)
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


if __name__ == '__main__':
    api = Api()

    settings = api.player.get_settings()
    theme = settings.get('theme', 'dark') if settings else 'dark'
    api.player._theme = theme

    import sys
    if getattr(sys, 'frozen', False):
        base_dir = Path(sys._MEIPASS)
    else:
        base_dir = Path(__file__).parent

    frontend_dir = base_dir / "frontend"
    html_path = frontend_dir / "index.html"

    if not html_path.exists():
        print(f"❌ Не найден {html_path}")
        exit(1)

    PORT = int(os.environ.get("PLAYER_PORT", "8000"))
    port_holder = [PORT]
    plugins_dir = Path(__file__).resolve().parent / "plugins"

    threading.Thread(
        target=start_server,
        args=(base_dir, frontend_dir, api.player.covers_dir, plugins_dir, PORT, port_holder),
        daemon=True
    ).start()

    for _ in range(60):
        if port_holder[0] != PORT or _check_port_free(PORT):
            break
        time.sleep(0.05)

    actual_port = port_holder[0]

    try:
        print(f"🌐 Локально:  http://localhost:{actual_port}/index.html")
        print(f"🌐 В сети:    http://{get_local_ip()}:{actual_port}/index.html")
    except Exception:
        pass

    window = webview.create_window(
        title='✦ Музыкальный плеер',
        url=f'http://localhost:{actual_port}/index.html?theme={theme}',
        js_api=api,
        width=1200,
        height=800,
        min_size=(900, 600),
        background_color='#0a0a1a' if theme == 'dark' else '#f0f0f5'
    )
    api.window = window

    def on_loaded():
        try:
            window.evaluate_js("""
                (function() {
                    const params = new URLSearchParams(window.location.search);
                    const theme = params.get('theme') || 'dark';
                    document.documentElement.setAttribute('data-theme', theme);
                })();
            """)
            threading.Thread(target=api._deliver_waveform, daemon=True).start()
            window.evaluate_js("""
                if (typeof loadStatus === 'function') {
                    loadStatus();
                }
            """)
        except Exception as e:
            print(f"Ошибка при загрузке: {e}")

    window.events.loaded += on_loaded

    try:
        webview.start(gui='cocoa')
    finally:
        api._running = False
        api.player.shutdown()
        print("💾 Метаданные сохранены, выход.")