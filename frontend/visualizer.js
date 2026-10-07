// ============================================================
// visualizer.js — WebGL ripple на фоне плеера
// ============================================================

const Visualizer = (() => {
    const MAX_DROPS = 16;

    let canvas = null;
    let gl = null;
    let program = null;

    let uResolution = null;
    let uTime = null;
    let uDrops = null;
    let uDropTimes = null;
    let uDropStrength = null;
    let uDropCount = null;
    let uIntensity = null;
    let uHueShift = null;

    // Кольцевой буфер капель
    const dropX = new Float32Array(MAX_DROPS);
    const dropY = new Float32Array(MAX_DROPS);
    const dropTimes = new Float32Array(MAX_DROPS).fill(-1000);
    const dropStrength = new Float32Array(MAX_DROPS).fill(1.0);
    const dropPositions = new Float32Array(MAX_DROPS * 2);
    let dropCount = 0;
    let nextDropIndex = 0;

    // Состояние
    let enabled = true;
    let intensity = 1.0;
    let hueShift = 0.0;
    let running = false;
    let startTime = 0;
    let lastFrameTime = 0;

    // Данные от плеера
    let waveformData = [];
    let currentPosition = 0;
    let isPlaying = false;

    // Управление частотой капель
    let lastPulseTime = 0;
    let lastAmplitude = 0;

    // ---- Загрузка шейдеров ----
    async function loadShader(path) {
        const res = await fetch(path);
        if (!res.ok) throw new Error(`Не удалось загрузить ${path}: ${res.status}`);
        return await res.text();
    }

    function compileShader(type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const log = gl.getShaderInfoLog(shader);
            console.error('Shader compile error:', log);
            console.error('Source:\n', source);
            throw new Error(log);
        }
        return shader;
    }

    // ---- Инициализация ----
    async function init() {
        canvas = document.getElementById('bgVisualizer');
        if (!canvas) {
            console.warn('visualizer: canvas #bgVisualizer не найден');
            return false;
        }

        gl = canvas.getContext('webgl', {
            alpha: false,
            antialias: false,
            depth: false,
            stencil: false,
            powerPreference: 'low-power',
        });
        if (!gl) {
            console.warn('visualizer: WebGL не поддерживается');
            return false;
        }

        try {
            const [vertexSrc, fragmentSrc] = await Promise.all([
                loadShader('shaders/vertex.glsl'),
                loadShader('shaders/ripple.glsl'),
            ]);

            const vs = compileShader(gl.VERTEX_SHADER, vertexSrc);
            const fs = compileShader(gl.FRAGMENT_SHADER, fragmentSrc);

            program = gl.createProgram();
            gl.attachShader(program, vs);
            gl.attachShader(program, fs);
            gl.linkProgram(program);

            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                throw new Error(gl.getProgramInfoLog(program));
            }
            gl.useProgram(program);

            // Полноэкранный прямоугольник
            const buf = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, buf);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
                -1, -1,  1, -1, -1,  1,
                -1,  1,  1, -1,  1,  1,
            ]), gl.STATIC_DRAW);

            const aPosition = gl.getAttribLocation(program, 'a_position');
            gl.enableVertexAttribArray(aPosition);
            gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

            // Uniforms
            uResolution   = gl.getUniformLocation(program, 'u_resolution');
            uTime         = gl.getUniformLocation(program, 'u_time');
            uDrops        = gl.getUniformLocation(program, 'u_drops');
            uDropTimes    = gl.getUniformLocation(program, 'u_dropTimes');
            uDropStrength = gl.getUniformLocation(program, 'u_dropStrength');
            uDropCount    = gl.getUniformLocation(program, 'u_dropCount');
            uIntensity    = gl.getUniformLocation(program, 'u_intensity');
            uHueShift     = gl.getUniformLocation(program, 'u_hueShift');

            resize();
            window.addEventListener('resize', resize);

            startTime = performance.now() / 1000;
            running = true;
            requestAnimationFrame(render);

            console.log('✅ visualizer: инициализирован');
            return true;
        } catch (e) {
            console.error('visualizer init error:', e);
            return false;
        }
    }

    // ---- Resize ----
    function resize() {
        if (!canvas || !gl) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5); // ограничиваем DPR для производительности
        const w = canvas.clientWidth * dpr;
        const h = canvas.clientHeight * dpr;
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
            gl.viewport(0, 0, w, h);
        }
    }

    // ---- Добавить каплю ----
    function addDrop(x, y, strength = 1.0) {
        if (!enabled) return;

        const rect = canvas.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        const cx = (x - rect.left) * dpr;
        const cy = (rect.height - (y - rect.top)) * dpr;

        const i = nextDropIndex;
        dropX[i] = cx;
        dropY[i] = cy;
        dropTimes[i] = performance.now() / 1000 - startTime;
        dropStrength[i] = strength;

        nextDropIndex = (nextDropIndex + 1) % MAX_DROPS;
        if (dropCount < MAX_DROPS) dropCount++;
    }

    // ---- Публичное API для клика по треку ----
    function dropAt(x, y) {
        addDrop(x, y, 2.5);
    }

    // ---- Данные от плеера ----
    function setWaveform(data) {
        if (data && data.waveform) {
            waveformData = data.waveform;
        } else {
            waveformData = [];
        }
    }

    function setPosition(pos) {
        currentPosition = Math.max(0, Math.min(1, pos));
    }

    function setPlaying(playing) {
        isPlaying = playing;
    }

	function pulseFromMusic(now) {
		if (!isPlaying || !enabled || waveformData.length === 0) return;

		const idx = Math.floor(currentPosition * waveformData.length);
		const amplitude = (waveformData[idx] || 0) / 255;

		// Считаем локальную среднюю — окно ~2 секунды
		// waveformData — массив амплитуд по всему треку
		// Длительность трека: waveformDuration (в секундах)
		// Значит, одна точка = waveformDuration / waveformData.length секунд
		// Окно 2 секунды = 2 * waveformData.length / waveformDuration точек
		const trackDuration = waveformDuration || 1;
		const pointsPerSecond = waveformData.length / trackDuration;
		const windowSize = Math.max(8, Math.floor(pointsPerSecond * 2)); // минимум 8 точек

		const from = Math.max(0, idx - windowSize);
		const to = Math.min(waveformData.length, idx + windowSize);

		let sum = 0;
		for (let i = from; i < to; i++) {
			sum += waveformData[i] / 255;
		}
		const localAvg = sum / (to - from);

		// Порог = локальная средняя * 1.3, но не ниже 0.12
		// Это адаптируется к тихим трекам и не даёт слишком много капель на громких
		const threshold = Math.max(0.12, localAvg * 0.7);

		if (amplitude < threshold) {
			lastAmplitude = amplitude;
			return;
		}

		// Частота капель: чем больше превышение порога — тем чаще
		const over = amplitude - threshold;
		const dropsPerSec = Math.min(8, over * 12);

		const delta = amplitude - lastAmplitude;
		const boost = delta > 0.1 ? 2.0 : 1.0;

		const interval = 1000 / Math.max(0.5, dropsPerSec * boost);
		if (now - lastPulseTime < interval) {
			lastAmplitude = amplitude;
			return;
		}
		lastPulseTime = now;
		lastAmplitude = amplitude;

		const rect = canvas.getBoundingClientRect();
		const x = rect.left + Math.random() * rect.width;
		const y = rect.top + Math.random() * rect.height;
		addDrop(x, y, 1.0);
	}

    // ---- Рендер ----
    function render() {
        if (!running) return;
        requestAnimationFrame(render);

        if (!enabled || !gl || !program) return;

        // Пропускаем кадры, если нечего рисовать
        const now = performance.now();
        const t = now / 1000 - startTime;

        // Пульсация от музыки
        pulseFromMusic(now);

        // Обновляем позиции капель
        for (let i = 0; i < MAX_DROPS; i++) {
            dropPositions[i * 2] = dropX[i];
            dropPositions[i * 2 + 1] = dropY[i];
        }

        gl.uniform2f(uResolution, canvas.width, canvas.height);
        gl.uniform1f(uTime, t);
        gl.uniform2fv(uDrops, dropPositions);
        gl.uniform1fv(uDropTimes, dropTimes);
        gl.uniform1fv(uDropStrength, dropStrength);
        gl.uniform1i(uDropCount, dropCount);
        gl.uniform1f(uIntensity, intensity);
        gl.uniform1f(uHueShift, hueShift);

        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // ---- Настройки ----
    function setEnabled(v) {
        enabled = !!v;
        if (canvas) {
            canvas.style.display = enabled ? 'block' : 'none';
        }
    }

    function setIntensity(v) {
        intensity = Math.max(0, Math.min(2, v));
    }

    function setHueShift(v) {
        hueShift = v;
    }

    function dispose() {
        running = false;
        if (gl) {
            gl.getExtension('WEBGL_lose_context')?.loseContext();
        }
    }

    return {
        init,
        dropAt,
        setWaveform,
        setPosition,
        setPlaying,
        setEnabled,
        setIntensity,
        setHueShift,
        dispose,
    };
})();