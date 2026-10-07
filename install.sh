#!/bin/bash

# ============================================================
# Установщик Music Player 3.1.0 для macOS
# ============================================================

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="/tmp/music_player_build"
APP_DEST="$HOME/Applications/MusicPlayer.app"
USER_DATA_DIR="$HOME/Library/Application Support/MusicPlayer"

echo -e "${BLUE}=========================================${NC}"
echo -e "${BLUE}  🎵 Music Player 3.1.0 Installer (macOS)${NC}"
echo -e "${BLUE}=========================================${NC}"

# ============================================================
# 1. Homebrew
# ============================================================
echo -e "\n${YELLOW}📦 Проверка Homebrew...${NC}"
if ! command -v brew &> /dev/null; then
    echo -e "${YELLOW}⚠️ Homebrew не найден. Установка...${NC}"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
else
    echo -e "${GREEN}✅ Homebrew уже установлен${NC}"
fi

# ============================================================
# 2. VLC — три источника
# ============================================================
echo -e "\n${YELLOW}📺 Проверка VLC...${NC}"

VLC_APP_PATH="/Applications/VLC.app"
VLC_APPSTORE_PATH="/Applications/VLC media player.app"
VLC_FOUND=""
VLC_LIB_HINT=""

# --- Вариант A: VLC.app (cask / ручная установка) ---
if [ -d "$VLC_APP_PATH" ]; then
    if [ -f "$VLC_APP_PATH/Contents/MacOS/lib/libvlc.dylib" ]; then
        VLC_FOUND="cask"
        VLC_LIB_HINT="$VLC_APP_PATH/Contents/MacOS/lib"
        echo -e "${GREEN}✅ VLC.app (cask/ручной) с libvlc: $VLC_LIB_HINT${NC}"
    else
        echo -e "${YELLOW}⚠️ VLC.app найден, но без libvlc — возможно, App Store-версия${NC}"
    fi
fi

