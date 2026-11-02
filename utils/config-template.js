/*
 * ARConfig — shared helpers for building ARFlashCard config.json
 *
 * Used by:
 *   - utils/ar-cards-generator.html  (builds config from the word lists it generated)
 *   - utils/config-builder.html      (builds config from a folder of image/audio files)
 *
 * Card layout produced for every word pair (same as the hand-written config.json):
 *   controller marker (pointer)
 *   source card: main = source image, alternative = source image (bigger), audio = source audio
 *   target card: main = question image (or target image), alternative = target image, audio = target audio
 *
 * Plain script (no modules) so it also works when the page is opened from disk.
 */
(function (global) {
    'use strict';

    const ARUCO_TYPE = 'aruco:ARUCO_4X4_1000';
    // Marker ids printed on the existing ArUco cards (Markers/Aruco_Cards.pdf)
    const DEFAULT_ARUCO_IDS = [946, 164, 13, 874, 959, 196];
    // 3x3 barcode markers encode values 0..63
    const BARCODE_MAX = 63;

    const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
    const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'm4a', 'aac'];
    const MANIFEST_NAME = 'cards.json';

    const DEFAULTS = {
        resolution: 'low',
        welcomeText: 'Натисніть тут <br>для початку роботи<br>з AR-Flash-картками',
        markerType: 'barcode',          // 'barcode' | 'aruco'
        markerIds: [],                  // card marker ids in print order; empty = automatic
        markerSize: 30,                 // matrixSize of card markers
        controllerTarget: 8,            // barcode value of the pointer marker
        controllerSize: 20,
        mainBoxSize: [37, 5, 37],
        altBoxSize: [45, 10, 45],
        useQuestionImage: true,         // target card front shows a "?" image
        questionImage: '',              // file name; empty = "<targetLang>_question.jpg"
        playOnControllerIntersect: true
    };

    const CONTROLLER_CONFIG = {
        bodySize: [5, 5, 35],
        tipSize: [5, 5, 10],
        bodyColor: '#008000',
        tipColor: '#ffffff',
        touchColor: '#ff6600',
        position: [0, -10, -20],
        rotation: [0, 0, 0],
        intersectionDelay: 100,
        touchSoundDuration: 300,
        collisionMode: '2d'
    };

    // ==================== FILE NAMES ====================

    function safeWord(word) {
        return String(word).trim().replace(/\s+/g, '_');
    }

    function imageFileName(lang, word) {
        return `${lang}_${safeWord(word)}.jpg`;
    }

    function audioFileName(lang, word) {
        return `${lang}_${safeWord(word)}.mp3`;
    }

    function questionFileName(lang) {
        return `${lang}_question.jpg`;
    }

    // ==================== MARKER IDS ====================

    function parseMarkerIds(text) {
        if (Array.isArray(text)) return text.map(Number).filter(Number.isFinite);
        return String(text || '')
            .split(/[\s,;]+/)
            .filter(Boolean)
            .map(Number)
            .filter(n => Number.isInteger(n) && n >= 0);
    }

    // Returns `count` marker ids for the cards or throws with a readable message
    function resolveMarkerIds(count, options) {
        const ids = parseMarkerIds(options.markerIds);
        const isAruco = options.markerType === 'aruco';

        if (ids.length === 0) {
            if (isAruco) {
                if (count > DEFAULT_ARUCO_IDS.length) {
                    throw new Error(`Needed ${count} ArUco marker ids, but only ${DEFAULT_ARUCO_IDS.length} default ids are known ` +
                        `(${DEFAULT_ARUCO_IDS.join(', ')}). Enter the ids of your printed markers.`);
                }
                return DEFAULT_ARUCO_IDS.slice(0, count);
            }
            // Barcodes: 1, 2, 3 ... skipping the controller value
            const auto = [];
            for (let v = 1; auto.length < count && v <= BARCODE_MAX; v++) {
                if (v !== Number(options.controllerTarget)) auto.push(v);
            }
            if (auto.length < count) {
                throw new Error(`Needed ${count} barcode markers, but 3x3 barcodes only have values 0..${BARCODE_MAX}.`);
            }
            return auto;
        }

        if (ids.length < count) {
            throw new Error(`Needed ${count} marker ids (2 per word pair), but only ${ids.length} were entered.`);
        }
        const unique = new Set(ids);
        if (unique.size !== ids.length) {
            throw new Error('Marker ids must not repeat.');
        }
        if (!isAruco) {
            if (ids.some(v => v > BARCODE_MAX)) {
                throw new Error(`3x3 barcode values must be between 0 and ${BARCODE_MAX}.`);
            }
            if (ids.slice(0, count).includes(Number(options.controllerTarget))) {
                throw new Error(`Barcode ${options.controllerTarget} is used by the pointer marker.`);
            }
        }
        return ids.slice(0, count);
    }

    // ==================== CONFIG BUILDING ====================

    /*
     * pairs: [{
     *   source: { lang, word, image, audio },
     *   target: { lang, word, image, audio }
     * }]
     * options: see DEFAULTS (missing keys fall back to DEFAULTS)
     * returns { config, warnings }
     */
    function buildConfig(pairs, options) {
        const opts = Object.assign({}, DEFAULTS, options || {});
        const warnings = [];

        if (!pairs || pairs.length === 0) {
            throw new Error('No word pairs to build the config from.');
        }

        const markerIds = resolveMarkerIds(pairs.length * 2, opts);
        const cardType = opts.markerType === 'aruco' ? ARUCO_TYPE : 'barcode';

        const markers = [{
            id: 1,
            type: 'barcode',
            target: Number(opts.controllerTarget),
            matrixSize: Number(opts.controllerSize),
            contentType: 'controller',
            controllerConfig: JSON.parse(JSON.stringify(CONTROLLER_CONFIG))
        }];

        const box = (size, textureFile) => ({
            type: 'BoxGeometry',
            size: size.slice(),
            textureFile: textureFile
        });

        const card = (target, frontImage, backImage, audio) => {
            const marker = {
                id: markers.length + 1,
                type: cardType,
                target: target,
                matrixSize: Number(opts.markerSize),
                contentType: 'primitive',
                primitive: box(opts.mainBoxSize, frontImage),
                alternativeContent: {
                    contentType: 'primitive',
                    primitive: box(opts.altBoxSize, backImage)
                }
            };
            if (audio) {
                marker.audioFile = audio;
                marker.playOnControllerIntersect = !!opts.playOnControllerIntersect;
            }
            markers.push(marker);
        };

        pairs.forEach((pair, i) => {
            const label = `pair ${i + 1} (${pair.source.word} / ${pair.target.word})`;
            if (!pair.source.image) warnings.push(`No source image for ${label}.`);
            if (!pair.target.image) warnings.push(`No target image for ${label}.`);
            if (!pair.source.audio) warnings.push(`No source audio for ${label}.`);
            if (!pair.target.audio) warnings.push(`No target audio for ${label}.`);

            const targetLang = pair.target.lang;
            const question = opts.useQuestionImage
                ? (opts.questionImage || questionFileName(targetLang))
                : pair.target.image;

            card(markerIds[i * 2], pair.source.image, pair.source.image, pair.source.audio);
            card(markerIds[i * 2 + 1], question, pair.target.image, pair.target.audio);
        });

        const config = {
            settings: {
                resolution: opts.resolution,
                welcomeText: opts.welcomeText
            },
            markers: markers
        };
        return { config, warnings };
    }

    // Manifest written next to the files so a folder can be re-assembled later
    function buildManifest(pairs, extra) {
        return Object.assign({
            version: 1,
            generatedAt: new Date().toISOString(),
            cards: pairs.map((pair, i) => ({
                key: String(i + 1).padStart(2, '0'),
                source: Object.assign({}, pair.source),
                target: Object.assign({}, pair.target)
            }))
        }, extra || {});
    }

    function stringify(config) {
        return JSON.stringify(config, null, 2);
    }

    // List of files referenced by a config (for checking that everything is present)
    function referencedFiles(config) {
        const files = new Set();
        (config.markers || []).forEach(m => {
            if (m.primitive && m.primitive.textureFile) files.add(m.primitive.textureFile);
            if (m.alternativeContent && m.alternativeContent.primitive && m.alternativeContent.primitive.textureFile) {
                files.add(m.alternativeContent.primitive.textureFile);
            }
            if (m.audioFile) files.add(m.audioFile);
        });
        return Array.from(files);
    }

    // ==================== GROUPING FILES FROM A FOLDER ====================

    /*
     * Parses "[NN_]lang_word.ext" / "lang-word.ext"
     *   01_en_Man.jpg      -> key 01, lang en, word Man
     *   pt-pt_Homem.mp3    -> lang pt-pt, word Homem
     *   pt-question.jpg    -> lang pt, word question
     */
    function parseFileName(name) {
        const m = /^(?:(\d+)[_-])?([a-z]{2}(?:-[a-z]{2})?)[_-](.+)\.([a-z0-9]+)$/i.exec(name);
        if (!m) return null;
        const ext = m[4].toLowerCase();
        let kind = null;
        if (IMAGE_EXTENSIONS.includes(ext)) kind = 'image';
        else if (AUDIO_EXTENSIONS.includes(ext)) kind = 'audio';
        if (!kind) return null;
        return {
            key: m[1] || null,
            lang: m[2].toLowerCase(),
            word: m[3].replace(/_/g, ' '),
            kind: kind
        };
    }

    function baseLang(lang) {
        return String(lang).split('-')[0];
    }

    /*
     * files: [{ name, path }]  — path is relative to the chosen folder (e.g. "cards/Man/en_Man.jpg")
     * manifest: parsed cards.json or null
     * returns {
     *   method, languages, sourceLang, targetLang,
     *   pairs, unpaired: { source: [entry], target: [entry] }, questionImages: { lang: path }, ignored: [path]
     * }
     * entry = { lang, word, image, audio, key, folder }
     */
    function groupFiles(files, manifest, preferredLangs) {
        const entries = new Map(); // "lang|word|folder" -> entry
        const questionImages = {};
        const ignored = [];

        files.forEach(file => {
            const info = parseFileName(file.name);
            if (!info) {
                if (file.name !== MANIFEST_NAME && file.name !== 'config.json') ignored.push(file.path);
                return;
            }
            const segments = file.path.split('/');
            const folder = segments.length > 1 ? segments.slice(0, -1).join('/') : '';

            if (info.word.toLowerCase() === 'question') {
                if (info.kind === 'image') questionImages[info.lang] = file.path;
                return;
            }

            const id = `${info.lang}|${info.word}|${folder}|${info.key || ''}`;
            if (!entries.has(id)) {
                entries.set(id, { lang: info.lang, word: info.word, image: null, audio: null, key: info.key, folder: folder });
            }
            const entry = entries.get(id);
            if (entry[info.kind]) ignored.push(file.path); // duplicate (e.g. jpg + png)
            else entry[info.kind] = file.path;
        });

        const all = Array.from(entries.values());
        const languages = Array.from(new Set(all.map(e => e.lang)));

        let sourceLang = preferredLangs && preferredLangs.source;
        let targetLang = preferredLangs && preferredLangs.target;
        if (!sourceLang || !languages.includes(sourceLang)) {
            sourceLang = languages.includes('en') ? 'en' : languages[0];
        }
        if (!targetLang || !languages.includes(targetLang) || targetLang === sourceLang) {
            targetLang = languages.find(l => l !== sourceLang);
        }

        const sources = all.filter(e => e.lang === sourceLang);
        const targets = all.filter(e => e.lang === targetLang);
        const used = new Set();
        const pairs = [];
        const methods = new Set();

        const take = (s, t, method) => {
            pairs.push({ source: s, target: t });
            used.add(s); used.add(t);
            methods.add(method);
        };

        // 1. Manifest from the generator (cards.json)
        if (manifest && Array.isArray(manifest.cards)) {
            const byFile = new Map();
            all.forEach(e => {
                [e.image, e.audio].filter(Boolean).forEach(p => {
                    byFile.set(p, e);
                    byFile.set(p.split('/').pop(), e);
                });
            });
            manifest.cards.forEach(c => {
                const find = side => side && (byFile.get(side.image) || byFile.get(side.audio));
                const s = find(c.source);
                const t = find(c.target);
                if (s && t && !used.has(s) && !used.has(t) && s.lang === sourceLang && t.lang === targetLang) {
                    take(s, t, 'manifest');
                }
            });
        }

        // 2. Shared numeric prefix: 01_en_Man.jpg + 01_pt-pt_Homem.jpg
        sources.filter(s => !used.has(s) && s.key).forEach(s => {
            const t = targets.find(t => !used.has(t) && t.key === s.key);
            if (t) take(s, t, 'prefix');
        });

        // 3. Same sub-folder: Man/en_Man.jpg + Man/pt-pt_Homem.jpg
        sources.filter(s => !used.has(s) && s.folder).forEach(s => {
            const sameFolder = targets.filter(t => !used.has(t) && t.folder === s.folder);
            const sourcesInFolder = sources.filter(x => !used.has(x) && x.folder === s.folder);
            if (sameFolder.length === 1 && sourcesInFolder.length === 1) take(s, sameFolder[0], 'folder');
        });

        // 4. Same word in both languages (e.g. names, loanwords)
        sources.filter(s => !used.has(s)).forEach(s => {
            const t = targets.find(t => !used.has(t) && t.word.toLowerCase() === s.word.toLowerCase());
            if (t) take(s, t, 'word');
        });

        const sortKey = e => `${e.key || ''}|${e.folder}|${e.word.toLowerCase()}`;
        if (methods.has('prefix') || methods.has('folder')) {
            pairs.sort((a, b) => sortKey(a.source).localeCompare(sortKey(b.source)));
        }

        return {
            method: Array.from(methods),
            languages,
            sourceLang,
            targetLang,
            pairs,
            unpaired: {
                source: sources.filter(e => !used.has(e)),
                target: targets.filter(e => !used.has(e))
            },
            otherLanguages: languages.filter(l => l !== sourceLang && l !== targetLang),
            questionImages,
            ignored
        };
    }

    // Question image for a target language: exact ("pt-pt_question.jpg") or base ("pt-question.jpg")
    function findQuestionImage(questionImages, lang) {
        if (questionImages[lang]) return questionImages[lang];
        const base = baseLang(lang);
        const key = Object.keys(questionImages).find(l => baseLang(l) === base);
        return key ? questionImages[key] : null;
    }

    // ==================== SHARED SETTINGS FORM ====================

    function escapeHtml(text) {
        return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // Renders the config settings form into `container` (uses the pages' .config-row/.config-item styles)
    function renderSettingsForm(container, values) {
        const v = Object.assign({}, DEFAULTS, values || {});
        container.innerHTML = `
            <div class="config-row" style="flex-wrap: wrap;">
                <div class="config-item">
                    <label>Card markers:</label>
                    <select data-field="markerType">
                        <option value="barcode" ${v.markerType === 'barcode' ? 'selected' : ''}>Barcode 3x3</option>
                        <option value="aruco" ${v.markerType === 'aruco' ? 'selected' : ''}>ArUco 4x4 (1000)</option>
                    </select>
                </div>
                <div class="config-item" style="flex: 2; min-width: 220px;">
                    <label>Marker ids in print order (2 per pair):</label>
                    <input type="text" data-field="markerIds" value="${escapeHtml(parseMarkerIds(v.markerIds).join(', '))}"
                           placeholder="empty = automatic (barcode 1, 2, 3… / ArUco ${DEFAULT_ARUCO_IDS.join(', ')})">
                </div>
                <div class="config-item">
                    <label>Pointer barcode:</label>
                    <input type="number" data-field="controllerTarget" value="${v.controllerTarget}" min="0" max="${BARCODE_MAX}">
                </div>
                <div class="config-item">
                    <label>Detection quality:</label>
                    <select data-field="resolution">
                        <option value="low" ${v.resolution === 'low' ? 'selected' : ''}>Low (faster, stable)</option>
                        <option value="high" ${v.resolution === 'high' ? 'selected' : ''}>High</option>
                    </select>
                </div>
            </div>
            <div class="config-row" style="flex-wrap: wrap;">
                <div class="config-item">
                    <label>Card box size (W, H, D):</label>
                    <input type="text" data-field="mainBoxSize" value="${v.mainBoxSize.join(', ')}">
                </div>
                <div class="config-item">
                    <label>Touched box size (W, H, D):</label>
                    <input type="text" data-field="altBoxSize" value="${v.altBoxSize.join(', ')}">
                </div>
                <div class="config-item">
                    <label>Card marker size:</label>
                    <input type="number" data-field="markerSize" value="${v.markerSize}" min="1">
                </div>
                <div class="config-item" style="flex: 2; min-width: 220px;">
                    <label>
                        <input type="checkbox" data-field="useQuestionImage" ${v.useQuestionImage ? 'checked' : ''} style="width: auto;">
                        Target card shows a "?" image until touched:
                    </label>
                    <input type="text" data-field="questionImage" value="${escapeHtml(v.questionImage)}"
                           placeholder="empty = &lt;language&gt;_question.jpg">
                </div>
            </div>
            <div class="config-row" style="flex-wrap: wrap;">
                <div class="config-item" style="flex: 1;">
                    <label>Welcome text (HTML allowed):</label>
                    <input type="text" data-field="welcomeText" value="${escapeHtml(v.welcomeText)}">
                </div>
            </div>`;
    }

    function readSettingsForm(container) {
        const field = name => container.querySelector(`[data-field="${name}"]`);
        const size = (name, fallback) => {
            const nums = String(field(name).value).split(/[\s,;x×]+/).filter(Boolean).map(Number);
            return nums.length === 3 && nums.every(n => Number.isFinite(n) && n > 0) ? nums : fallback.slice();
        };
        return {
            markerType: field('markerType').value,
            markerIds: parseMarkerIds(field('markerIds').value),
            controllerTarget: parseInt(field('controllerTarget').value, 10),
            controllerSize: DEFAULTS.controllerSize,
            resolution: field('resolution').value,
            mainBoxSize: size('mainBoxSize', DEFAULTS.mainBoxSize),
            altBoxSize: size('altBoxSize', DEFAULTS.altBoxSize),
            markerSize: parseFloat(field('markerSize').value) || DEFAULTS.markerSize,
            useQuestionImage: field('useQuestionImage').checked,
            questionImage: field('questionImage').value.trim(),
            welcomeText: field('welcomeText').value,
            playOnControllerIntersect: DEFAULTS.playOnControllerIntersect
        };
    }

    // ==================== DOWNLOAD ====================

    function downloadText(fileName, text, mime) {
        const blob = new Blob([text], { type: mime || 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    global.ARConfig = {
        DEFAULTS,
        DEFAULT_ARUCO_IDS,
        MANIFEST_NAME,
        safeWord,
        imageFileName,
        audioFileName,
        questionFileName,
        parseMarkerIds,
        resolveMarkerIds,
        buildConfig,
        buildManifest,
        stringify,
        referencedFiles,
        parseFileName,
        groupFiles,
        findQuestionImage,
        renderSettingsForm,
        readSettingsForm,
        downloadText,
        escapeHtml
    };
})(window);
