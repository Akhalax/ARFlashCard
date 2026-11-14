/*
 * PiperTTS — Ukrainian text-to-speech that runs entirely in the browser (no server, no API key).
 *
 * Pipeline (same building blocks as @diffusionstudio/vits-web, MIT):
 *   text -> espeak-ng phonemes (piper-phonemize compiled to WebAssembly)
 *        -> Piper VITS voice model (ONNX, run with onnxruntime-web)
 *        -> 16-bit PCM -> MP3 (lamejs)
 *
 * Voice models come from https://huggingface.co/rhasspy/piper-voices and are stored in the
 * browser's Cache Storage after the first download, so each voice is downloaded only once.
 *
 * ES module; also exposed as window.PiperTTS for classic scripts.
 */

const PHONEMIZE_JS = 'https://cdn.jsdelivr.net/npm/@diffusionstudio/vits-web@1.0.3/dist/piper-DeOu3H9E.js';
const PHONEMIZE_BASE = 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize';
const ORT_JS = 'https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.18.0/ort.min.js';
const ORT_WASM_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.18.0/';
const LAME_JS = 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js';
const VOICES_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
const CACHE_NAME = 'piper-voices-v1';

// Ukrainian Piper voices (rhasspy/piper-voices). `speaker` is the speaker id for multi-speaker models.
// The first voice is the default: Oleksa gave the most natural Ukrainian (stress) in testing.
export const VOICES = [
    { id: 'uk-oleksa-high', label: 'Олекса (чоловічий) · high · рекомендовано', model: 'uk/uk_UA/oleksa/high/uk_UA-oleksa-high.onnx', speaker: 0, sizeMB: 114 },
    { id: 'uk-tts-tetiana', label: 'Тетяна (жіночий) · medium', model: 'uk/uk_UA/ukrainian_tts/medium/uk_UA-ukrainian_tts-medium.onnx', speaker: 2, sizeMB: 77 },
    { id: 'uk-tts-mykyta', label: 'Микита (чоловічий) · medium', model: 'uk/uk_UA/ukrainian_tts/medium/uk_UA-ukrainian_tts-medium.onnx', speaker: 1, sizeMB: 77 },
    { id: 'uk-tts-lada', label: 'Лада (жіночий) · medium', model: 'uk/uk_UA/ukrainian_tts/medium/uk_UA-ukrainian_tts-medium.onnx', speaker: 0, sizeMB: 77 },
    { id: 'uk-tetiana-high', label: 'Тетяна (жіночий) · high', model: 'uk/uk_UA/tetiana/high/uk_UA-tetiana-high.onnx', speaker: 0, sizeMB: 114 },
    { id: 'uk-mykyta-high', label: 'Микита (чоловічий) · high', model: 'uk/uk_UA/mykyta/high/uk_UA-mykyta-high.onnx', speaker: 0, sizeMB: 114 },
    { id: 'uk-lada-x-low', label: 'Лада (жіночий) · x_low, малий', model: 'uk/uk_UA/lada/x_low/uk_UA-lada-x_low.onnx', speaker: 0, sizeMB: 21 }
];

// ==================== LOADING ====================

const scriptPromises = new Map();
function loadScript(src, globalName) {
    if (globalName && window[globalName]) return Promise.resolve(window[globalName]);
    if (!scriptPromises.has(src)) {
        scriptPromises.set(src, new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.crossOrigin = 'anonymous';
            s.onload = () => resolve(globalName ? window[globalName] : undefined);
            s.onerror = () => {
                scriptPromises.delete(src);
                reject(new Error(`Could not load ${src}`));
            };
            document.head.appendChild(s);
        }));
    }
    return scriptPromises.get(src);
}

let ortPromise = null;
function loadOrt() {
    if (!ortPromise) {
        ortPromise = loadScript(ORT_JS, 'ort').then(ort => {
            ort.env.wasm.wasmPaths = ORT_WASM_BASE;
            // Multi-threading needs cross-origin isolation (not available on GitHub Pages)
            ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
            return ort;
        }).catch(e => { ortPromise = null; throw e; });
    }
    return ortPromise;
}

