# vlc_loader.py
#
# Умная загрузка libvlc:
# - Если запущено из собранного .app (PyInstaller onefile/onedir) —
#   берём libvlc и плагины из sys._MEIPASS.
# - Если запущено из исходников — ищем системный VLC:
#     * /Applications/VLC.app/Contents/MacOS/lib (cask/manual)
#     * /opt/homebrew/lib (brew formula)
#     * /usr/local/lib
#
# Этот модуль НУЖНО импортировать до `import vlc`.

import os
import sys
import ctypes
from pathlib import Path


def _log(msg):
    print(f"[vlc_loader] {msg}")


def _setup_bundled_vlc():
    """
    Настраивает окружение для использования VLC, встроенного в .app.
    PyInstaller распаковывает файлы в sys._MEIPASS.
    """
    meipass = Path(sys._MEIPASS)
    lib_dir = meipass / "vlc" / "lib"
    plugins_dir = meipass / "vlc" / "plugins"

    if not lib_dir.exists():
        _log(f"встроенный VLC не найден в {lib_dir}")
        return False

    libvlc = lib_dir / "libvlc.dylib"
    libvlccore = lib_dir / "libvlccore.dylib"
    # На разных версиях VLC имя core может быть с цифрой
    if not libvlccore.exists():
        for candidate in lib_dir.glob("libvlccore.*.dylib"):
            libvlccore = candidate
            break

    if not libvlc.exists():
        _log(f"libvlc.dylib не найден в {lib_dir}")
        return False

    # 1. Плагины VLC (обязательно ДО загрузки libvlc)
    if plugins_dir.exists():
        os.environ["VLC_PLUGIN_PATH"] = str(plugins_dir)
        _log(f"VLC_PLUGIN_PATH = {plugins_dir}")

    # 2. Предзагрузка ядра — иначе libvlc.dylib не найдёт core при dlopen
    try:
        if libvlccore.exists():
            ctypes.CDLL(str(libvlccore), mode=ctypes.RTLD_GLOBAL)
            _log(f"предзагружен {libvlccore.name}")
    except OSError as e:
        _log(f"не удалось предзагрузить libvlccore: {e}")

    # 3. Говорим python-vlc, где искать libvlc
    os.environ["PYTHON_VLC_LIB_PATH"] = str(libvlc)
    _log(f"PYTHON_VLC_LIB_PATH = {libvlc}")

    return True


def _setup_system_vlc():
    """
    Ищет системный VLC (cask, brew formula, ручная установка).
    Возвращает путь к libvlc.dylib или None.
    """
    candidates = [
        Path("/Applications/VLC.app/Contents/MacOS/lib"),
        Path("/opt/homebrew/lib"),
        Path("/usr/local/lib"),
    ]

    for lib_dir in candidates:
        if not lib_dir.exists():
            continue

        libvlc = lib_dir / "libvlc.dylib"
        libvlccore = lib_dir / "libvlccore.dylib"
        if not libvlccore.exists():
            for candidate in lib_dir.glob("libvlccore.*.dylib"):
                libvlccore = candidate
                break

        if libvlc.exists():
            # Предзагрузка core
            try:
                if libvlccore.exists():
                    ctypes.CDLL(str(libvlccore), mode=ctypes.RTLD_GLOBAL)
            except OSError as e:
                _log(f"не удалось предзагрузить libvlccore из {lib_dir}: {e}")
                continue

            os.environ["PYTHON_VLC_LIB_PATH"] = str(libvlc)
            _log(f"найден системный VLC: {libvlc}")

            # Плагины системного VLC
            plugins_dir = lib_dir.parent / "plugins"
            if plugins_dir.exists():
                os.environ["VLC_PLUGIN_PATH"] = str(plugins_dir)

            return str(libvlc)

    _log("системный VLC не найден ни в одном из стандартных мест")
    return None


def setup():
    """
    Точка входа. Вызывается из app.py ДО `import vlc`.
    Возвращает True, если VLC удалось настроить.
    """
    if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
        _log("запуск из собранного .app, использую встроенный VLC")
        ok = _setup_bundled_vlc()
        if ok:
            return True
        _log("встроенный VLC не сработал, пробую системный")

    if _setup_system_vlc():
        return True

    _log("VLC не найден. Установите VLC или используйте собранный .dmg.")
    return False