// ============================================================
// ===== API-АДАПТЕР ==========================================
// ============================================================
// Единая точка вызова Python-методов через pywebview.
// Никакого HTTP-фолбэка: плеер работает только в pywebview.
// ============================================================

window.api = {
    async call(method, ...args) {
        if (!window.pywebview || !window.pywebview.api) {
            throw new Error(`pywebview API недоступен (метод: ${method})`);
        }
        return await window.pywebview.api[method](...args);
    },

    isReady() {
        return !!(window.pywebview && window.pywebview.api);
    }
};

// Глобальный флаг для остальных модулей.
// Выставляется в true в main.js, когда waitForApi получает ответ.
window.apiReady = false;