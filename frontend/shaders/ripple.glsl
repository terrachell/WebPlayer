precision highp float;

uniform vec2  u_resolution;
uniform float u_time;

const int MAX_DROPS = 16;

uniform vec2  u_drops[MAX_DROPS];
uniform float u_dropTimes[MAX_DROPS];
uniform float u_dropStrength[MAX_DROPS];
uniform int   u_dropCount;

uniform float u_intensity;   // глобальная интенсивность (0..2)
uniform float u_hueShift;    // сдвиг оттенка (для палитры)

vec3 hsl2rgb(float h, float s, float l) {
    vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return l + s * (rgb - 0.5) * (1.0 - abs(2.0 * l - 1.0));
}

float dropWave(vec2 uv, vec2 center, float time, float startT, float strength) {
    float age = time - startT;
    if (age < 0.0) return 0.0;

    float d = distance(uv, center);
    float radius = age * 0.35;

    float front  = exp(-abs(d - radius) * 12.0);
    float attack = smoothstep(0.0, 0.15, age);
    float decay  = exp(-age * 0.8);
    float spread = 1.0 / (1.0 + radius * 2.0);

    return front * attack * decay * spread * strength;
}

float waterHeight(vec2 uv, float time) {
    float h = 0.0;
    for (int i = 0; i < MAX_DROPS; i++) {
        if (i >= u_dropCount) break;
        vec2 center = u_drops[i] / u_resolution.y;
        h += dropWave(uv, center, time, u_dropTimes[i], u_dropStrength[i]);
    }
    return h;
}

void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution.y;

    float h = waterHeight(uv, u_time);

    vec2 bgUv = uv + vec2(h * 0.02, h * 0.015);

    vec2 c1 = vec2(0.3, 0.4);
    vec2 c2 = vec2(0.8, 0.7);
    float g1 = exp(-distance(bgUv, c1) * 2.0);
    float g2 = exp(-distance(bgUv, c2) * 2.5);

    vec3 bg = vec3(0.02, 0.03, 0.06);
    bg += vec3(0.05, 0.02, 0.10) * g1;
    bg += vec3(0.02, 0.06, 0.10) * g2;

    float hue = fract(u_time * 0.05 + u_hueShift);
    float waveBright = clamp(h * u_intensity * 1.5, -0.5, 1.0);

    vec3 crestColor  = hsl2rgb(hue, 0.75, 0.65);
    vec3 troughColor = hsl2rgb(fract(hue + 0.5), 0.6, 0.1);

    vec3 color = bg;
    color += crestColor  * max(waveBright, 0.0) * 1.5;
    color += troughColor * max(-waveBright, 0.0) * 0.8;

    vec2 vUv = gl_FragCoord.xy / u_resolution;
    float vignette = 1.0 - 0.4 * length(vUv - 0.5);
    color *= vignette;

    color = pow(color, vec3(0.85));

    gl_FragColor = vec4(color, 1.0);
}