# --- Вариант B: VLC из App Store (sandboxed, libvlc НЕТ) ---
if [ -z "$VLC_FOUND" ] && [ -d "$VLC_APPSTORE_PATH" ]; then
    echo -e "${RED}❌ Найден VLC из App Store. У него нет libvlc — для нашего плеера он не подойдёт.${NC}"
    echo -e "${YELLOW}   Удалите его и установите VLC с videolan.org, либо разрешите установку через brew.${NC}"
    echo -e "${YELLOW}   Продолжить и установить cask-версию параллельно? [y/N]${NC}"
    read -r ans
    if [[ ! "$ans" =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# --- Вариант C: brew formula vlc (без .app) ---
if [ -z "$VLC_FOUND" ]; then
    if brew list --formula vlc &> /dev/null; then
        for p in "/opt/homebrew/lib" "/usr/local/lib"; do
            if [ -f "$p/libvlc.dylib" ] || [ -f "$p/libvlc.5.dylib" ]; then
                VLC_FOUND="brew"
                VLC_LIB_HINT="$p"
                break
            fi
        done
        if [ -z "$VLC_LIB_HINT" ]; then
            VLC_LIB_HINT="$(brew --prefix vlc 2>/dev/null)/lib"
        fi
        echo -e "${GREEN}✅ VLC (brew formula): $VLC_LIB_HINT${NC}"
    fi
fi

# --- Ничего не нашли — ставим cask ---
if [ -z "$VLC_FOUND" ]; then
    echo -e "${YELLOW}⚠️ VLC не найден. Установка через brew cask...${NC}"
    brew install --cask vlc
    if [ -d "$VLC_APP_PATH" ]; then
        VLC_FOUND="cask"
        VLC_LIB_HINT="$VLC_APP_PATH/Contents/MacOS/lib"
        echo -e "${GREEN}✅ VLC.app установлен${NC}"
    else
        echo -e "${RED}❌ Не удалось установить VLC. Установите вручную с https://www.videolan.org/vlc/ и запустите снова.${NC}"
        exit 1
    fi
fi

# ============================================================
# 3. ffmpeg
# ============================================================
echo -e "\n${YELLOW}🎬 Проверка ffmpeg...${NC}"
if ! command -v ffmpeg &> /dev/null; then
    echo -e "${YELLOW}⚠️ ffmpeg не найден. Установка...${NC}"
    brew install ffmpeg
else
    echo -e "${GREEN}✅ ffmpeg уже установлен${NC}"
fi

# ============================================================
# 4. Python
# ============================================================
echo -e "\n${YELLOW}🐍 Проверка Python...${NC}"

ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    echo -e "${BLUE}🔧 Apple Silicon${NC}"
    if ! command -v python3 &> /dev/null; then
        brew install python@3.11
    else
        PYTHON_ARCH=$(file $(which python3) | grep -o "arm64" || echo "x86_64")
        if [ "$PYTHON_ARCH" = "x86_64" ]; then
            echo -e "${YELLOW}⚠️ Python собран для Intel. Переустановка...${NC}"
            brew reinstall python@3.11
        else
            echo -e "${GREEN}✅ Python для ARM${NC}"
        fi
    fi
else
    echo -e "${BLUE}🔧 Intel${NC}"
    if ! command -v python3 &> /dev/null; then
        brew install python@3.11
    else
        echo -e "${GREEN}✅ Python установлен${NC}"
    fi
fi

# ============================================================
# 5. Python-зависимости (venv)
# ============================================================
echo -e "\n${YELLOW}📦 Установка Python-зависимостей...${NC}"

VENV_DIR="/tmp/music_player_venv"
rm -rf "$VENV_DIR"
python3 -m venv "$VENV_DIR"
source "$VENV_DIR/bin/activate"

pip install --upgrade pip > /dev/null
pip install pywebview pydub numpy python-vlc pyinstaller tinytag

echo -e "${GREEN}✅ Зависимости установлены${NC}"

# ============================================================
# 6. Исходники
# ============================================================
echo -e "\n${YELLOW}📂 Проверка исходников...${NC}"

for f in app.py music_player.py; do
    if [ ! -f "$SCRIPT_DIR/$f" ]; then
        echo -e "${RED}❌ $f не найден в $SCRIPT_DIR${NC}"
        exit 1
    fi
done
if [ ! -d "$SCRIPT_DIR/frontend" ]; then
    echo -e "${RED}❌ frontend/ не найден в $SCRIPT_DIR${NC}"
    exit 1
fi
for f in frontend/visualizer.js frontend/shaders/vertex.glsl frontend/shaders/ripple.glsl; do
    if [ ! -f "$SCRIPT_DIR/$f" ]; then
        echo -e "${RED}❌ $f не найден в $SCRIPT_DIR${NC}"
        exit 1
    fi
done
echo -e "${GREEN}✅ Исходники на месте${NC}"

# ============================================================
# 7. Подготовка сборки
# ============================================================
echo -e "\n${YELLOW}🔧 Подготовка сборки...${NC}"

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

cp "$SCRIPT_DIR/app.py" "$BUILD_DIR/"
cp "$SCRIPT_DIR/music_player.py" "$BUILD_DIR/"
cp -r "$SCRIPT_DIR/frontend" "$BUILD_DIR/"

# Иконка
ICON_PATH=""
if [ -f "$SCRIPT_DIR/icon.icns" ]; then
    ICON_PATH="$SCRIPT_DIR/icon.icns"
    cp "$ICON_PATH" "$BUILD_DIR/icon.icns"
    echo -e "${GREEN}✅ icon.icns${NC}"
elif [ -f "$SCRIPT_DIR/icon.png" ]; then
    echo -e "${YELLOW}🔄 Конвертация PNG → ICNS...${NC}"
    mkdir -p "$BUILD_DIR/icon.iconset"
    sips -z 16 16     "$SCRIPT_DIR/icon.png" --out "$BUILD_DIR/icon.iconset/icon_16x16.png"      2>/dev/null || true
    sips -z 32 32     "$SCRIPT_DIR/icon.png" --out "$BUILD_DIR/icon.iconset/icon_16x16@2x.png"   2>/dev/null || true
    sips -z 32 32     "$SCRIPT_DIR/icon.png" --out "$BUILD_DIR/icon.iconset/icon_32x32.png"      2>/dev/null || true
    sips -z 64 64     "$SCRIPT_DIR/icon.png" --out "$BUILD_DIR/icon.iconset/icon_32x32@2x.png"   2>/dev/null || true
    sips -z 128 128   "$SCRIPT_DIR/icon.png" --out "$BUILD_DIR/icon.iconset/icon_128x128.png"    2>/dev/null || true
    sips -z 256 256   "$SCRIPT_DIR/icon.png" --out "$BUILD_DIR/icon.iconset/icon_128x128@2x.png" 2>/dev/null || true
    sips -z 256 256   "$SCRIPT_DIR/icon.png" --out "$BUILD_DIR/icon.iconset/icon_256x256.png"    2>/dev/null || true
    sips -z 512 512   "$SCRIPT_DIR/icon.png" --out "$BUILD_DIR/icon.iconset/icon_256x256@2x.png" 2>/dev/null || true
    sips -z 512 512   "$SCRIPT_DIR/icon.png" --out "$BUILD_DIR/icon.iconset/icon_512x512.png"    2>/dev/null || true
    sips -z 1024 1024 "$SCRIPT_DIR/icon.png" --out "$BUILD_DIR/icon.iconset/icon_512x512@2x.png" 2>/dev/null || true
    iconutil -c icns "$BUILD_DIR/icon.iconset" -o "$BUILD_DIR/icon.icns" 2>/dev/null || true
    rm -rf "$BUILD_DIR/icon.iconset"
    if [ -f "$BUILD_DIR/icon.icns" ]; then
        ICON_PATH="$BUILD_DIR/icon.icns"
        echo -e "${GREEN}✅ Иконка сконвертирована${NC}"
    fi
fi

echo -e "${GREEN}✅ Файлы в $BUILD_DIR${NC}"

# ============================================================
# 8. Сборка .app
# ============================================================
echo -e "\n${YELLOW}📱 Сборка MusicPlayer.app...${NC}"

cd "$BUILD_DIR"

PYINSTALLER_ARGS=(
    --windowed
    --name "MusicPlayer"
    --add-data "frontend:frontend"
    --hidden-import "webview"
    --hidden-import "webview.platforms.cocoa"
    --hidden-import "vlc"
    --hidden-import "pydub"
    --hidden-import "numpy"
    --hidden-import "tinytag"
    --noconfirm
)

if [ -n "$ICON_PATH" ] && [ -f "$ICON_PATH" ]; then
    PYINSTALLER_ARGS+=(--icon "$ICON_PATH")
fi

rm -rf build dist *.spec
pyinstaller "${PYINSTALLER_ARGS[@]}" app.py

if [ ! -d "$BUILD_DIR/dist/MusicPlayer.app" ]; then
    echo -e "${RED}❌ Ошибка сборки .app${NC}"
    exit 1
fi

echo -e "${GREEN}✅ .app собран${NC}"

# ============================================================
# 9. Установка
# ============================================================
echo -e "\n${YELLOW}📱 Установка в ~/Applications...${NC}"

APP_SOURCE="$BUILD_DIR/dist/MusicPlayer.app"
mkdir -p "$HOME/Applications"
rm -rf "$APP_DEST"
cp -r "$APP_SOURCE" "$APP_DEST"
xattr -cr "$APP_DEST" 2>/dev/null || true

echo -e "${GREEN}✅ Установлено: $APP_DEST${NC}"

# ============================================================
# 10. Перенос пользовательских данных
# ============================================================
echo -e "\n${YELLOW}📂 Перенос данных...${NC}"

mkdir -p "$USER_DATA_DIR"

MIGRATED=0
for f in playlists.json state.json metadata.json; do
    SRC="$SCRIPT_DIR/$f"
    DST="$USER_DATA_DIR/$f"
    if [ -f "$SRC" ] && [ ! -f "$DST" ]; then
        cp "$SRC" "$DST"
        echo -e "${GREEN}  ✅ $f${NC}"
        MIGRATED=$((MIGRATED + 1))
    fi
done

for d in covers waveform_cache tracks; do
    SRC="$SCRIPT_DIR/$d"
    DST="$USER_DATA_DIR/$d"
    if [ -d "$SRC" ] && [ ! -d "$DST" ]; then
        cp -r "$SRC" "$DST"
        echo -e "${GREEN}  ✅ $d/${NC}"
        MIGRATED=$((MIGRATED + 1))
    fi
done

if [ "$MIGRATED" -eq 0 ]; then
    echo -e "${BLUE}  ℹ️  Нечего переносить${NC}"
fi

echo -e "${GREEN}✅ Данные: $USER_DATA_DIR${NC}"

# ============================================================
# 11. Очистка
# ============================================================
echo -e "\n${YELLOW}🧹 Очистка...${NC}"
rm -rf "$BUILD_DIR"
rm -rf "$VENV_DIR"
echo -e "${GREEN}✅ Очистка завершена${NC}"

# ============================================================
# 12. .dmg
# ============================================================
echo -e "\n${YELLOW}💿 Создание .dmg...${NC}"

DMG_PATH="$SCRIPT_DIR/MusicPlayer-3.1.dmg"
VOLUME_NAME="Music Player 3.1"

if [ -d "$APP_DEST" ]; then
    TMP_DIR="/tmp/dmg-build"
    rm -rf "$TMP_DIR"
    mkdir -p "$TMP_DIR"

    # Приложение
    cp -R "$APP_DEST" "$TMP_DIR/"

    # Симлинк на /Applications — чтобы перетаскивание работало
    ln -s /Applications "$TMP_DIR/Applications"

    # Инструкция внутри .dmg
    cat > "$TMP_DIR/ЧИТАЙ_МЕНЯ.txt" << 'EOF'
============================================================
  Music Player 3.1.0 — установка
============================================================

ЧТО НУЖНО СДЕЛАТЬ ПЕРЕД ПЕРВЫМ ЗАПУСКОМ:

1. Установите VLC (если ещё не установлен):
   👉 https://www.videolan.org/vlc/

   Без VLC плеер не сможет воспроизводить музыку.
   VLC нужен как библиотека, отдельное окно открываться
   не будет.

2. Перетащите MusicPlayer.app в папку Applications
   (иконка справа).

3. Запустите MusicPlayer из Launchpad или из Applications.

4. При первом запуске macOS может сказать
   «MusicPlayer.app повреждён» или «не удаётся открыть».
   Это не вирус, а защита Gatekeeper.
   Решение: правый клик по MusicPlayer.app → «Открыть» →
   подтвердить. Или в терминале:
     xattr -cr /Applications/MusicPlayer.app

------------------------------------------------------------

ГДЕ ЛЕЖАТ ДАННЫЕ:

  Плейлисты, настройки, обложки и метаданные:
    ~/Library/Application Support/MusicPlayer/

  Там же: playlists.json, state.json, metadata.json,
  covers/, waveform_cache/.

  При удалении .app эти файлы НЕ удаляются —
  можно переустановить плеер и всё останется на месте.

------------------------------------------------------------

ЧТО УМЕЕТ:

  • Читает теги (название, исполнитель, альбом, обложка)
    через tinytag.
  • Поддерживает почти все аудиоформаты (через VLC).
  • Виртуальные плейлисты: ⭐ Избранное и 🔥 Часто
    прослушиваемое.
  • Эквалайзер с пресетами и своими профилями.
  • Бегущая строка для длинных названий.
  • ПКМ по треку: переименовать, задать исполнителя,
    альбом, добавить в избранное.
  • Кэш waveform (бинарный, компактный).
    • Фоновый визуализатор — волны реагируют на музыку.
    Отключается в настройках.
  • Две темы: «Стандартная» и «Минимализм»
    (прозрачные панели, только текст и волны).
  • Синхронизация визуализатора с музыкой
    (клавиши [ и ] для подстройки).

------------------------------------------------------------

ПРОБЛЕМЫ:

  Если пишет «VLC not found»:
    Проверьте, что VLC.app лежит в /Applications.
    Если ставили через App Store — удалите и поставьте
    с videolan.org (App Store-версия без libvlc).

  Если не запускается:
    Откройте Terminal и выполните:
      ~/Applications/MusicPlayer.app/Contents/MacOS/MusicPlayer
    Скиньте разработчику вывод.

============================================================
EOF

    rm -f "$DMG_PATH"
    hdiutil create -volname "$VOLUME_NAME" \
        -srcfolder "$TMP_DIR" \
        -ov \
        -format UDZO \
        "$DMG_PATH" 2>/dev/null || true

    rm -rf "$TMP_DIR"

    if [ -f "$DMG_PATH" ]; then
        echo -e "${GREEN}✅ .dmg: $DMG_PATH${NC}"
        echo -e "${BLUE}📦 Размер: $(du -h "$DMG_PATH" | cut -f1)${NC}"
    fi
fi

# ============================================================
# 13. Итог
# ============================================================
echo -e "\n${GREEN}========================================${NC}"
echo -e "${GREEN}  🎉 Установка завершена!${NC}"
echo -e "${GREEN}========================================${NC}"
echo -e ""
echo -e "📱 Приложение:          ${BLUE}$APP_DEST${NC}"
echo -e "📂 Данные пользователя: ${BLUE}$USER_DATA_DIR${NC}"
echo -e "📺 VLC:                 ${BLUE}$VLC_FOUND${NC}"
if [ -n "$VLC_LIB_HINT" ]; then
    echo -e "📚 VLC libs:            ${BLUE}$VLC_LIB_HINT${NC}"
fi
echo -e ""
echo -e "🚀 Запуск:"
echo -e "  ${YELLOW}open \"$APP_DEST\"${NC}"
echo -e ""
echo -e "${GREEN}🎵 Приятного использования!${NC}"