/*
 * ARConfig — shared helpers for building ARFlashCard config.json ("Term – Definition" cards)
 *
 * Used by:
 *   - utils/ar-cards-generator.html  (builds config from the term/definition lists it generated)
 *   - utils/config-builder.html      (builds config from a folder of image/audio files)
 *
 * Card layout produced for every term–definition pair:
 *   controller marker (pointer; ignored by the app in "chip" mode)
 *   term card:       main = "?" (term), alternative = term image, audio = "<term prompt>: <term>"
 *   definition card: main = "?" (definition), alternative = definition image, audio = "<definition prompt>: <definition>"
 * Each card also gets a "caption" ("<prompt> – <text>") that the app shows on screen when the card is opened.
 *
 * In "chip" mode the app shows the alternative (revealed) image straight away, so both modes use one config.
 *
 * File names (inside config/media/):
 *   01_term_<term>.jpg / .mp3   01_definition_<term>.jpg / .mp3   question_term.jpg   question_definition.jpg
 * The number keeps the pair together and sets the order; <term> is only for readability.
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
    const ROLES = ['term', 'definition'];

    const DEFAULTS = {
        resolution: 'low',
        welcomeText: 'AR-картки<br>«Термін – Визначення»<br>Оберіть режим роботи',
        markerType: 'barcode',          // 'barcode' | 'aruco'
        markerIds: [],                  // card marker ids in print order; empty = automatic
        markerSize: 30,                 // matrixSize of card markers
        controllerTarget: 8,            // barcode value of the pointer marker
        controllerSize: 20,
        mainBoxSize: [37, 5, 37],
        altBoxSize: [45, 10, 45],
        hideUntilTouched: true,         // both cards show a "?" image until the pointer touches them (card mode)
        questionTermImage: 'question_term.jpg',
        questionDefinitionImage: 'question_definition.jpg',
        termPrompt: 'Дайте визначення терміну',
        definitionPrompt: 'Якому терміну відповідає визначення',
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

    // Readable, file-system-safe part of a name: letters (any alphabet) and digits, max 30 chars
    function slug(text) {
        const s = String(text || '')
            .normalize('NFC')
            .trim()
            .replace(/[^\p{L}\p{N}]+/gu, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 30)
            .replace(/_+$/, '');
        return s || 'card';
    }

    function pairKey(index) {
        return String(index + 1).padStart(2, '0');
    }

    function mediaFileName(index, role, term, ext) {
        return `${pairKey(index)}_${role}_${slug(term)}.${ext}`;
    }

    function imageFileName(index, role, term) {
        return mediaFileName(index, role, term, 'jpg');
    }

    function audioFileName(index, role, term) {
        return mediaFileName(index, role, term, 'mp3');
    }

    function questionFileName(role) {
        return `question_${role === 'term' ? 'term' : 'definition'}.jpg`;
    }

    // On-screen caption: "Дайте визначення терміну – Атом" (just the prompt if the text is unknown)
    function captionText(prompt, text) {
        const p = String(prompt || '').trim();
        const t = String(text || '').trim();
        if (!p) return t;
        return t ? `${p} – ${t}` : p;
    }

    // Spoken text: "Дайте визначення терміну: Атом." (a colon gives a natural pause)
    function spokenText(prompt, text) {
        const p = String(prompt || '').trim();
        const t = String(text || '').trim();
        if (!p) return t;
        return t ? `${p}: ${t}` : p;
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
            throw new Error(`Needed ${count} marker ids (2 per term–definition pair), but only ${ids.length} were entered.`);
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
     *   term:       { text, image, audio },
     *   definition: { text, image, audio }
     * }]
     * options: see DEFAULTS (missing keys fall back to DEFAULTS)
     * returns { config, warnings }
     */
    function buildConfig(pairs, options) {
        const opts = Object.assign({}, DEFAULTS, options || {});
        const warnings = [];

        if (!pairs || pairs.length === 0) {
            throw new Error('No term–definition pairs to build the config from.');
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

        const card = (target, frontImage, backImage, side, role, caption) => {
            const marker = {
                id: markers.length + 1,
                type: cardType,
                target: target,
                matrixSize: Number(opts.markerSize),
                role: role,
                contentType: 'primitive',
                primitive: box(opts.mainBoxSize, frontImage),
                alternativeContent: {
                    contentType: 'primitive',
                    primitive: box(opts.altBoxSize, backImage)
                }
            };
            if (caption) marker.caption = caption;
            if (side.audio) marker.audioFile = side.audio;
            if (side.audio) marker.playOnControllerIntersect = !!opts.playOnControllerIntersect;
            markers.push(marker);
        };

        const questionTerm = opts.questionTermImage || questionFileName('term');
        const questionDefinition = opts.questionDefinitionImage || questionFileName('definition');

        pairs.forEach((pair, i) => {
            const label = `pair ${i + 1} (${pair.term.text || pair.term.image || '?'})`;
            if (!pair.term.image) warnings.push(`No term image for ${label}.`);
            if (!pair.definition.image) warnings.push(`No definition image for ${label}.`);
            if (!pair.term.audio) warnings.push(`No term audio for ${label}.`);
            if (!pair.definition.audio) warnings.push(`No definition audio for ${label}.`);

            const termFront = opts.hideUntilTouched ? questionTerm : pair.term.image;
            const definitionFront = opts.hideUntilTouched ? questionDefinition : pair.definition.image;
            card(markerIds[i * 2], termFront, pair.term.image, pair.term, 'term',
                captionText(opts.termPrompt, pair.term.text));
            card(markerIds[i * 2 + 1], definitionFront, pair.definition.image, pair.definition, 'definition',
                captionText(opts.definitionPrompt, pair.definition.text));
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
            version: 3,
            kind: 'term-definition',
            generatedAt: new Date().toISOString(),
            cards: pairs.map((pair, i) => ({
                key: pairKey(i),
                term: Object.assign({}, pair.term),
                definition: Object.assign({}, pair.definition)
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
     * Parses media file names:
     *   01_term_Фотосинтез.jpg        -> key 01, role term, label Фотосинтез
     *   01_definition_Фотосинтез.mp3  -> key 01, role definition
     *   term_Атом.jpg / definition_Атом.jpg (no number: paired by label)
     *   question_term.jpg / question_definition.jpg -> the "?" images (question.jpg = both)
     */
    function parseFileName(name) {
        const ext = (/\.([a-z0-9]+)$/i.exec(name) || [])[1];
        if (!ext) return null;
        const lowerExt = ext.toLowerCase();
        let kind = null;
        if (IMAGE_EXTENSIONS.includes(lowerExt)) kind = 'image';
        else if (AUDIO_EXTENSIONS.includes(lowerExt)) kind = 'audio';
        if (!kind) return null;

        const base = name.slice(0, -(ext.length + 1)).normalize('NFC');
        const q = /^question(?:[_-](term|definition|def))?$/i.exec(base);
        if (q) {
            const role = !q[1] ? 'any' : q[1].toLowerCase() === 'term' ? 'term' : 'definition';
            return { question: role, kind };
        }

        const m = /^(?:(\d+)[_-])?(term|definition|def)(?:[_-](.*))?$/i.exec(base);
        if (!m) return null;
        const role = m[2].toLowerCase() === 'term' ? 'term' : 'definition';
        return {
            key: m[1] ? String(parseInt(m[1], 10)).padStart(2, '0') : null,
            role: role,
            label: (m[3] || '').replace(/_/g, ' ').trim(),
            kind: kind
        };
    }

    /*
     * files: [{ name, path }]  — path is relative to the media folder (e.g. "01_term_Атом.jpg")
     * manifest: parsed cards.json or null
     * returns {
     *   method, pairs, unpaired: { term: [entry], definition: [entry] },
     *   questionImages: { term, definition } (paths or null), ignored: [path]
     * }
     * entry = { role, key, label, text, image, audio, folder }
     */
    function groupFiles(files, manifest) {
        const entries = new Map(); // "role|key|label|folder" -> entry
        const questionImages = { term: null, definition: null, any: null };
        const ignored = [];

        files.forEach(file => {
            const info = parseFileName(file.name);
            if (!info) {
                if (file.name !== MANIFEST_NAME && !/^config.*\.json$/i.test(file.name)) ignored.push(file.path);
                return;
            }
            if (info.question) {
                if (info.kind === 'image' && !questionImages[info.question]) questionImages[info.question] = file.path;
                return;
            }
            const segments = file.path.split('/');
            const folder = segments.length > 1 ? segments.slice(0, -1).join('/') : '';
            const id = `${info.role}|${info.key || ''}|${info.label.toLowerCase()}|${folder}`;
            if (!entries.has(id)) {
                // A definition file is named after its term, so its label must not become the definition text
                // (the on-screen prompt would give the answer away). Full texts come from cards.json.
                entries.set(id, {
                    role: info.role, key: info.key, label: info.label,
                    text: info.role === 'term' ? info.label : '',
                    image: null, audio: null, folder
                });
            }
            const entry = entries.get(id);
            if (entry[info.kind]) ignored.push(file.path); // duplicate (e.g. jpg + png)
            else entry[info.kind] = file.path;
        });

        const all = Array.from(entries.values());
        const terms = all.filter(e => e.role === 'term');
        const definitions = all.filter(e => e.role === 'definition');
        const used = new Set();
        const pairs = [];
        const methods = new Set();

        const take = (t, d, method) => {
            pairs.push({ term: t, definition: d });
            used.add(t); used.add(d);
            methods.add(method);
        };

        // 1. Manifest from the generator (cards.json): exact pairs, order and full texts
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
                const t = find(c.term);
                const d = find(c.definition);
                if (t && d && !used.has(t) && !used.has(d) && t.role === 'term' && d.role === 'definition') {
                    if (c.term.text) t.text = c.term.text;
                    if (c.definition.text) d.text = c.definition.text;
                    take(t, d, 'manifest');
                }
            });
        }

        // 2. Shared number: 01_term_… + 01_definition_… (same folder)
        terms.filter(t => !used.has(t) && t.key).forEach(t => {
            const d = definitions.find(d => !used.has(d) && d.key === t.key && d.folder === t.folder);
            if (d) take(t, d, 'number');
        });

        // 3. Same label: term_Атом.jpg + definition_Атом.jpg
        terms.filter(t => !used.has(t) && t.label).forEach(t => {
            const d = definitions.find(d => !used.has(d) && d.label.toLowerCase() === t.label.toLowerCase() && d.folder === t.folder);
            if (d) take(t, d, 'name');
        });

        // 4. One term and one definition in the same sub-folder
        terms.filter(t => !used.has(t) && t.folder).forEach(t => {
            const ds = definitions.filter(d => !used.has(d) && d.folder === t.folder);
            const ts = terms.filter(x => !used.has(x) && x.folder === t.folder);
            if (ds.length === 1 && ts.length === 1) take(t, ds[0], 'folder');
        });

        if (!methods.has('manifest')) {
            const sortKey = e => `${e.folder}|${e.key || '~'}|${e.label.toLowerCase()}`;
            pairs.sort((a, b) => sortKey(a.term).localeCompare(sortKey(b.term)));
        }

        return {
            method: Array.from(methods),
            pairs,
            unpaired: {
                term: terms.filter(e => !used.has(e)),
                definition: definitions.filter(e => !used.has(e))
            },
            questionImages: {
                term: questionImages.term || questionImages.any,
                definition: questionImages.definition || questionImages.any
            },
            ignored
        };
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
                    <label>Marker ids in print order (2 per pair: term, definition):</label>
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
                <div class="config-item" style="flex: 2; min-width: 220px; justify-content: flex-end;">
                    <label style="margin-bottom: 12px;">
                        <input type="checkbox" data-field="hideUntilTouched" ${v.hideUntilTouched ? 'checked' : ''} style="width: auto;">
                        Both cards show "?" until the pointer touches them ("Card" mode)
                    </label>
                </div>
            </div>
            <div class="config-row" style="flex-wrap: wrap;">
                <div class="config-item" style="flex: 1; min-width: 240px;">
                    <label>Prompt when a term card opens (spoken and shown):</label>
                    <input type="text" data-field="termPrompt" value="${escapeHtml(v.termPrompt)}">
                </div>
                <div class="config-item" style="flex: 1; min-width: 240px;">
                    <label>Prompt when a definition card opens:</label>
                    <input type="text" data-field="definitionPrompt" value="${escapeHtml(v.definitionPrompt)}">
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
            hideUntilTouched: field('hideUntilTouched').checked,
            questionTermImage: DEFAULTS.questionTermImage,
            questionDefinitionImage: DEFAULTS.questionDefinitionImage,
            termPrompt: field('termPrompt').value.trim(),
            definitionPrompt: field('definitionPrompt').value.trim(),
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
        ROLES,
        slug,
        pairKey,
        imageFileName,
        audioFileName,
        questionFileName,
        captionText,
        spokenText,
        parseMarkerIds,
        resolveMarkerIds,
        buildConfig,
        buildManifest,
        stringify,
        referencedFiles,
        parseFileName,
        groupFiles,
        renderSettingsForm,
        readSettingsForm,
        downloadText,
        escapeHtml
    };
})(window);