let phonemizePromise = null;
function loadPhonemizer() {
    if (!phonemizePromise) {
        phonemizePromise = import(PHONEMIZE_JS).then(m => m.createPiperPhonemize)
            .catch(e => { phonemizePromise = null; throw e; });
    }
    return phonemizePromise;
}

// Fetch with Cache Storage (voice models are 20–115 MB) and download progress
async function fetchCached(url, onProgress) {
    let cache = null;
    try {
        cache = await caches.open(CACHE_NAME);
        const hit = await cache.match(url);
        if (hit) return hit.blob();
    } catch (e) {
        cache = null; // Cache Storage unavailable (e.g. private mode); download every time
    }

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
    const total = Number(response.headers.get('content-length')) || 0;
    let blob;
    if (onProgress && response.body) {
        const reader = response.body.getReader();
        const chunks = [];
        let loaded = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.length;
            onProgress({ url, loaded, total });
        }
        blob = new Blob(chunks);
    } else {
        blob = await response.blob();
    }
    if (cache) {
        try {
            await cache.put(url, new Response(blob));
        } catch (e) {
            console.warn('Could not cache', url, e);
        }
    }
    return blob;
}

// ==================== VOICES ====================

const voiceCache = new Map(); // model path -> Promise<{ session, config }>

function findVoice(voiceId) {
    const voice = VOICES.find(v => v.id === voiceId);
    if (!voice) throw new Error(`Unknown voice ${voiceId}`);
    return voice;
}

async function loadVoice(voice, onProgress) {
    if (!voiceCache.has(voice.model)) {
        voiceCache.set(voice.model, (async () => {
            const ort = await loadOrt();
            const configBlob = await fetchCached(VOICES_BASE + voice.model + '.json');
            const config = JSON.parse(await configBlob.text());
            const modelBlob = await fetchCached(VOICES_BASE + voice.model, onProgress);
            const session = await ort.InferenceSession.create(await modelBlob.arrayBuffer());
            return { session, config, ort };
        })().catch(e => { voiceCache.delete(voice.model); throw e; }));
    }
    return voiceCache.get(voice.model);
}

// Downloads (or loads from cache) the voice without synthesising anything
export async function prepare(voiceId, onProgress) {
    await Promise.all([loadVoice(findVoice(voiceId), onProgress), loadPhonemizer(), loadScript(LAME_JS, 'lamejs')]);
}

// Voices already stored in the browser cache
export async function cachedVoiceIds() {
    try {
        const cache = await caches.open(CACHE_NAME);
        const keys = (await cache.keys()).map(r => r.url);
        return VOICES.filter(v => keys.includes(VOICES_BASE + v.model)).map(v => v.id);
    } catch (e) {
        return [];
    }
}

// ==================== SYNTHESIS ====================

// Text -> phonemes with espeak-ng (one fresh WebAssembly instance per call, as in vits-web)
async function phonemize(text, espeakVoice) {
    const createPiperPhonemize = await loadPhonemizer();
    const lines = [];
    const errors = [];
    const module = await createPiperPhonemize({
        print: line => lines.push(line),
        printErr: line => errors.push(line),
        locateFile: file => file.endsWith('.wasm') ? `${PHONEMIZE_BASE}.wasm`
            : file.endsWith('.data') ? `${PHONEMIZE_BASE}.data` : file
    });
    module.callMain(['-l', espeakVoice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']);

    // Output is printed synchronously in practice; wait briefly just in case
    for (let i = 0; i < 50 && lines.length === 0; i++) {
        await new Promise(r => setTimeout(r, 20));
    }
    if (lines.length === 0) throw new Error(`Phonemizer produced no output${errors.length ? ': ' + errors.join(' ') : ''}`);

    // Use the phoneme strings, not the printed phoneme_ids: those follow the phonemizer's default
    // symbol table, while each voice model has its own (e.g. Ukrainian models know fewer symbols).
    const phonemes = [];
    lines.forEach(line => {
        try {
            const parsed = JSON.parse(line);
            if (Array.isArray(parsed.phonemes)) phonemes.push(...parsed.phonemes);
        } catch (e) { /* not a JSON line */ }
    });
    if (phonemes.length === 0) throw new Error('Phonemizer returned no phonemes');
    return phonemes;
}

// Models with phoneme_type "text" (e.g. ukrainian_tts) read letters instead of espeak phonemes.
// Piper lower-cases the text and splits it into NFD code points (й -> и + U+0306, ї -> і + U+0308).
function textToCodepoints(text) {
    const normalized = String(text)
        .toLowerCase()
        .replace(/[’ʼ‘`´]/g, "'")   // Ukrainian apostrophe variants
        .replace(/[–―]/g, '—')        // dashes
        .replace(/[«»“”„"]/g, '')     // quotes are not in the symbol table
        .normalize('NFD');
    return Array.from(normalized);
}

// Phonemes -> ids with the model's own tables (same as piper's phonemes_to_ids):
// BOS, PAD, then every known phoneme followed by PAD, then EOS. Unknown symbols are skipped.
function phonemesToIds(phonemes, config) {
    const idMap = config.phoneme_id_map;
    const phonemeMap = config.phoneme_map || {};
    const ids = [...idMap['^'], ...idMap['_']];
    phonemes.forEach(p => {
        (phonemeMap[p] || [p]).forEach(q => {
            if (idMap[q]) ids.push(...idMap[q], ...idMap['_']);
        });
    });
    ids.push(...idMap['$']);
    return ids;
}

/*
 * Synthesises `text` and returns { samples: Float32Array, sampleRate }.
 * options: { voiceId, rate (1 = normal, 0.8 = slower, 1.2 = faster), onProgress }
 */
export async function synthesize(text, options) {
    const voice = findVoice(options.voiceId);
    const { session, config, ort } = await loadVoice(voice, options.onProgress);
    const phonemes = config.phoneme_type === 'text'
        ? textToCodepoints(String(text).trim())
        : await phonemize(String(text).trim(), config.espeak.voice);
    const ids = phonemesToIds(phonemes, config);

    const inf = config.inference || {};
    const rate = options.rate || 1;
    const feeds = {
        input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
        input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
        scales: new ort.Tensor('float32', Float32Array.from([
            inf.noise_scale ?? 0.667,
            (inf.length_scale ?? 1) / rate,
            inf.noise_w ?? 0.8
        ]), [3])
    };
    if ((config.num_speakers || 0) > 1) {
        feeds.sid = new ort.Tensor('int64', BigInt64Array.from([BigInt(voice.speaker || 0)]), [1]);
    }
    const result = await session.run(feeds);
    const output = result.output || result[session.outputNames[0]];
    return { samples: output.data, sampleRate: config.audio.sample_rate };
}

// ==================== ENCODING ====================

function toInt16(samples) {
    // Normalise quiet output a little and convert to 16-bit PCM
    let peak = 0;
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
    const gain = peak > 0 && peak < 0.5 ? 0.9 / peak : 1;
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i] * gain));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return pcm;
}

export async function encodeMp3(samples, sampleRate, kbps) {
    const lamejs = await loadScript(LAME_JS, 'lamejs');
    const pcm = toInt16(samples);
    const encoder = new lamejs.Mp3Encoder(1, sampleRate, kbps || 64);
    const parts = [];
    const block = 1152;
    for (let i = 0; i < pcm.length; i += block) {
        const chunk = encoder.encodeBuffer(pcm.subarray(i, i + block));
        if (chunk.length) parts.push(new Uint8Array(chunk));
    }
    const end = encoder.flush();
    if (end.length) parts.push(new Uint8Array(end));
    return new Blob(parts, { type: 'audio/mpeg' });
}

export function encodeWav(samples, sampleRate) {
    const pcm = toInt16(samples);
    const buffer = new ArrayBuffer(44 + pcm.length * 2);
    const view = new DataView(buffer);
    const text = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
    text(0, 'RIFF'); view.setUint32(4, 36 + pcm.length * 2, true); text(8, 'WAVE');
    text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, pcm.length * 2, true);
    new Int16Array(buffer, 44).set(pcm);
    return new Blob([buffer], { type: 'audio/wav' });
}

// Text -> MP3 Blob
export async function speakToMp3(text, options) {
    const { samples, sampleRate } = await synthesize(text, options);
    return encodeMp3(samples, sampleRate, options.kbps);
}

window.PiperTTS = { VOICES, prepare, cachedVoiceIds, synthesize, encodeMp3, encodeWav, speakToMp3 };
window.dispatchEvent(new Event('piper-tts-ready'));
