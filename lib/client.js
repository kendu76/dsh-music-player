/**
 * dsh-music-player client half: the browser player, loaded by the web
 * ModuleLoader as a plain React plugin. It injects a now-playing bar into the
 * composer dock and a floating player panel (track list / modes / volume /
 * spectrum) that also holds the music-directory setting in-panel.
 *
 * Audio is a native <audio> element. A live spectrum (12 log-spaced bands, or an
 * oscilloscope-style waveform) is drawn on a canvas rAF loop, driven solely by a
 * captureStream()+AnalyserNode tap of the playing element — a read-only tap that NEVER
 * reroutes the media element's output, so it can't mute the player (createMediaElementSource,
 * which does reroute, is avoided because it goes silent whenever its AudioContext/graph isn't
 * running and this Chromium throws a "getTopURL" TypeError). There is no offline fallback:
 * if the live tap fails or yields no signal, the visualization simply shows nothing.
 * Play mode and volume persist across reloads
 * via the Host's prefs endpoint (/dsh-music/prefs — no browser storage); the current
 * track + position are restored without autoplay (a tap on ▶ resumes).
 * Host communication is plain HTTP to the /dsh-music/(manifest|intent|set-root|id)
 * routes.
 */
window.__ModuleLoader__.load({
  id: 'dsh-music-player',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const ReactDOM = require('react-dom');
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useLayoutEffect = React.useLayoutEffect;
    const useRef = React.useRef;
    // Directory/file pickers are rendered into the panel DOM, but the panel's
    // initial height is small (empty track list => only ~200px + 60px), which
    // would clamp the picker and show just a few directory rows. Portal the
    // overlay to <body> (position: fixed; inset: 0) so it spans the whole DSH
    // window instead of the panel, regardless of the panel size.
    const createPortal = (ReactDOM && typeof ReactDOM.createPortal === 'function')
      ? (node, container) => ReactDOM.createPortal(node, container)
      : (node) => node; // defensive fallback (react-dom is always provided by DSH)
    const portalToBody = (node) => createPortal(node, document.body);

    // 把弹层锚定在某个按钮/容器正上方（fixed 定位，居中于其水平中心）。
    // 用于音量/模式/章节目录等从播放条上弹出的弹层：这些弹层所在的按钮组
    // 在折叠（overflow:hidden）容器内，弹层需 portal 到 body 并以 fixed 定位
    // 才能不被裁剪。maxW 为弹层的最大宽度，用于水平 clamp 防止宽弹层溢出视口。
    // 无目标元素时回退到视口底部中央。
    const anchorAbove = (el, maxW = 380) => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const r = (el && typeof el.getBoundingClientRect === 'function') ? el.getBoundingClientRect() : null;
      const cx = (r && r.width > 0) ? r.left + r.width / 2 : vw / 2;
      const margin = 8;
      const clampLeft = Math.max(margin, Math.min(vw - margin, cx));
      const top = (r && r.height > 0) ? Math.max(0, r.top - 6) : vh - 40;
      // 居中后 clamp 左边缘，让最大 maxW 宽的弹层完整落在视口内。
      const half = Math.min(maxW / 2, vw / 2 - margin);
      const left = Math.max(margin + half, Math.min(vw - margin - half, clampLeft));
      return { position: 'fixed', left: Math.round(left), top: Math.round(top), transform: 'translate(-50%, -100%)' };
    };

    // 自动高度弹窗（可变高度）专用锚定：与音量/播放顺序弹窗同款「按钮正上方」效果，
    // 但内容高度不固定（章节目录列表、讲书音量弹窗的 AI 声音选择 + 音量滑块等）。
    // anchorAbove 用 top+translateY(-100%)，弹窗过高时会顶到视口顶被截断、且 top 被
    // clamp 后底边脱离按钮。这里改用 bottom 锚定：底边始终贴住按钮上方 6px（绝不
    // 脱开），高度限制为「视口内可用空间 ∩ 合理上限（60vh / 480px）」，保证弹窗
    // 完整可见且紧贴播放条。固定高度的小弹窗（音量 36px/播放顺序）仍用 anchorAbove。
    const anchorPopAbove = (el, maxW = 380) => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const r = (el && typeof el.getBoundingClientRect === 'function') ? el.getBoundingClientRect() : null;
      const margin = 8;
      const cx = (r && r.width > 0) ? r.left + r.width / 2 : vw / 2;
      const clampLeft = Math.max(margin, Math.min(vw - margin, cx));
      const half = Math.min(maxW / 2, vw / 2 - margin);
      const left = Math.max(margin + half, Math.min(vw - margin - half, clampLeft));
      const base = { position: 'fixed', left: Math.round(left), transform: 'translateX(-50%)' };
      if (!r || r.height <= 0) {
        // 回退：视口底部中央、贴底显示（无锚点时也能看到完整弹窗）。
        return { ...base, bottom: margin, maxHeight: Math.min(60 * vh / 100, 480) };
      }
      // 底边 = 按钮顶 - 6px（bottom 为距视口底边的距离）；高度上限 = 可用空间 ∩ 合理上限。
      const topGap = 8; // 弹窗顶部到视口顶至少留 8px
      const avail = Math.max(120, r.top - 6 - topGap);
      return {
        ...base,
        bottom: Math.round(vh - r.top + 6),
        maxHeight: Math.round(Math.min(60 * vh / 100, 480, avail)),
      };
    };
    // 搜索历史下拉专用：锚定在搜索框正下方（fixed，左边缘与搜索框对齐、宽度一致），
    // portal 到 body 以避开 .dsh-music-panel(overflow:hidden) / .dsh-music-qq-body
    // (overflow-y:auto) 的裁剪（否则下拉在真实浏览器里不可见）。无锚点时回退到
    // 视口顶部中央。
    const anchorBelow = (el, maxW = 420) => {
      const vw = window.innerWidth;
      const r = (el && typeof el.getBoundingClientRect === 'function') ? el.getBoundingClientRect() : null;
      const margin = 8;
      const width = Math.min((r && r.width > 0) ? r.width : 380, maxW, vw - margin * 2);
      const left = (r && r.width > 0)
        ? Math.max(margin, Math.min(vw - margin - width, r.left))
        : Math.max(margin, Math.round((vw - width) / 2));
      const top = (r && r.height > 0) ? Math.round(r.bottom + 4) : margin;
      return { position: 'fixed', left: Math.round(left), top, width: Math.round(width), maxHeight: 240 };
    };

    // 以播放面板中心为基准的固定定位样式（面板可拖拽，弹窗随其居中）。
    // halfW 为目标弹窗的近似半宽；maxH 为弹窗最大高度（px）：垂直 clamp 用
    // maxH 的一半，保证 translate 居中后弹窗完整落在视口内；内容超过 maxH 时
    // 由内部 .dsh-music-picker-list 滚动承载（底部按钮保持固定可见）。
    // 面板不可见/无尺寸（如关闭态）时回退到视口中心。on 控制是否真正计算。
    const panelCenterStyle = (panelRef, on, halfW, maxH) => {
      if (!on) return null;
      const pr = (panelRef && panelRef.current) ? panelRef.current.getBoundingClientRect() : null;
      const vw = window.innerWidth, vh = window.innerHeight;
      const cx = (pr && pr.width > 0) ? pr.left + pr.width / 2 : vw / 2;
      const cy = (pr && pr.height > 0) ? pr.top + pr.height / 2 : vh / 2;
      const clampC = (v, lo, hi) => (lo <= hi ? Math.max(lo, Math.min(v, hi)) : v);
      const halfWm = Math.min(halfW, vw / 2);
      const halfHm = Math.min(maxH / 2, vh / 2);
      return {
        position: 'fixed',
        left: clampC(cx, halfWm, vw - halfWm),
        top: clampC(cy, halfHm, vh - halfHm),
        transform: 'translate(-50%, -50%)',
        maxHeight: maxH + 'px',
        margin: 0,
      };
    };

    // This host/environment throws a harmless, unhandled rejection from
    // Chromium's media pipeline — "Cannot read properties of undefined (reading
    // 'getTopURL')" — whenever an <audio> element loads or plays. Playback and
    // position handling are unaffected, so swallow just that specific error to
    // keep the console clean. Registered at module scope (before any media op)
    // and covering all three surfacing paths.
    (() => {
      const isGetTopUrl = (value) => {
        try { return String((value && value.message) || value || '').indexOf('getTopURL') !== -1; } catch { return false; }
      };
      window.addEventListener('unhandledrejection', (ev) => {
        if (isGetTopUrl(ev && ev.reason)) ev.preventDefault();
      });
      window.addEventListener('error', (ev) => {
        if (isGetTopUrl(ev && ev.message)) ev.preventDefault();
      });
      if (typeof console !== 'undefined' && typeof console.error === 'function') {
        const origError = console.error.bind(console);
        console.error = (...args) => {
          if (args.some(isGetTopUrl)) return;
          origError(...args);
        };
      }
    })();

    // ---- persisted prefs (Host-backed, with legacy browser-storage fallback) ----
    // Every pref lives in the Host's music-player-prefs.json, served via
    // GET/POST /dsh-music/prefs and held in the in-memory `serverPrefs`
    // snapshot here. dsh-desktop starts the Harness web server on a RANDOM port
    // each launch, so the page origin changes every time — browser localStorage
    // (keyed by origin) is therefore NOT authoritative and is never written.
    // localStorage is kept only as a READ-ONLY upgrade source: old builds (<0.7)
    // persisted these same key names there, so on upgrade we read Host first and
    // fall back to the old browser copy, migrate it into the Host, then delete
    // the browser copy. No user data is lost and no new data touches the browser.
    const PREF_MODE = 'dsh-music-mode';
    const PREF_VOL = 'dsh-music-volume';
    const PREF_PLAYBACK = 'dsh-music-playback';      // 本地音乐播放进度（独立于在线源）
    const PREF_PLAYBACK_QQ = 'dsh-music-qq-playback'; // 在线 QQ 播放进度+队列（独立于本地）
    const PREF_PLAYBACK_KG = 'dsh-music-kg-playback'; // 在线酷狗播放进度+队列（独立于 QQ/本地）
    const PREF_BOOKS_PLAYBACK = 'dsh-music-books-playback';
    const PREF_PANEL_POS = 'dsh-music-panel-pos';
    const PREF_LYRIC_PANEL_POS = 'dsh-music-lyric-panel-pos'; // 歌词/字幕面板独立位置记忆
    const PREF_VOICE = 'dsh-music-voice';
    const PREF_SCOPE = 'dsh-music-scope';
    const PREF_QQ_FAV = 'dsh-music-qq-fav'; // QQ「我喜欢」收藏 songid/songmid（Host 兜底）
    const PREF_QQ_HISTORY = 'dsh-music-qq-history'; // QQ 搜索历史（最近在前，最多 10 条）
    const PREF_QQ_UI = 'dsh-music-qq-ui';           // QQ 面板所在层/歌单 UI 状态
    const PREF_KG_HISTORY = 'dsh-music-kg-history'; // 酷狗搜索历史（最近在前，最多 10 条）
    const PREF_SHOW_LYRIC = 'dsh-music-show-lyric';   // 播放条歌词显示开关（默认开）
    const PREF_SHOW_VIZ = 'dsh-music-show-viz';       // 播放条频谱显示开关（默认开）
    const PREF_VIZ_MODE = 'dsh-music-viz-mode';       // 播放条频谱样式：'bars' 柱状图 | 'wave' 波形图（默认柱状图）
    const PREF_SHOW_PROGRESS = 'dsh-music-show-progress'; // 播放条进度条显示开关（默认开）
    const PREF_SHOW_QUALITY = 'dsh-music-show-quality'; // 歌名后音质徽章显示开关（默认开）
    const PREF_SHOW_BAR_BG = 'dsh-music-show-bar-bg'; // 播放条边框/背景色显示开关（默认开）
    const PREF_IMMERSE = 'dsh-music-immerse';         // 沉浸感：播放条闲置态透明度 0..1（默认 0.5）
    // 歌词动效：换行过渡风格（参考主流播放器），取值见 LYRIC_FX_VALUES；存 Host prefs。
    const PREF_LYRIC_FX = 'dsh-music-lyric-fx';
    // 歌词/字幕面板透明模式：隐去面板外壳（背景/边框/阴影），歌词像直接悬浮在页面
    // 上；标题栏与关闭按钮改为悬停面板时才显现（默认开，存 Host prefs）。
    const PREF_LYRIC_PANEL_GHOST = 'dsh-music-lyric-panel-ghost';
    // 版本更新弹窗「已看过哪个版本」标记：值为看过的版本号。判定在 Host 端完成
    //（manifest 下发 whatsNewState），客户端只在用户关闭弹窗时写入当前版本号。
    // 与 lib/whatsnew.js PREF_SEEN_VERSION、Host PREF_ALLOW 三处对齐——漏登记
    // 会被任意一端的白名单静默丢弃，表现为「每次启动都弹更新窗」。
    const PREF_SEEN_VERSION = 'dsh-music-seen-version';
    // 歌词换行动效全集（系统配置面板按此顺序展示）。none=无动效(硬切)；
    // slide=上滑淡入(网易云桌面词风)；blur=模糊浮入(Apple Music 风)；
    // karaoke=卡拉OK扫色(KTV 风格，整行匀速点亮——无逐字时间轴时的近似)。
    // 跑马灯/边缘渐隐是内置行为，不作为配置项（超宽滚动、两端渐隐恒开）。
    const LYRIC_FX_VALUES = ['none', 'slide', 'blur', 'karaoke'];
    // Legacy single-book progress key (pre-0.2.1); migrated into the per-book
    // map on upgrade so very old browser copies are not silently dropped.
    const PREF_LEGACY_BOOK = 'dsh-music-book-playback';
    // Every persisted key: written via savePref, read via loadPref, mirrored to
    // the Host on a debounced flush.
    const PREF_KEYS = new Set([
      PREF_MODE, PREF_VOL, PREF_VOICE, PREF_SCOPE, PREF_PANEL_POS, PREF_LYRIC_PANEL_POS,
      PREF_PLAYBACK, PREF_PLAYBACK_QQ, PREF_PLAYBACK_KG, PREF_BOOKS_PLAYBACK, PREF_QQ_FAV, PREF_QQ_HISTORY, PREF_QQ_UI, PREF_KG_HISTORY,
      PREF_SHOW_LYRIC, PREF_SHOW_VIZ, PREF_VIZ_MODE, PREF_SHOW_PROGRESS, PREF_SHOW_QUALITY, PREF_SHOW_BAR_BG, PREF_IMMERSE,
      PREF_LYRIC_FX, PREF_LYRIC_PANEL_GHOST, PREF_SEEN_VERSION,
    ]);
    let serverPrefs = null;          // null = Host snapshot not fetched yet
    let serverPrefsFetched = false;  // distinguishes "not fetched" from an early savePref
    const serverDirtyKeys = new Set(); // keys changed since the last flush
    const serverRemoveKeys = new Set(); // keys cleared since the last flush
    let serverFlushTimer = null;
    let serverFlushSeq = 0;
    // Legacy browser-storage accessors (safe; quota/security errors are ignored).
    // localStorage is READ-ONLY here: it is only a source for upgrading old
    // (<0.7) records into the Host. The client never writes new data to it.
    const legacyGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
    const legacyRemove = (k) => { try { localStorage.removeItem(k); } catch (e) {} };
    function loadPref(k) {
      if (!PREF_KEYS.has(k)) return null;
      // Host is authoritative — it survives origin changes (random port).
      if (serverPrefs !== null && Object.prototype.hasOwnProperty.call(serverPrefs, k)) {
        return serverPrefs[k];
      }
      // Upgrade compatibility: if the Host has no record yet, fall back to the
      // old browser localStorage copy (same key names). loadServerPrefs migrates
      // it into the Host after the snapshot is fetched.
      return legacyGet(k);
    }
    function savePref(k, v) {
      if (!PREF_KEYS.has(k)) return;
      serverPrefs = serverPrefs || {};
      serverPrefs[k] = v;
      serverRemoveKeys.delete(k);
      serverDirtyKeys.add(k);
      // Host-only: no mirror write to localStorage. All data lives in the Host.
      scheduleServerPrefsFlush();
    }
    function clearPref(k) {
      if (!PREF_KEYS.has(k)) return;
      serverPrefs = serverPrefs || {};
      delete serverPrefs[k];
      serverDirtyKeys.delete(k);
      serverRemoveKeys.add(k);
      // Also drop the legacy browser copy — otherwise loadPref would resurrect
      // a cleared value from localStorage on the next read.
      legacyRemove(k);
      scheduleServerPrefsFlush();
    }
    function scheduleServerPrefsFlush() {
      if (serverFlushTimer !== null) return;
      serverFlushTimer = setTimeout(() => { serverFlushTimer = null; void flushServerPrefs(); }, 800);
    }
    async function flushServerPrefs() {
      const seq = ++serverFlushSeq;
      const patch = {};
      for (const k of serverDirtyKeys) {
        if (serverRemoveKeys.has(k)) continue;
        if (serverPrefs && Object.prototype.hasOwnProperty.call(serverPrefs, k)) patch[k] = serverPrefs[k];
      }
      const remove = [...serverRemoveKeys];
      serverDirtyKeys.clear();
      serverRemoveKeys.clear();
      if (Object.keys(patch).length === 0 && remove.length === 0) return;
      const payload = JSON.stringify({ prefs: patch, remove });
      // keepalive survives page teardown (pagehide flush), but browsers cap a
      // keepalive body at 64KiB and THROW on anything larger — a long QQ queue
      // (the playback save embeds the whole queue) easily exceeds that, which
      // silently dropped playback POSTs. Use keepalive only for small payloads;
      // larger ones go out as a plain fetch (the periodic ~5s saves keep the
      // state current, so a pagehide cutoff is not a real loss).
      const useKeepalive = payload.length <= 60 * 1024;
      try {
        const r = await fetch('/dsh-music/prefs', {
          method: 'POST', cache: 'no-store', keepalive: useKeepalive,
          headers: { 'content-type': 'application/json' },
          body: payload,
        });
        if (r.ok && seq === serverFlushSeq) {
          const d = await r.json();
          if (d && d.prefs && typeof d.prefs === 'object') {
            // The server confirms our merge. Keep any value that changed locally
            // while this request was in flight (dirty keys / pending removals win
            // over the response), so a concurrent save is never overwritten.
            serverPrefs = { ...d.prefs, ...serverPrefs };
            for (const k of serverRemoveKeys) delete serverPrefs[k];
          }
        }
      } catch { /* best-effort: the change stays in the in-memory snapshot */ }
    }
    // Fetch the Host snapshot once; merge any pre-fetch local writes on top so
    // an early savePref (before the fetch resolves) is never lost. On a cold
    // start the page can load before the plugin's routes are registered, so a
    // failed/empty first read is retried briefly instead of silently skipping
    // the whole restore (that was why "restart shows nothing" could happen).
    async function loadServerPrefs() {
      if (serverPrefsFetched) return serverPrefs;
      const local = serverPrefs; // possibly written by an early savePref
      let got = false; // route responded with a valid prefs shape
      for (let attempt = 0; attempt < 4 && !got; attempt++) {
        let fetched = {};
        try {
          const d = await jsonGet('/dsh-music/prefs');
          if (d && d.prefs && typeof d.prefs === 'object') { fetched = d.prefs; got = true; }
        } catch { /* transient: route not ready yet */ }
        serverPrefs = { ...fetched, ...(local || {}) };
        if (!got && attempt < 3) await new Promise((r) => setTimeout(r, 250));
      }
      serverPrefsFetched = true;
      migrateLegacyBrowserPrefs();
      return serverPrefs;
    }
    // Upgrade path: adopt any old localStorage record the Host does not yet have
    // (so a <0.7 browser copy survives the move to Host storage), and fold the
    // legacy single-book key into the per-book map. Runs once, after the Host
    // snapshot is fetched, so Host values always win. Once a record is adopted
    // its browser copy is removed — localStorage is a read-only migration source
    // and never holds data after it has been claimed by the Host.
    function migrateLegacyBrowserPrefs() {
      // Legacy single-book progress (pre-0.2.1) → per-book map.
      try {
        const legacyRaw = legacyGet(PREF_LEGACY_BOOK);
        if (legacyRaw) {
          const p = JSON.parse(legacyRaw);
          if (p && typeof p.id === 'string' && typeof p.name === 'string' && p.name !== '') {
            const map = readBooksPlayback();
            if (!Object.prototype.hasOwnProperty.call(map, p.name)) {
              map[p.name] = { from: p.from, base: p.base, pos: p.pos, total: p.total, ts: p.ts || Date.now() };
              writeBooksPlayback(map);
            }
          }
          legacyRemove(PREF_LEGACY_BOOK);
        }
      } catch (e) { /* malformed legacy copy: ignore */ }
      // Any other legacy key: if the Host lacks it, adopt the browser copy (Host
      // becomes authoritative) and remove the browser copy; if the Host already
      // has it, just drop the stale browser duplicate. Either way localStorage
      // ends up holding none of the managed prefs — it is only a one-way upgrade
      // source and never keeps data once the Host snapshot has claimed it.
      for (const k of PREF_KEYS) {
        if (Object.prototype.hasOwnProperty.call(serverPrefs, k)) {
          legacyRemove(k);
          continue;
        }
        const v = legacyGet(k);
        if (v !== null) {
          savePref(k, v);
          legacyRemove(k);
        }
      }
    }
    // Apply persisted mode / volume / voice to the store + audio element.
    // Mutates directly (no set()) so a pre-startup call does not re-trigger
    // savePref; a later set() from loadTracks re-renders the UI.
    function applyStoredPrefs() {
      try {
        const m = loadPref(PREF_MODE);
        if (m === 'single' || m === 'order' || m === 'shuffle') store.mode = m;
        const v = parseFloat(loadPref(PREF_VOL));
        if (Number.isFinite(v)) { store.volume = Math.min(1, Math.max(0, v)); audio.volume = store.volume; }
        const voice = loadPref(PREF_VOICE);
        if (typeof voice === 'string' && voice !== '') store.voice = voice;
        // 系统配置开关：默认开启（缺省即 true）。
        const showLyric = loadPref(PREF_SHOW_LYRIC);
        if (showLyric === '0') store.showLyric = false;
        const showViz = loadPref(PREF_SHOW_VIZ);
        if (showViz === '0') store.showViz = false;
        const vizMode = loadPref(PREF_VIZ_MODE);
        if (vizMode === 'wave') store.vizMode = 'wave'; // else keep default 'bars'
        const showProgress = loadPref(PREF_SHOW_PROGRESS);
        if (showProgress === '0') store.showProgress = false;
        const showQuality = loadPref(PREF_SHOW_QUALITY);
        if (showQuality === '0') store.showQuality = false;
        const showBarBg = loadPref(PREF_SHOW_BAR_BG);
        if (showBarBg === '0') store.showBarBg = false;
        // 沉浸感：0..1，缺省 0.5。钳制到合法区间防止脏数据。
        const immerse = parseFloat(loadPref(PREF_IMMERSE));
        if (Number.isFinite(immerse)) store.immerse = Math.min(1, Math.max(0, immerse));
        // 歌词动效：fx 必须在白名单内（脏数据回退默认 none=无动效）。
        const lfx = loadPref(PREF_LYRIC_FX);
        if (LYRIC_FX_VALUES.indexOf(lfx) !== -1) store.lyricFx = lfx;
        // 歌词面板透明模式：'0' = 关（默认开，与其它显示开关同款约定）。
        if (loadPref(PREF_LYRIC_PANEL_GHOST) === '0') store.lyricPanelGhost = false;
      } catch (e) {}
    }
    // ---- per-book novel progress (independent from music) ----
    // Every novel remembers its own position, keyed by its filename, so switching
    // between books — or to music — never loses another book's place. Music
    // progress lives in PREF_PLAYBACK and this subsystem never touches it.
    function readBooksPlayback() {
      try {
        const raw = loadPref(PREF_BOOKS_PLAYBACK);
        if (raw) { const o = JSON.parse(raw); if (o && typeof o === 'object') return o; }
      } catch (e) {}
      return {};
    }
    function writeBooksPlayback(map) { savePref(PREF_BOOKS_PLAYBACK, JSON.stringify(map)); }
    function getBookPlayback(name) { return readBooksPlayback()[name] || null; }
    function clearBookPlayback(name) {
      const map = readBooksPlayback();
      if (Object.prototype.hasOwnProperty.call(map, name)) { delete map[name]; writeBooksPlayback(map); }
    }
    // Persist the currently playing novel's position into the per-book map.
    function saveCurrentBookPlayback() {
      const id = currentBookId();
      if (id === null) return;
      const book = bookById(id);
      if (book === null) return;
      const map = readBooksPlayback();
      map[book.name] = {
        from: bookFromRef, base: bookBaseTime,
        pos: audio.currentTime || 0, total: bookTotal,
        ts: Date.now(),
      };
      writeBooksPlayback(map);
    }
    // The most recently played novel (largest ts), used by refresh restore.
    function latestBookPlayback() {
      const map = readBooksPlayback();
      let best = null, bestTs = -1;
      for (const [name, e] of Object.entries(map)) {
        if (e && typeof e.from === 'number' && e.ts > bestTs) { best = { name, ...e }; bestTs = e.ts; }
      }
      return best;
    }
    // Playback-panel geometry: default CSS width (must match .dsh-music-panel),
    // resize bounds, and the viewport-height fraction cap when user-resized.
    const PANEL_W = 600;
    const PANEL_MIN_W = 320;
    const PANEL_MAX_W = 720;
    const PANEL_MIN_H = 200;
    const PANEL_MAX_H_VH = 0.8;
    // Auto-size (never-dragged) default height. The panel's height is content-
    // driven (CSS max-height:72vh), but a fresh install has an empty track list
    // whose min-height is only ~60px, so the panel would open absurdly short.
    // Give the auto-size panel a comfortable default minimum so first-use looks
    // right; this only applies while pos === null (never dragged/resized).
    const PANEL_AUTO_MIN_H = '45vh';
    // 歌词/字幕面板的默认尺寸与位置：初始居中（CSS left:50%/top:50% + translate），
    // 宽度按歌词阅读舒适度取 420px、高度取 40vh（比播放面板窄，歌词无需侧边栏）。
    // 拖动/拉伸后持久化到 PREF_LYRIC_PANEL_POS（独立于播放面板的位置记忆）。
    const LYRIC_PANEL_W = 420;
    const LYRIC_PANEL_MIN_W = 280;
    const LYRIC_PANEL_MAX_W = 720;
    const LYRIC_PANEL_MIN_H = 200;
    const LYRIC_PANEL_MAX_H_VH = 0.8;
    function loadLyricPanelPos() {
      const raw = loadPref(PREF_LYRIC_PANEL_POS);
      if (raw === null) return null;
      try {
        const p = JSON.parse(raw);
        if (p && typeof p.x === 'number' && typeof p.y === 'number'
          && typeof p.h === 'number' && p.h > 0) {
          return { x: p.x, y: p.y, w: (typeof p.w === 'number' && p.w > 0) ? p.w : LYRIC_PANEL_W, h: p.h };
        }
      } catch (e) {}
      return null;
    }
    function loadPanelPos() {
      const raw = loadPref(PREF_PANEL_POS);
      if (raw === null) return null;
      try {
        const p = JSON.parse(raw);
        if (p && typeof p.x === 'number' && typeof p.y === 'number'
          && typeof p.h === 'number' && p.h > 0) {
          return { x: p.x, y: p.y, w: (typeof p.w === 'number' && p.w > 0) ? p.w : PANEL_W, h: p.h };
        }
      } catch (e) {}
      return null;
    }
    const jsonGet = (url) => fetch(url, { cache: 'no-store' }).then((r) => r.json());
    const jsonPost = (url, body) => fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    }).then((r) => r.json());

    // ---- engine + shared store (React re-renders on set) ----
    const VIZ_BARS = 12; // spectrum bars (log-spaced real FFT bands)
    const PEAK_DECAY = 0.012; // peak-cap fall per frame (~1.3s, visible 渐落 trail)
    // 波形图垂直振幅放大：固定放大 VIZ_WAVE_GAIN 只作上限，实际每帧按各频段的
    // 慢峰值自适应（见 analyseLiveWave 的 vizBandGain）：大声段落回落到下限 1x
    // （保持全幅、不压缩响度），安静段落最多提到 VIZ_WAVE_GAIN 倍（保持可见），
    // 峰值在 ~1s 内缓慢回落，因此响度变化仍能被看见。音乐峰值很少触及满幅
    // （byte 0/255），默认波形只占画布高度的一小部分；放大后超出画布的上下沿会
    // 被 canvas 自然裁掉，形成顶到边的观感。
    const VIZ_WAVE_GAIN = 2.0;          // 自适应增益上限（安静段落最大放大）
    const VIZ_WAVE_GAIN_MIN = 1.0;      // 增益下限（大声段落保持全幅）
    const VIZ_WAVE_PEAK_TARGET = 0.45;  // 慢峰值归一目标：满幅 → 约 90% 半画布高
    const VIZ_WAVE_PEAK_DECAY = 0.985;  // 慢峰值每帧回落系数（~1s 释放 @60fps）
    // 波形图「分频段多线」：把时域波形按频率分成这几段，每段各自合成一条曲线，形成
    // 层次感（低/中/高频各自起伏）。边界单位为 Hz（与采样率无关的绝对频率）。
    const VIZ_WAVE_BANDS = [
      { label: 'low', lo: 40, hi: 300, alpha: 1.0, width: 1.0 },   // 低音（主轮廓）
      { label: 'mid', lo: 300, hi: 4000, alpha: 0.55, width: 0.8 }, // 中频
      { label: 'high', lo: 4000, hi: 18000, alpha: 0.3, width: 0.6 }, // 高频
    ];
    const audio = new Audio();
    audio.preload = 'auto';
    // Attach the media element to the document (hidden) so it has a proper DOM /
    // document association (some browsers handle attached media elements more
    // predictably). body may not exist yet at module eval, so defer the attach
    // until apply() runs (body is ready there).
    let audioAttached = false;
    function attachAudioElements() {
      if (audioAttached) return;
      audioAttached = true;
      try {
        audio.style.display = 'none';
        preAudio.style.display = 'none';
        if (audio.parentNode === null) document.body.appendChild(audio);
        if (preAudio.parentNode === null) document.body.appendChild(preAudio);
      } catch (e) { /* non-fatal */ }
    }

    // Autoplay unlock without touching the playing <audio> element (which would
    // interrupt playback). Browsers block <audio>.play() once the synchronous
    // user gesture is gone — which is what happens after the async TTS synthesis
    // takes a second or two. Calling audioCtx.resume() synchronously inside the
    // click grants the page sticky audio activation, so the later async play()
    // is allowed. On macOS the context usually runs anyway; on Windows/Chrome
    // this resume is what makes auto-play work.
    let unlockCtx = null;
    function unlockAutoplay() {
      try {
        if (unlockCtx === null) {
          const Ctor = window.AudioContext || window.webkitAudioContext;
          if (Ctor === undefined) return;
          unlockCtx = new Ctor();
        }
        if (unlockCtx.state === 'suspended') {
          const p = unlockCtx.resume();
          if (p && p.catch) p.catch(() => {});
        }
      } catch { /* unlock is best-effort */ }
      // The live-spectrum analyser rides its own AudioContext; resume it too so
      // the bars react on the very first frame after the gesture that unlocks
      // autoplay (books + online QQ) rather than staying silent.
      resumeVizCtx();
    }

    const store = {
      root: null, tracks: [], books: [], count: 0, currentId: null, currentName: null,
      // 每日新闻播报：期次列表（GET /dsh-music/news 的摘要行）。播放走「虚拟书」桥接。
      newsEditions: [],
      // 在线 QQ 曲目的「真实品质」标签（无损/高音质/标准），随播放流响应头回传；
      // 空串 = 未取到（非 QQ / 取链失败），播放条只显示「QQ音乐」。
      currentQuality: '',
      playing: false, position: 0, duration: 0, volume: 0.8,
      // AI 讲书全书进度（0..1）：已读字符 / 全书字符。Host 的 charOffsets 就绪前为 0；
      // 总字符数无需合成即可知，因此能给出稳定的「读到哪了」比例（时长占比做不到）。
      bookProgress: 0,
      panelOpen: false, loading: false, error: null, pendingId: null, pendingName: null,
      mode: 'order', vizMode: 'bars', tab: 'music',
      // true once the Host prefs snapshot is loaded (volume/mode/playback from
      // /dsh-music/prefs are authoritative); panel position re-applies on it.
      prefsReady: false,
      // Host manifest 快照（/dsh-music/manifest 下发）：版本号 / TTS 配置状态 /
      // QQ·酷狗登录态。供播放面板「关于」页展示运行状态。
      version: '', description: '', ttsConfigured: false, ttsReason: '', ttsProvider: '',
      qqLoggedIn: false, qqUin: '', qqNickname: '', qqLoginFrom: '',
      kgLoggedIn: false,
      // 版本更新弹窗（What's New）：内容与判定结论都来自 manifest——
      // whatsNew 当前版条目（null=本版没写条目）/ whatsNewHistory 历史条目（新→旧）/
      // whatsNewWelcome 首装欢迎内容 / whatsNewState 判定结论（Host 端 whatsnew.js
      // 计算：fresh=首装 upgrade=升级 seen=已看过 downgrade=降级）。
      // whatsNewOpen/whatsNewMode 控制弹窗显隐与形态（welcome/upgrade/history）。
      whatsNew: null, whatsNewHistory: [], whatsNewWelcome: null, whatsNewState: '',
      whatsNewOpen: false, whatsNewMode: 'upgrade',
      bookBuffering: false, bookError: '', bookBufferingSince: 0, bookBufferingSilent: false,
      // chapter table of contents (book reader): section list of the current book,
      // whether the toc popup is open, and the heading of the section now playing.
      tocOpen: false, bookToc: [], currentSection: '',
      // 歌词/字幕：当前行文本（音乐 = 当前歌词行，讲书 = 当前句子）。空串 = 无歌词
      // 不渲染。播放条"频谱后、时长前"位置、仅非使用态显示。
      lyricText: '',
      // 卡拉OK扫色进度：{ dur, elapsed } ms = 当前行时长 / 行内已过时长。随行文本一起
      // 更新（只在换行时 set）；fx 非 karaoke 时 UI 忽略。null = 无可用时间轴。
      lyricScan: null,
      // 当前歌词来源（诊断用）：'local'=本地同名.lrc | 'embedded'=文件内嵌歌词 |
      // 'qq-qrc'=QQ逐字 | 'qq'=QQ普通LRC | 'lrclib'=LRCLIB。空串=无歌词/未知。随行下发到
      // 播放条歌词元素的 data-src 属性，DevTools 一眼可查。
      lyricSource: '',
      // 歌词动效：换行过渡风格（存 Host prefs，见 LYRIC_FX_VALUES）。默认 none=无动效
      // （保持原始硬切行为——不明确选择就不得有任何动效）。跑马灯/渐隐恒开。
      lyricFx: 'none',
      // 歌词/字幕面板：完整歌词行 + 当前行索引 + 面板开关。lyricLines 为当前曲目的
      // 全部歌词行（音乐：{text,t,end} 按时间排序；讲书：纯文本行），供双击歌词打开的
      // 完整歌词面板渲染并标识当前进度。lyricCur 为当前行下标（-1=无/未定位）。
      // 面板「常驻显示」：双击歌词开关，点击外部不关闭，仅手动点关闭按钮消失。
      lyricPanelOpen: false, lyricLines: [], lyricCur: -1,
      // 歌词/字幕面板透明模式：隐去外壳背景/边框/阴影，歌词像直接显示在页面上
      // （默认开启，存 Host prefs；系统配置面板可关）。
      lyricPanelGhost: true,
      // 系统配置：播放条歌词 / 频谱 / 进度条 / 音质徽章 / 外壳边框背景显示开关（默认开启，存 Host prefs）。
      showLyric: true, showViz: true, showProgress: true, showQuality: true, showBarBg: true,
      // 沉浸感：播放条闲置态透明度（0..1，默认 0.5），存 Host prefs。
      immerse: 0.5,
      // 播放模式弹层是否打开（portal 到 body 时让播放条按钮保持展开、不因移出而收起）。
      modeMenuOpen: false,
      // AI 讲书 TTS voice: available voices come from /manifest, the selection
      // persists in the Host prefs and rides the chunk URL so the host
      // re-synthesizes. voiceSwitching = a new voice is being synthesized.
      voices: [], voice: '白桦', voiceSwitching: false,
      // 自建歌单：manifest.playlists 即数据源；scope 为当前播放范围（曲库/歌单），
      // subTab 为音乐页内的子标签（'library' 或歌单 id）。
      playlists: [], scope: { kind: 'library' }, subTab: 'library',
      // 在线 QQ 曲目是否已收藏到「我喜欢」（仅当播放 qq: 曲目时有意义）。
      qqFaved: false,
      // 已收藏到「我喜欢」的歌曲 songid / songmid 集合（用于判断当前曲目是否已收藏）。
      qqFavIds: [],
      qqFavMids: [],
      // 「我喜欢」收藏成功/取消成功后的递增计数，供 QQ 面板刷新该歌单数目。
      qqFavRev: 0,
      // 在线酷狗曲目是否已收藏到「我喜欢」（仅当播放 kg: 曲目时有意义）。
      kgFaved: false,
      // 酷狗「我喜欢」已收藏歌曲 hash 集合 + hash→fileId 映射 + 该歌单 listid
      // （用于点亮播放条爱心 / 收藏切换）。
      kgFavHashes: [],
      kgFavFiles: [],
      kgFavListId: 0,
      // 酷狗「我喜欢」集合是否已就绪（/kg/liked 已返回）：就绪后卡片数目以本地
      // 集合长度为准（实时、不受酷狗服务端计数滞后影响）。
      kgFavLoaded: false,
      // 酷狗「我喜欢」收藏/取消后的递增计数，供酷狗面板刷新该歌单数目。
      kgFavRev: 0,
      // 酷狗登录态已失效（与设备不匹配，无法刷新续命）→ 由引擎侧检测后置位，
      // 酷狗面板据此回到扫码登录页并提示。空串 = 登录态正常。
      kgAuthDeadMsg: '',
      // 在线播放队列的来源歌单（用于「播放列表跟随歌单更新」）：从「我的歌单」
      // 点歌播放时记录 { kind:'my', listId }（QQ: { kind:'mine', id, dirId }）；
      // 搜索/榜单/公开歌单等虚拟列表 → null（快照不跟随）。随播放持久化。
      kgQueueFrom: null,
      qqQueueFrom: null,
      // 队列来源歌单内容发生增删后的递增计数（收藏/加歌/移除均 bump）：面板据此
      // 实时重拉来源歌单、让播放列表跟随更新；也用于「恢复后刷新一次」。
      kgQueueRev: 0,
      qqQueueRev: 0,
      // 自定义输入弹窗（替代浏览器 prompt）：{ id, title, initial, onOk } | null。
      prompt: null,
      // 自定义确认弹窗（替代浏览器 confirm）：{ title, message, onOk, okText, danger } | null。
      confirm: null,
      // 「加入歌单」成功/失败提示：{ text, ok, id } | null。面板窗口内居中显示，2s 自动消失。
      toast: null,
    };
    const listeners = new Set();
    function set(patch) {
      Object.assign(store, patch);
      if ('mode' in patch) savePref(PREF_MODE, patch.mode);
      if ('volume' in patch) savePref(PREF_VOL, String(patch.volume));
      if ('voice' in patch) savePref(PREF_VOICE, patch.voice);
      if ('scope' in patch) savePref(PREF_SCOPE, JSON.stringify(patch.scope));
      if ('showLyric' in patch) savePref(PREF_SHOW_LYRIC, patch.showLyric ? '1' : '0');
      if ('showViz' in patch) savePref(PREF_SHOW_VIZ, patch.showViz ? '1' : '0');
      if ('vizMode' in patch) savePref(PREF_VIZ_MODE, patch.vizMode === 'wave' ? 'wave' : 'bars');
      if ('showProgress' in patch) savePref(PREF_SHOW_PROGRESS, patch.showProgress ? '1' : '0');
      if ('showQuality' in patch) savePref(PREF_SHOW_QUALITY, patch.showQuality ? '1' : '0');
      if ('showBarBg' in patch) savePref(PREF_SHOW_BAR_BG, patch.showBarBg ? '1' : '0');
      if ('immerse' in patch) savePref(PREF_IMMERSE, String(Math.min(1, Math.max(0, patch.immerse))));
      // 歌词动效：fx 白名单校验（非法值一律落回 none=无动效，与读取端一致）。
      if ('lyricFx' in patch) savePref(PREF_LYRIC_FX, LYRIC_FX_VALUES.indexOf(patch.lyricFx) !== -1 ? patch.lyricFx : 'none');
      if ('lyricPanelGhost' in patch) savePref(PREF_LYRIC_PANEL_GHOST, patch.lyricPanelGhost ? '1' : '0');
      for (const fn of [...listeners]) fn();
    }
    function useStore() {
      const [snap, setSnap] = useState(store);
      useEffect(() => {
        const update = () => setSnap({ ...store });
        listeners.add(update);
        update();
        return () => { listeners.delete(update); };
      }, []);
      return snap;
    }
    // 「加入歌单」成功/失败提示：统一在面板窗口内居中显示（成功绿色 / 失败红色），
    // 2 秒后自动消失。连续触发时只保留最后一条（前一条立即被顶掉）。
    let toastTimer = null;
    let toastSeq = 0;
    function showToast(text, ok) {
      const id = ++toastSeq;
      set({ toast: { text, ok: !!ok, id } });
      if (toastTimer !== null) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toastTimer = null;
        if (store.toast && store.toast.id === id) set({ toast: null });
      }, 2000);
    }
    // 自定义输入弹窗（替代浏览器 prompt）：openPrompt 打开、closePrompt 关闭，
    // onOk(value) 在用户点「确定」时收到去空格后的值；点「取消」/关闭不回调。
    let promptSeq = 0;
    function openPrompt(title, initial, onOk) {
      set({ prompt: { id: ++promptSeq, title, initial: (initial || ''), onOk } });
    }
    function closePrompt() {
      set({ prompt: null });
    }
    // 自定义确认弹窗（替代浏览器 confirm）：点「确定」回调 onOk()；
    // 点「取消」/关闭/Esc 不回调。danger=true 时确定按钮用危险色提示。
    function openConfirm(title, message, onOk, okText, danger) {
      set({ confirm: { title, message: (message || ''), onOk, okText: (okText || '确定'), danger: !!danger } });
    }
    function closeConfirm() {
      set({ confirm: null });
    }

    // ---- 版本更新弹窗（What's New）----
    // 「是否弹、以哪种模式弹」的判定在 Host 端完成并随 manifest 下发
    // whatsNewState（fresh/upgrade/seen/downgrade），客户端只执行结论：
    //   fresh → 欢迎模式（whatsNewWelcome 卖点）；upgrade → 当前版更新内容；
    //   seen → 不弹；downgrade → 静默把已看标记改写为当前版，不弹（避免用户在
    //   新旧版本间来回切换时反复被打扰）。
    // whatsNewAutoShown 保证每次页面加载至多触发一次：rescan / 换目录带来的
    // manifest 刷新不会重新弹窗。
    let whatsNewAutoShown = false;
    let whatsNewTimer = null;
    function scheduleWhatsNewAuto() {
      if (whatsNewAutoShown) return;
      whatsNewAutoShown = true;
      if (whatsNewTimer !== null) clearTimeout(whatsNewTimer);
      // 延迟 ~600ms 弹出：等首帧渲染稳定（面板/播放条先绘完），避免抢在首绘前
      // 打断加载过程。真实定时器，jsdom 测试用轮询等待即可。
      whatsNewTimer = setTimeout(() => {
        whatsNewTimer = null;
        const st = store.whatsNewState;
        if (st !== 'fresh' && st !== 'upgrade') {
          if (st === 'downgrade' && store.version) savePref(PREF_SEEN_VERSION, store.version);
          return;
        }
        if (st === 'upgrade' && !store.whatsNew) return; // 本版没写条目 → 不打扰
        openWhatsNew(st === 'fresh' ? 'welcome' : 'upgrade');
      }, 600);
    }
    // 打开弹窗（mode: 'welcome' | 'upgrade' | 'history'）。'history' 供「关于」页
    // 手动查看完整更新日志，不做任何判定、直接列历史。
    function openWhatsNew(mode) {
      set({ whatsNewOpen: true, whatsNewMode: mode });
    }
    // 关闭弹窗并写入「已看过当前版本」标记。经 savePref 走 Host prefs（去抖
    // ~800ms 合并写盘，pagehide 兜底 flush）；写失败只表现为下次还会弹，无害。
    // history 模式（手动查看）关闭时同样顺带写标记——版本号是当前版，语义一致。
    function dismissWhatsNew() {
      set({ whatsNewOpen: false });
      if (store.version) savePref(PREF_SEEN_VERSION, store.version);
    }

    const trackById = (id) => (store.tracks || []).find((t) => t.id === id) || null;

    // ---- 自建歌单：范围 / 解析 / 收藏 ----
    const FAV_PLAYLIST_ID = 'pl-fav';
    const playlistById = (id) => (store.playlists || []).find((p) => p.id === id) || null;
    // 解析任意可播放对象：歌单成员 id（'p:'+path）优先，其次曲库曲目。
    function resolvePlayable(id) {
      if (id === null || id === undefined) return null;
      if (String(id).startsWith('qq:')) {
        const mid = String(id).slice(3);
        const song = (store.qqQueue || []).find((t) => String(t.songmid || t.id) === mid);
        return { id, name: (song && song.title) || store.currentName || 'QQ音乐', url: '/dsh-music/qq/play/' + mid, artists: (song && song.artists) || [] };
      }
      if (String(id).startsWith('kg:')) {
        // 酷狗在线曲目：hash 是 32 位十六进制稳定标识，取链路由按缓存的歌曲元数据
        // （sqHash 等各档位 hash 组）请求 tracker；队列为空（刷新恢复中）也能播。
        const hash = String(id).slice(3);
        const song = (store.kgQueue || []).find((t) => String(t.hash) === hash);
        return { id, name: (song && song.title) || store.currentName || '酷狗音乐', url: '/dsh-music/kg/play/' + hash, artists: (song && song.artists) || [] };
      }
      if (String(id).startsWith('p:')) {
        for (const p of store.playlists || []) {
          const m = (p.tracks || []).find((t) => t.id === id);
          if (m) return m;
        }
        return null;
      }
      return trackById(id);
    }
    // 当前范围的有序 id 列表：歌单非空则用歌单，否则回退曲库（空/已删歌单优雅回退）。
    function activeIds() {
      const s = store.scope || { kind: 'library' };
      if (s.kind === 'qq') return (store.qqQueue || []).map((t) => 'qq:' + String(t.songmid || t.id)); // 在线队列
      if (s.kind === 'kg') return (store.kgQueue || []).map((t) => 'kg:' + String(t.hash)); // 酷狗在线队列
      if (s.kind === 'playlist') {
        const pl = playlistById(s.id);
        if (pl && pl.tracks && pl.tracks.length > 0) return pl.tracks.map((t) => t.id);
        return (store.tracks || []).map((t) => t.id);
      }
      return (store.tracks || []).map((t) => t.id);
    }
    function scopeKey() {
      const s = store.scope || { kind: 'library' };
      if (s.kind === 'qq') return 'qq';
      if (s.kind === 'kg') return 'kg';
      return s.kind === 'playlist' ? 'pl:' + s.id : 'lib';
    }
    // 当前播放曲目对应的绝对路径（用于收藏判断）。
    function currentTrackPath() {
      if (store.currentId === null) return null;
      if (String(store.currentId).startsWith('p:')) return String(store.currentId).slice(2);
      const t = trackById(store.currentId);
      return t && t.path ? t.path : null;
    }
    function isCurrentFaved() {
      // 在线 QQ 曲目：收藏状态走 store.qqFaved（QQ 音乐「我喜欢」）。
      if (store.currentId !== null && String(store.currentId).startsWith('qq:')) return !!store.qqFaved;
      // 在线酷狗曲目：收藏状态走 store.kgFaved（酷狗「我喜欢」）。
      if (store.currentId !== null && String(store.currentId).startsWith('kg:')) return !!store.kgFaved;
      const path = currentTrackPath();
      if (path === null) return false;
      const fav = playlistById(FAV_PLAYLIST_ID);
      return fav !== null && (fav.tracks || []).some((m) => m.path === path);
    }
    function updatePlaylistInStore(pl) {
      if (!pl || !pl.id) return;
      set({ playlists: (store.playlists || []).map((p) => (p.id === pl.id ? pl : p)) });
    }
    function apiPlaylistAdd(id, paths, then) {
      fetch('/dsh-music/playlist/add', {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, paths }),
      }).then((r) => r.json()).then((r) => { if (r && r.playlist) updatePlaylistInStore(r.playlist); if (then) then(r); }).catch(() => { if (then) then(null); });
    }
    function apiPlaylistRemove(id, paths, then) {
      fetch('/dsh-music/playlist/remove', {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, paths }),
      }).then((r) => r.json()).then((r) => { if (r && r.playlist) updatePlaylistInStore(r.playlist); if (then) then(r); }).catch(() => {});
    }
    function apiPlaylistReorder(id, paths) {
      fetch('/dsh-music/playlist/reorder', {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, paths }),
      }).then((r) => r.json()).then((r) => { if (r && r.playlist) updatePlaylistInStore(r.playlist); }).catch(() => {});
    }
    // 本地持久化「我喜欢」songid/songmid 集合：即使服务器读接口失败（如
    // 缺少 enc_host_uin），已收藏歌曲的爱心状态依然可靠；服务器读到后以服务器为准。
    function persistQQFav(ids, mids) {
      try { savePref(PREF_QQ_FAV, JSON.stringify({ ids: ids || [], mids: mids || [] })); } catch (e) {}
    }
    function loadQQFavLocal() {
      try {
        const raw = loadPref(PREF_QQ_FAV);
        if (raw) { const d = JSON.parse(raw); return { ids: Array.isArray(d.ids) ? d.ids : [], mids: Array.isArray(d.mids) ? d.mids : [] }; }
      } catch (e) {}
      return { ids: [], mids: [] };
    }
    // 在线 QQ 曲目收藏切换：加入/移出 QQ 音乐「我喜欢」。
    function toggleQQFav() {
      if (store.currentId === null || !String(store.currentId).startsWith('qq:')) return;
      const mid = String(store.currentId).slice(3);
      const song = (store.qqQueue || []).find((t) => String(t.songmid || t.id) === mid);
      if (!song) return;
      const sid = Number(song.songid) || 0;
      const smid = String(song.songmid || '');
      const action = store.qqFaved ? 'remove' : 'add';
      fetch('/dsh-music/qq/fav', {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, song }),
      })
        .then((r) => r.json().then((d) => ({ d, status: r.status })).catch(() => ({ d: null, status: r.status })))
        .then(({ d, status }) => {
          if (d && d.ok) {
            set({ qqFaved: !!d.faved });
            // 同步本地「我喜欢」id/mid 集合，便于后续曲目判断（并持久化兜底）。
            if (sid || smid) {
              const ids = new Set(store.qqFavIds || []);
              const mids = new Set(store.qqFavMids || []);
              if (action === 'add') { if (sid) ids.add(sid); if (smid) mids.add(smid); }
              else { if (sid) ids.delete(sid); if (smid) mids.delete(smid); }
              const idsA = [...ids], midsA = [...mids];
              set({ qqFavIds: idsA, qqFavMids: midsA });
              persistQQFav(idsA, midsA);
            }
            // 通知 QQ 面板刷新「我喜欢」歌单的数目。
            set({ qqFavRev: (store.qqFavRev || 0) + 1 });
            // 「我喜欢」内容变了 → 通知面板刷新来源歌单的播放列表。
            set({ qqQueueRev: (store.qqQueueRev || 0) + 1 });
          }
          else if (d && d.error) set({ error: d.error });
          else set({ error: '收藏失败（HTTP ' + status + '），请重试' });
        })
        .catch(() => { set({ error: '收藏失败，请重试' }); });
    }
    // 拉取「我喜欢」已收藏 songid/songmid 集合（每个会话只拉一次）。
    // 读失败时回退到本地持久化集合，保证爱心状态可靠。
    let qqFavFetched = false;
    function ensureQQFavIds() {
      if (qqFavFetched) return Promise.resolve({ ids: store.qqFavIds || [], mids: store.qqFavMids || [] });
      qqFavFetched = true;
      return fetch('/dsh-music/qq/liked', { cache: 'no-store' })
        .then((r) => r.json())
        .then((d) => {
          if (d && d.ok && Array.isArray(d.ids)) {
            const ids = d.ids, mids = Array.isArray(d.mids) ? d.mids : [];
            set({ qqFavIds: ids, qqFavMids: mids });
            persistQQFav(ids, mids);
            return { ids, mids };
          }
          // 服务器读失败：回退本地持久化集合。
          const local = loadQQFavLocal();
          set({ qqFavIds: local.ids, qqFavMids: local.mids });
          return local;
        })
        .catch(() => {
          const local = loadQQFavLocal();
          set({ qqFavIds: local.ids, qqFavMids: local.mids });
          return local;
        });
    }
    // 登录成功后可强制重新拉取「我喜欢」集合（此前可能因未登录而缓存了空数组）。
    function refreshQQFavIds() {
      qqFavFetched = false;
      return ensureQQFavIds();
    }
    // 判断当前在线曲目是否已收藏，据此点亮爱心。
    function checkQQFavForCurrent() {
      if (store.currentId === null || !String(store.currentId).startsWith('qq:')) return;
      const mid = String(store.currentId).slice(3);
      const song = (store.qqQueue || []).find((t) => String(t.songmid || t.id) === mid);
      const smid = (song && String(song.songmid || '')) || '';
      const sid = (song && Number(song.songid)) || 0;
      if (!smid && !sid) { set({ qqFaved: false }); return; }
      ensureQQFavIds().then(({ ids, mids }) => {
        if (store.currentId !== 'qq:' + mid) return; // 已切歌，忽略过期结果
        const liked = (smid !== '' && (mids || []).includes(smid)) || (sid > 0 && (ids || []).includes(sid));
        set({ qqFaved: !!liked });
      });
    }
    // ---- 在线酷狗「我喜欢」收藏状态（播放条爱心）----
    // 拉取「我喜欢」已收藏 hash 集合 + fileId 映射 + listid（缓存 Promise：并发调用
    // 共享同一次请求；请求进行中再次调用会等它完成而不是读到还没填充的空集合，避免
    // 刷新恢复时 restore 的 checkKGFavForCurrent 在拉取进行中被误判为未收藏）。
    // 酷狗登录态判定：后端在「刷新也遇 20017/20018」时已自动登出并回 kgLoginDead
    // 标记，或报错文案含设备不匹配；客户端据此通知面板回到扫码登录页。
    const isKgAuthDead = (d) => !!d && (
      d.kgLoginDead === true
      || /酷狗登录已失效|登录态与设备不匹配|请重新扫码/.test(String(d.error || ''))
    );
    function markKgAuthDead(msg) {
      set({ kgAuthDeadMsg: String(msg || '酷狗登录已失效（登录态与设备不匹配），请重新扫码登录') });
    }
    // 酷狗播放失败后的登录态复查：取链失败时若服务端已自动登出（登录已失效），
    // 通知面板回到扫码登录页；登录正常则无操作。一次失败只查一次，防并发重复。
    let kgPlayFailCheckInFlight = false;
    function checkKgAuthAfterPlayFail() {
      if (kgPlayFailCheckInFlight) return;
      kgPlayFailCheckInFlight = true;
      fetch('/dsh-music/kg/status', { cache: 'no-store' })
        .then((r) => r.json())
        .then((d) => {
          if (d && !d.loggedIn && String(store.currentId || '').startsWith('kg:')) {
            markKgAuthDead('酷狗登录已失效（登录态与设备不匹配），请重新扫码登录');
          }
        })
        .catch(() => {})
        .finally(() => { kgPlayFailCheckInFlight = false; });
    }
    let kgFavPromise = null;
    function ensureKGFav() {
      if (kgFavPromise) return kgFavPromise;
      kgFavPromise = fetch('/dsh-music/kg/liked', { cache: 'no-store' })
        .then((r) => r.json())
        .then((d) => {
          set({ kgFavLoaded: true });
          if (isKgAuthDead(d)) markKgAuthDead(d.error);
          if (d && d.ok && Array.isArray(d.hashes)) {
            const hashes = d.hashes, files = Array.isArray(d.files) ? d.files : [];
            set({ kgFavHashes: hashes, kgFavFiles: files, kgFavListId: Number(d.listId) || 0 });
            return { hashes, files, listId: Number(d.listId) || 0 };
          }
          return { hashes: [], files: [], listId: 0 };
        })
        .catch(() => ({ hashes: [], files: [], listId: 0 }));
      return kgFavPromise;
    }
    // 登录成功后可强制重新拉取「我喜欢」集合（此前可能因未登录而缓存了空数组）。
    // 拉取完成后重新评估当前酷狗曲目的收藏状态：修复「刷新页面恢复酷狗曲目」时
    // restore 路径的首次 /liked 请求可能过早/失败、导致爱心不亮的竞态——面板登录
    // 检测成功重新拉集合后，这里必须再补一次 checkKGFavForCurrent。
    function refreshKGFavIds() {
      kgFavPromise = null;
      return ensureKGFav().then((res) => {
        checkKGFavForCurrent();
        return res;
      });
    }
    // 判断当前酷狗曲目是否已收藏到「我喜欢」，据此点亮爱心。
    function checkKGFavForCurrent() {
      if (store.currentId === null || !String(store.currentId).startsWith('kg:')) return;
      const hash = String(store.currentId).slice(3);
      if (!hash) { set({ kgFaved: false }); return; }
      ensureKGFav().then(({ hashes }) => {
        if (store.currentId !== 'kg:' + hash) return; // 已切歌，忽略过期结果
        set({ kgFaved: Array.isArray(hashes) && hashes.includes(hash) });
      });
    }
    // 酷狗曲目收藏切换：加入/移出酷狗「我喜欢」（复用 playlist-add / playlist-remove）。
    function toggleKGFav() {
      if (store.currentId === null || !String(store.currentId).startsWith('kg:')) return;
      const hash = String(store.currentId).slice(3);
      const song = (store.kgQueue || []).find((t) => String(t.hash) === hash) || null;
      if (!song) return;
      const listId = Number(store.kgFavListId) || 0;
      if (!listId) { set({ error: '缺少「我喜欢」歌单，无法收藏' }); return; }
      const action = store.kgFaved ? 'remove' : 'add';
      const body = { song, listId };
      if (action === 'remove') {
        // 移除需要该歌在「我喜欢」里的 fileId（来自歌曲对象或 /liked 的 hash→fileId 映射）。
        const fileId = Number(song.fileId || ((store.kgFavFiles || []).find((f) => String(f.hash) === hash) || {}).fileId || 0) || 0;
        if (!fileId) { set({ error: '缺少 fileId，无法从「我喜欢」移除' }); return; }
        body.fileId = fileId;
      }
      fetch('/dsh-music/kg/' + (action === 'add' ? 'playlist-add' : 'playlist-remove'), {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then((r) => r.json().then((d) => ({ d, status: r.status })).catch(() => ({ d: null, status: r.status })))
        .then(({ d, status }) => {
          if (isKgAuthDead(d)) markKgAuthDead(d.error);
          if (d && d.ok) {
            set({ kgFaved: action === 'add' });
            // 同步本地「我喜欢」hash 集合 + fileId 映射，便于后续曲目判断。
            const hashes = new Set(store.kgFavHashes || []);
            const files = (store.kgFavFiles || []).slice();
            if (action === 'add') { hashes.add(hash); if (Number(song.fileId) > 0) files.push({ hash, fileId: Number(song.fileId) }); }
            else {
              hashes.delete(hash);
              const i = files.findIndex((f) => String(f.hash) === hash);
              if (i >= 0) files.splice(i, 1);
            }
            set({ kgFavHashes: [...hashes], kgFavFiles: files });
            // 通知酷狗面板刷新「我的歌单」（我喜欢歌单数目变化）。
            set({ kgFavRev: (store.kgFavRev || 0) + 1 });
            // 「我喜欢」内容变了 → 通知面板刷新来源歌单的播放列表。
            set({ kgQueueRev: (store.kgQueueRev || 0) + 1 });
          }
          else if (d && d.error) set({ error: d.error });
          else set({ error: '收藏失败（HTTP ' + status + '），请重试' });
        })
        .catch(() => { set({ error: '收藏失败，请重试' }); });
    }
    // 收藏切换：加入/移出「我最喜欢」。在线 QQ 曲目走 QQ 音乐「我喜欢」，
    // 在线酷狗曲目走酷狗「我喜欢」。
    function toggleFav() {
      if (store.currentId !== null && String(store.currentId).startsWith('qq:')) { toggleQQFav(); return; }
      if (store.currentId !== null && String(store.currentId).startsWith('kg:')) { toggleKGFav(); return; }
      const path = currentTrackPath();
      if (path === null) return;
      const fav = playlistById(FAV_PLAYLIST_ID);
      if (fav === null) return;
      if (isCurrentFaved()) apiPlaylistRemove(FAV_PLAYLIST_ID, [path]);
      else apiPlaylistAdd(FAV_PLAYLIST_ID, [path]);
    }
    // 从歌单/曲库点歌：来源即范围。
    function startPlayFrom(id, kind, plId) {
      if (kind === 'playlist') set({ scope: { kind: 'playlist', id: plId } });
      else set({ scope: { kind: 'library' } });
      startPlay(id);
    }
    // 歌单管理：新建 / 重命名 / 删除 / 移动歌曲。
    function onCreatePlaylist() {
      openPrompt('新建歌单名称', '', (trimmed) => {
        if (!trimmed) return;
        fetch('/dsh-music/playlist', {
          method: 'POST', cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: trimmed }),
        }).then((r) => r.json()).then((r) => {
          if (r && r.playlist) {
            set({ playlists: [...(store.playlists || []), r.playlist], subTab: r.playlist.id });
          }
        }).catch(() => {});
      });
    }
    function onRenamePlaylist(pl) {
      openPrompt('重命名歌单「' + pl.name + '」', pl.name, (trimmed) => {
        if (trimmed === pl.name) return;
        fetch('/dsh-music/playlist/rename', {
          method: 'POST', cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: pl.id, name: trimmed }),
        }).then((r) => r.json()).then((r) => { if (r && r.playlist) updatePlaylistInStore(r.playlist); }).catch(() => {});
      });
    }
    function onDeletePlaylist(pl) {
      openConfirm('删除歌单', '删除歌单「' + pl.name + '」？歌曲文件不会被删除。', () => {
        fetch('/dsh-music/playlist/delete', {
          method: 'POST', cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: pl.id }),
        }).then((r) => r.json()).then((r) => {
          if (r && r.ok) {
            const next = (store.playlists || []).filter((p) => p.id !== pl.id);
            set({ playlists: next, subTab: 'library' });
            if (store.scope && store.scope.kind === 'playlist' && store.scope.id === pl.id) {
              set({ scope: { kind: 'library' } });
            }
          }
        }).catch(() => {});
      }, '删除', true);
    }
    // 一键清空歌单（任何歌单都可用，含系统「我最喜欢」；仅从歌单移除，不删文件）。
    function onClearPlaylist(pl) {
      const n = (pl.tracks || []).length;
      if (n === 0 && !pl.missing) return;
      openConfirm('清空歌单', '清空歌单「' + pl.name + '」？将移除全部 ' + n + ' 首歌曲' + (pl.missing > 0 ? '（另有 ' + pl.missing + ' 首已失效一并清除）' : '') + '，歌曲文件不会被删除。', () => {
        fetch('/dsh-music/playlist/clear', {
          method: 'POST', cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: pl.id }),
        }).then((r) => r.json()).then((r) => {
          if (r && r.playlist) updatePlaylistInStore(r.playlist);
        }).catch(() => {});
      }, '确定', true);
    }
    function movePlaylistTrack(pl, path, dir) {
      const paths = (pl.tracks || []).map((t) => t.path);
      const i = paths.indexOf(path);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= paths.length) return;
      const next = paths.slice();
      const tmp = next[i]; next[i] = next[j]; next[j] = tmp;
      apiPlaylistReorder(pl.id, next);
    }

    // restore persisted prefs (mode/volume/voice). Runs again after the Host
    // snapshot is fetched (loadTracks), where the Host value is authoritative.
    applyStoredPrefs();

    // Persist the current playback position. Sources are fully separate so they
    // never clobber each other: local music writes PREF_PLAYBACK, online QQ
    // writes PREF_PLAYBACK_QQ, novels write into the per-book map — switching
    // sources never loses another source's position/queue. (stop() clears the
    // key for whatever source was playing; a null currentId here means stopped.)
    function savePlayback() {
      if (store.currentId === null) return;
      if (String(store.currentId).startsWith('book:')) { saveCurrentBookPlayback(); return; }
      if (String(store.currentId).startsWith('kg:')) {
        // 酷狗在线曲目：保存曲目+队列+进度（hash 是稳定主键，恢复后重新取链播放）。
        const hash = String(store.currentId).slice(3);
        const song = (store.kgQueue || []).find((t) => String(t.hash) === hash);
        if (!song) return;
        savePref(PREF_PLAYBACK_KG, JSON.stringify({
          id: store.currentId, name: store.currentName,
          artists: store.currentArtists || [],
          position: (restoredMusicPos !== null && restoredMusicPos > 0) ? restoredMusicPos : (audio.currentTime || 0),
          duration: Number.isFinite(audio.duration) ? audio.duration : 0,
          queue: store.kgQueue || [], source: store.kgSource || '在线',
          queueFrom: store.kgQueueFrom || null,
          ts: Date.now(),
        }));
        return;
      }
      if (String(store.currentId).startsWith('qq:')) {
        // 在线曲目：保存曲目 + 队列 + 播放位置（刷新/重启后可从中途续播）。
        // 流地址每次经代理重新获取（Range 透传），所以位置 seek 始终有效。
        const mid = String(store.currentId).slice(3);
        const song = (store.qqQueue || []).find((t) => String(t.songmid || t.id) === mid);
        if (!song) return;
        savePref(PREF_PLAYBACK_QQ, JSON.stringify({
          id: store.currentId, name: store.currentName,
          artists: store.currentArtists || [],
          // 与本地曲目一致：恢复中的曲目还没真正加载，currentTime 可能短暂为 0，
          // 用钉住的 restoredMusicPos 覆盖，避免把已恢复的位置写成 0。
          position: (restoredMusicPos !== null && restoredMusicPos > 0) ? restoredMusicPos : (audio.currentTime || 0),
          // 顺手持久化已知时长：恢复时浏览器尚未加载元数据，避免显示 "0:00"。
          duration: Number.isFinite(audio.duration) ? audio.duration : 0,
          queue: store.qqQueue || [], source: store.qqSource || '在线',
          queueFrom: store.qqQueueFrom || null,
          ts: Date.now(),
        }));
        return;
      }
      savePref(PREF_PLAYBACK, JSON.stringify({
        id: store.currentId, name: store.currentName,
        // While a restored track is still paused, the <audio> currentTime can
        // transiently read 0 — never persist that over the restored position.
        position: (restoredMusicPos !== null && restoredMusicPos > 0) ? restoredMusicPos : (audio.currentTime || 0),
        // Persist the known duration too: on restore the browser may not have
        // loaded the track's metadata yet, and we don't want a "0:00" readout.
        duration: Number.isFinite(audio.duration) ? audio.duration : 0,
        ts: Date.now(),
      }));
    }
    function loadPlayback() {
      const raw = loadPref(PREF_PLAYBACK);
      if (raw === null) return null;
      try { const p = JSON.parse(raw); if (p && typeof p.id === 'string') return p; } catch (e) {}
      return null;
    }
    function loadQQPlayback() {
      const raw = loadPref(PREF_PLAYBACK_QQ);
      if (raw === null) return null;
      try { const p = JSON.parse(raw); if (p && typeof p.id === 'string') return p; } catch (e) {}
      return null;
    }
    function loadKGPlayback() {
      const raw = loadPref(PREF_PLAYBACK_KG);
      if (raw === null) return null;
      try { const p = JSON.parse(raw); if (p && typeof p.id === 'string') return p; } catch (e) {}
      return null;
    }

    // ---- 歌词/字幕：播放条"频谱后、时长前"的实时行 ----
    // 音乐：本地 .lrc 解析为 [{t,text}]，跟随 audio.currentTime 定位当前行（与频谱
    // "离线预计算 + 跟随 currentTime"同构）；讲书：当前块文本按句切分，按块内播放
    // 比例逐句推进（实时字幕）。三个来源（本地 .lrc / QQ / 讲书块）共用同一渲染位。
    let musicLyric = [];     // 当前本地曲目的 [{t,text}]
    let musicWordLyric = []; // QRC 行级精确窗口 [{t,end,text}]（秒，服务端按词尾收紧）。非空时优先生效
    let subtitleLines = [];  // 当前讲书块的句子
    let subtitleWeights = []; // 当前讲书块的累计权重（每行显示时长 ∝ 字数+标点停顿）
    let subtitleDur = 0;     // 当前讲书块的时长（用于块内比例定位）
    let lyricTrackId = null; // 已尝试过加载歌词的曲目 id（避免刷新续播时重复请求）
    // 讲书字幕行最长长度（超过时再按自然停顿自适应断行），以及行内自然停顿字符。
    // 注意：SUBTITLE_MAX 是「去标点后的字数」上限——标点不计入，避免标点挤占字数。
    const SUBTITLE_MAX = 20;
    // 断行优先的自然停顿字符：分句停顿（，、：；——…）、句末标点（。！？）、换行。
    const SUBTITLE_CLAUSE_BREAKS = '，、：；——…。！？\n ';
    // 收尾符号（右引号 + 右括号）：断在句尾标点（或硬切边界）后、若紧跟的是一枚收尾
    // 符号，则连同它一并收进本行，避免把「。””」或「）”」这样孤立的收尾符甩到下一行。
    // 成对出现的（）、【】、〈〉、《》 与双引号「”」同款处理：右半随本行收走，左半随下一行。
    const SUB_CLOSE_CHARS = new Set('”」』"）】〉》'.split(''));
    // 断行「容忍」余量：当必须按 SUBTITLE_MAX 边界硬切时，允许本行再多收几个有效字，
    // 以落到边界后不远处的一个自然停顿（断句标点）上，或吞掉本块末尾的极小残留——这样
    // 每行更完整，避免「……他说」被硬切、也避免末尾残留一个极短行。仅在越过边界后累计
    // 额外有效字 ≤ 该值时生效，防止行无限变长。
    const SUBTITLE_TOLERANCE = 3;
    const isSubLowSurrogate = (code) => code >= 0xDC00 && code <= 0xDFFF;
    // 标点集合：不计入「字数」（仍是显示内容，只是长度统计时不算字）。
    const SUB_PUNCT = new Set('，。！？…：；、“”‘’（）《》〈〉［］【】—～·`~!@#$%^&*()-_=+[]{};\':",.<>/?\\|'.split(''));
    const isSubContent = (c) => !/\s/.test(c) && !SUB_PUNCT.has(c);
    const countSubContent = (s) => {
      let c = 0;
      for (let i = 0; i < s.length; i++) if (isSubContent(s[i])) c++;
      return c;
    };
    // 字幕显示的「标点停顿」补偿权重系数：0 = 关闭（仅按字数），>0 = 为句末/分句
    // 标点追加权重，使显示时长更贴合真实朗读（句号停顿 > 逗号）。可调。
    const SUBTITLE_PAUSE_WEIGHT = 1;
    // 把「当前讲书块文本」直接切成字幕行：每行 ≤ SUBTITLE_MAX（去标点字数），优先在
    // 逗号/顿号/句号等自然停顿处换行（不避让引号——长对话也按内部标点优雅切断，而不是
    // 触发兜底硬切），断口后紧跟的右引号会随本行收走。仅当窗口内没有任何停顿标点时才
    // 按字数边界硬切；硬切前先做「容忍」：若边界后不远处就是断句标点，或本块马上就要
    // 结束，就把断行位置往后挪一点，让这一行更完整（见 SUBTITLE_TOLERANCE）。标点不计
    // 字数；空白/换行折叠为空格。
    function wrapSubtitleLine(text) {
      const raw = String(text || '');
      const fold = (s) => s.replace(/\s+/g, ' ').trim();
      if (countSubContent(raw) <= SUBTITLE_MAX) return [fold(raw)];
      const n = raw.length;
      const lines = [];
      let start = 0;
      while (start < n) {
        // 找 end：使 [start, end) 内的「去标点字数」恰为 SUBTITLE_MAX（再多一个就超）。
        let end = n;
        let cnt = 0;
        for (let j = start; j < n; j++) {
          if (isSubContent(raw[j])) cnt++;
          if (cnt > SUBTITLE_MAX) { end = j; break; }
        }
        // Don't split a surrogate pair: if end lands on a low surrogate, back off one.
        if (end < n && isSubLowSurrogate(raw.charCodeAt(end))) end--;
        // Last natural clause break inside [start, end) — 不区分是否在引号内。
        let brk = -1;
        for (let j = start; j < end; j++) {
          if (SUBTITLE_CLAUSE_BREAKS.indexOf(raw[j]) !== -1) brk = j;
        }
        let lineEnd;
        if (brk > start) {
          lineEnd = brk + 1;
        } else {
          // 需要硬切。先容忍：向后看 SUBTITLE_TOLERANCE 个有效字范围内有没有断句标点，
          // 有则把行尾挪到该标点之后（行更完整）。再容忍「块尾」：若边界后只剩极小残留
          // （≤ SUBTITLE_TOLERANCE 个有效字），直接吞掉，避免末尾出一个极短行。
          let where = -1;
          let extra = 0;
          for (let j = end; j < n; j++) {
            if (isSubContent(raw[j])) {
              extra++;
              if (extra > SUBTITLE_TOLERANCE) break; // 超出容忍范围，不再往后找停顿
            }
            if (SUBTITLE_CLAUSE_BREAKS.indexOf(raw[j]) !== -1) { where = j; break; }
          }
          if (where !== -1) {
            lineEnd = where + 1;
          } else {
            const tailContent = countSubContent(raw.slice(end));
            lineEnd = (tailContent > 0 && tailContent <= SUBTITLE_TOLERANCE) ? n : Math.max(start + 1, end);
          }
        }
        // 断句后把紧跟在后面的收尾符号一并收进本行（如 「。.””」「），」），避免孤立成行。
        while (lineEnd < n && SUB_CLOSE_CHARS.has(raw[lineEnd])) lineEnd++;
        lines.push(fold(raw.slice(start, lineEnd)));
        start = lineEnd;
      }
      return lines;
    }
    // 单行显示权重 = 行内「去标点字数」+ 标点停顿补偿（句末停顿 > 分句停顿）。TTS 语速
    // 大致恒定（每秒若干字），所以「显示窗口 ∝ 有效字数」远优于「按行数均分」；标点
    // 停顿让句号/逗号处的自然停顿也计入时长，进一步贴合真实朗读。
    function subtitleLineWeight(line) {
      let w = 0;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (isSubContent(c)) { w++; continue; }
        if (SUBTITLE_PAUSE_WEIGHT > 0) {
          if ('。！？…'.indexOf(c) !== -1) w += SUBTITLE_PAUSE_WEIGHT * 2; // 句末：更长停顿
          else if ('，、：；'.indexOf(c) !== -1) w += SUBTITLE_PAUSE_WEIGHT; // 分句：更短停顿
        }
      }
      return w;
    }
    // 由字幕行数组算累计权重；末项 = 总权重。
    function subtitleCumWeights(lines) {
      const cum = [];
      let acc = 0;
      for (const l of lines) { acc += subtitleLineWeight(l); cum.push(acc); }
      return cum;
    }
    // 按累计权重比例定位：给定播放进度 p (0..1)，返回显示的行下标。
    // 第 i 行在 [cumWeight[i-1]/total, cumWeight[i]/total) 区间内显示。
    function subtitleIndexFor(p, total) {
      const target = p * total;
      let lo = 0, hi = subtitleWeights.length - 1, ans = subtitleWeights.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (subtitleWeights[mid] > target) { ans = mid; hi = mid - 1; }
        else lo = mid + 1;
      }
      return Math.max(0, ans);
    }
    // 讲书「已读字符/全书字符」的实时进度（0..1）。字符数无需合成即可由 Host 精确算出
    // （charOffsets 已缓存于 bookMetaCache），因此能得到稳定的全书占比——而时长占比
    // 做不到：全书总时长在合成本书之前不可知。块内按播放时间占比插值（假设语速大致
    // 恒定），跨块由 charOffsets[from] 阶梯推进，整体单调、切块不回退。meta 未就绪时
    // 返回 0（进度条先不渲染），不阻塞其它功能。
    function bookProgressFor() {
      const id = currentBookId();
      const meta = id !== null ? bookMetaCache.get(id) : undefined;
      const offsets = meta && Array.isArray(meta.charOffsets) ? meta.charOffsets : [];
      if (offsets.length < 2) return 0;
      const total = offsets[offsets.length - 1];
      if (!(total > 0)) return 0;
      const k = bookFromRef;
      if (k < 0 || k >= offsets.length - 1) return 0;
      const dur = Number.isFinite(subtitleDur) && subtitleDur > 0
        ? subtitleDur
        : (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0);
      const frac = dur > 0 ? Math.max(0, Math.min(1, (audio.currentTime || 0) / dur)) : 0;
      const consumed = offsets[k] + (offsets[k + 1] - offsets[k]) * frac;
      return consumed > 0 ? Math.max(0, Math.min(1, consumed / total)) : 0;
    }
    // 卡拉OK帧级驱动：timeupdate 只有 ~4Hz——行切换平均迟到 125ms、最差 250ms，
    // 观感就是「每句歌词慢半拍」。这里提供 karaokeFrame()，挂在既有的可视化 rAF
    // 循环（startRaf）里每帧执行：播放中直接读 audio.currentTime 定位行，换行延迟
    // 降到一帧内；扫色进度以 KAR_TICK_MS 节流下发。不另起独立 rAF 循环。
    const KAR_TICK_MS = 160;
    let lastKarBucket = -1;      // 进度下发节流桶（resetLyric 归零）
    // 裸 LRC 扫色窗口的估算参数：标准 LRC 没有行结束信息，长间奏/末行会把窗口拉爆。
    // 取偏慢唱速估算自然演唱时长封顶——唱完早停满亮，不让扫描拖过演唱。
    const KAR_CJK_SEC = 0.55;     // 每个汉字/假名 ≈0.55s（≈1.8 字/s）
    const KAR_WORD_SEC = 0.45;    // 每个拉丁词 ≈0.45s
    const KAR_WIN_MIN_MS = 1500;  // 极短行下限，避免扫色快闪
    const KAR_WIN_MAX_MS = 30000; // 病理超长行的兜底上限
    // 长静默消隐阈值：句尾到下一句的静默超过它才在唱完后清掉歌词（否则保持到
    // 换行——连续歌词间隙通常 <200ms，保持可避免逐行闪烁）。
    const KAR_CLEAR_GAP_MS = 1200;
    function lyricSingSec(text) {
      const str = String(text || '');
      const cjk = str.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g);
      const words = str.match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g);
      return (cjk ? cjk.length : 0) * KAR_CJK_SEC + (words ? words.length : 0) * KAR_WORD_SEC;
    }
    // 扫色几何的精确逆映射。背景图宽 = 容器 × 2.5，绿/暗分界画在图像绝对位置
    // 1.05 倍容器宽处（渐变 42% 停靠点）。定位百分比 p′ 时窗口左缘位于图像
    // (2.5−1)p′ = 1.5p′ 容器宽处，于是屏幕上「已唱比例 f」= 分界 − 窗口左缘：
    //   f = 1.05 − 1.5p′   ⇔   p′ = (1.05 − f) / 1.5
    // 它不是线性等值的——直觉的 (1−f)×100 会让分界只在行程中段穿越屏幕
    // （p′∈[3.3,70]% 之外分界停在屏外），表现为开局慢半拍/结尾停滞。
    // 此函数是扫色定位的唯一换算出口（React 路径与帧级直写共用）。
    function karPosPct(elapsedMs, durMs) {
      const f = Math.min(1, Math.max(0, elapsedMs / Math.max(1, durMs)));
      const p = (1.05 - f) / 1.5;
      return Math.min(100, Math.max(0, p * 100));
    }
    // 浏览器内的逐帧直写通道：karaokeFrame 每帧把当前扫色位置写到 fx 节点上，
    // 绕过 React 渲染节流（store 的 lyricScan 只承担低频状态与测试确定性）。
    let karScanNode = null;
    function karaokeFrame() {
      if (!store.playing || audio.paused) return;
      if (store.currentId === null || String(store.currentId).startsWith('book:')) return;
      // —— 直接写扫色位置（帧级精度）：独立定位当前行窗口，与 updateLyric 同一数据源。
      // QRC 行窗口（musicWordLyric）与裸 LRC（musicLyric，估算封顶）两条分支都覆盖，
      // 间奏期持续钳位满亮——不会因文本未变而停止校准。
      if (karScanNode !== null) {
        const nowF = audio.currentTime || 0;
        let wl = null, durMs2 = 0;
        if (musicWordLyric.length > 0) {
          let lo2 = 0, hi2 = musicWordLyric.length - 1, wi2 = -1;
          while (lo2 <= hi2) {
            const m2 = (lo2 + hi2) >> 1;
            if (musicWordLyric[m2].t <= nowF) { wi2 = m2; lo2 = m2 + 1; } else hi2 = m2 - 1;
          }
          if (wi2 >= 0) {
            wl = musicWordLyric[wi2];
            durMs2 = Math.max(300, (Number(wl.end) - Number(wl.t)) * 1000);
          }
        } else {
          const idx2 = lyricIndexFor(nowF);
          if (idx2 >= 0) {
            const curT2 = Number(musicLyric[idx2].t) || 0;
            let nextT2;
            if (idx2 < musicLyric.length - 1) nextT2 = Number(musicLyric[idx2 + 1].t) || curT2;
            else {
              const d2 = Number(audio.duration);
              nextT2 = (Number.isFinite(d2) && d2 > curT2) ? d2 : curT2 + 8;
            }
            const gapMs2 = Math.max(0, (nextT2 - curT2) * 1000);
            const estMs2 = lyricSingSec(musicLyric[idx2].text) * 1000;
            durMs2 = Math.min(gapMs2, Math.max(KAR_WIN_MIN_MS, Math.min(KAR_WIN_MAX_MS, estMs2)));
            wl = { t: curT2 };
          }
        }
        if (wl && durMs2 > 0) {
          const el2 = Math.max(0, (nowF - Number(wl.t)) * 1000);
          try { karScanNode.style.backgroundPositionX = karPosPct(el2, durMs2).toFixed(2) + '%'; } catch {}
        }
      }
      updateLyric();
    }
    function resetLyric() {
      musicLyric = [];
      musicWordLyric = [];
      subtitleLines = [];
      subtitleWeights = [];
      subtitleDur = 0;
      lastKarBucket = -1;
      if (store.lyricText !== '' || store.lyricScan !== null || store.lyricSource !== '') {
        set({ lyricText: '', lyricScan: null, lyricSource: '' });
      }
      syncLyricPanelData();
    }
    // 把当前歌词数据同步到 store 的完整歌词行（供歌词/字幕面板渲染并标识当前进度）。
    // 音乐：优先 QRC 行窗口（带 end），回落整行 LRC；讲书：字幕纯文本行。
    // lyricCur 表示当前行下标，随 updateLyric 逐次更新（此处切歌时重置为 -1）。
    function syncLyricPanelData() {
      let lines = [];
      if (subtitleLines.length > 0) {
        lines = subtitleLines.map((t) => ({ text: t }));
      } else if (musicWordLyric.length > 0) {
        lines = musicWordLyric.map((l) => ({ text: l.text, t: Number(l.t) || 0, end: Number(l.end) || 0 }));
      } else if (musicLyric.length > 0) {
        lines = musicLyric.map((l) => ({ text: l.text, t: Number(l.t) || 0, end: 0 }));
      }
      // 浅比较避免无谓重渲染（切歌/歌词加载时才变化）。
      const prev = store.lyricLines || [];
      if (lines.length === prev.length && lines.every((l, i) => prev[i] && l.text === prev[i].text)) {
        if (store.lyricCur !== -1) set({ lyricCur: -1 });
        return;
      }
      set({ lyricLines: lines, lyricCur: -1 });
    }
    // 歌词来源落账：写入 store + 控制台一条轻量日志（播放被静默回退的场景里，
    // 这是确认 QRC 是否生效最直接的证据）。
    function noteLyricSource(src, detail) {
      if ('lyricSource' in store && store.lyricSource === src) return;
      set({ lyricSource: src });
      try { console.info('[dsh-music] 歌词源: ' + src + (detail ? '，' + detail : '')); } catch {}
    }
    // 二分查找：t <= ct 的最大行下标（-1 = 尚未到第一行歌词）。
    function lyricIndexFor(ct) {
      let lo = 0, hi = musicLyric.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (musicLyric[mid].t <= ct) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return ans;
    }
    // 按当前播放位置推进歌词/字幕文本（仅在行文本变化时 set，避免每帧重渲染）。
    // 换行同时携带本行「扫色时间轴」{ dur, elapsed } ms（行时长 / 行内已过时长），
    // 供卡拉OK动效把整行匀速点亮：音乐用相邻 LRC 时间戳差；讲书用权重区间映射块时长。
    // 已知局限：行内 seek 不刷新时间轴（文本没变就不 set），扫色起点停在旧位置，可接受。
    function scanMs(durMs, elapsedMs) {
      const dur = Math.max(250, Math.round(Number(durMs) || 0));
      const elapsed = Math.min(dur, Math.max(0, Math.round(Number(elapsedMs) || 0)));
      return { dur, elapsed };
    }
    // 歌词行定位时钟：优先用实时音频时钟（播放中）。刷新恢复后 <audio> 未加载
    // （自动播放被拦截，暂停等用户点 ▶），audio.currentTime 恒为 0——若直接用会把
    // 歌词错定位到第 0 行/空串。此时回退到恢复时钉住的 store.position。
    function lyricNow() {
      if (audio.currentTime > 0 || audio.duration > 0) return audio.currentTime || 0;
      return (Number.isFinite(store.position) && store.position > 0) ? store.position : 0;
    }
    function updateLyric() {
      if (store.currentId === null) return;
      if (String(store.currentId).startsWith('book:')) {
        if (subtitleLines.length === 0) return;
        const dur = subtitleDur > 0 ? subtitleDur
          : (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0);
        // 刷新恢复后块未合成、dur 未知：回退 p=0 显示该块第一句字幕（与 bookProgressFor
        // 的恢复行为一致，都从块起点展示）；播放后 onTime 会用真实时长校正到当前行。
        const p = dur > 0 ? Math.max(0, Math.min(1, (audio.currentTime || 0) / dur)) : 0;
        // 按「行内字数 + 标点停顿」加权定位（而非按行数均分），偏离真实朗读更小。
        const total = subtitleWeights.length > 0 ? subtitleWeights[subtitleWeights.length - 1] : 0;
        const idx = total > 0
          ? Math.min(subtitleLines.length - 1, subtitleIndexFor(p, total))
          : Math.min(subtitleLines.length - 1, Math.floor(p * subtitleLines.length));
        const text = subtitleLines[idx] || '';
        if (text === store.lyricText) return;
        // 扫色时间轴：行占用 [startW, endW] 权重区间 → 映射到块时长。均分兜底同理。
        let lineStartFrac = 0, lineEndFrac = 1;
        if (total > 0) {
          lineStartFrac = idx > 0 ? (subtitleWeights[idx - 1] / total) : 0;
          lineEndFrac = subtitleWeights[idx] / total;
        } else if (subtitleLines.length > 0) {
          lineStartFrac = idx / subtitleLines.length;
          lineEndFrac = (idx + 1) / subtitleLines.length;
        }
        set({
          lyricText: text,
          lyricScan: scanMs((lineEndFrac - lineStartFrac) * dur * 1000,
            (p - lineStartFrac) * dur * 1000),
          lyricCur: idx >= 0 && idx < subtitleLines.length ? idx : -1,
        });
      } else {
        if (musicWordLyric.length > 0) {
          // —— QRC 精确行窗口：每行自带真实的结束时刻（t..end，服务端已按词尾收紧）。
          // 定位用二分（行按 t 升序）；扫描进度走「音频时钟驱动」，间奏期持续校准满亮。
          // 长静默消隐：句尾之后若距下一句还有一段真正的静默（> KAR_CLEAR_GAP_MS），
          // 唱完即清掉歌词——不再挂着直到下一句；连续歌词间隙小则保持原行为不闪。
          const now2 = lyricNow();
          let lo = 0, hi = musicWordLyric.length - 1, wi = -1;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (musicWordLyric[mid].t <= now2) { wi = mid; lo = mid + 1; } else hi = mid - 1;
          }
          const wline = wi >= 0 ? musicWordLyric[wi] : null;
          const nextLine = wi < musicWordLyric.length - 1 ? musicWordLyric[wi + 1] : null;
          if (wline) {
            const endSec = Number(wline.end);
            const silenceMs = ((nextLine ? Number(nextLine.t)
              : (Number.isFinite(audio.duration) ? audio.duration : endSec)) - endSec) * 1000;
            if (now2 >= endSec && silenceMs > KAR_CLEAR_GAP_MS) {
              lastKarBucket = -1;
              if (store.lyricText !== '') set({ lyricText: '', lyricScan: null });
              return;
            }
          }
          const text = wline ? (wline.text || '') : '';
          // 进度按 ~6Hz 节流下发（桶变化才 set）：rAF 帧循环下避免 60fps 全量重渲染；
          // 文本变化（换行）永远即时。配合渲染层 0.2s 过渡，视觉连续。
          const elapsedMs = wline ? Math.max(0, Math.round((now2 - Number(wline.t)) * 1000)) : 0;
          const bucket = wline ? Math.floor(elapsedMs / KAR_TICK_MS) : -1;
          if (text === store.lyricText && bucket === lastKarBucket) return;
          lastKarBucket = bucket;
          const scanInfo = wline ? scanMs(
            Math.max(300, (Number(wline.end) - Number(wline.t)) * 1000),
            elapsedMs) : null;
          if (scanInfo) scanInfo.baseT = Number(wline.t);
          set({ lyricText: text, lyricScan: scanInfo, lyricCur: wline ? wi : -1 });
        } else {
          if (musicLyric.length === 0) return;
          const now = lyricNow();
          const idx = lyricIndexFor(now);
          const text = idx >= 0 ? (musicLyric[idx].text || '') : '';
          // 与 QRC 分支一致的长静默消隐：估算演唱结束后若距下一行仍有大段静默，
          // 唱完即清掉歌词。
          if (idx >= 0) {
            const curT = Number(musicLyric[idx].t) || 0;
            let nextT;
            if (idx < musicLyric.length - 1) nextT = Number(musicLyric[idx + 1].t) || curT;
            else {
              const d = Number(audio.duration);
              nextT = (Number.isFinite(d) && d > curT) ? d : curT + 8;
            }
            const estMs0 = lyricSingSec(text) * 1000;
            const winMs0 = Math.min(Math.max(0, (nextT - curT) * 1000),
              Math.max(KAR_WIN_MIN_MS, Math.min(KAR_WIN_MAX_MS, estMs0)));
            const endSec = curT + winMs0 / 1000;
            const silenceMs = (nextT - endSec) * 1000;
            if (now >= endSec && silenceMs > KAR_CLEAR_GAP_MS) {
              lastKarBucket = -1;
              if (store.lyricText !== '') set({ lyricText: '', lyricScan: null });
              return;
            }
          }
          // 裸 LRC 同样走音频时钟：进度按桶节流下发（文本变化永远即时）。
          const elapsedMs = idx >= 0 ? Math.max(0, Math.round((now - Number(musicLyric[idx].t)) * 1000)) : 0;
          const bucket = idx >= 0 ? Math.floor(elapsedMs / KAR_TICK_MS) : -1;
          if (text === store.lyricText && bucket === lastKarBucket) return;
          lastKarBucket = bucket;
          let scanInfo = null;
          if (idx >= 0) {
            // 扫色窗口取较小值（elapsed 锚定行起点，超窗即满亮保持）：
            // ① 到下一行的时间差——裸 LRC 只有「每行的开始」没有「结束」，长间奏/末行
            //    （末行退音频总长兜底）会把这个差拉得巨大，直接当窗口就是「摊平」；
            // ② 按字符数估算的自然演唱时长（lyricSingSec）——唱完即停在满亮直到下一
            //    行，配合音频时钟驱动不再被间奏摊平。极短行有下限防快闪。
            const curT = Number(musicLyric[idx].t) || 0;
            let nextT;
            if (idx < musicLyric.length - 1) nextT = Number(musicLyric[idx + 1].t) || curT;
            else {
              const d = Number(audio.duration);
              nextT = (Number.isFinite(d) && d > curT) ? d : curT + 8;
            }
            const gapMs = Math.max(0, (nextT - curT) * 1000);
            const estMs = lyricSingSec(text) * 1000;
            const winMs = Math.min(gapMs, Math.max(KAR_WIN_MIN_MS, Math.min(KAR_WIN_MAX_MS, estMs)));
            scanInfo = scanMs(winMs, elapsedMs);
            scanInfo.baseT = curT;
          }
          set({ lyricText: text, lyricScan: scanInfo, lyricCur: idx >= 0 && idx < musicLyric.length ? idx : -1 });
        }
      }
    }
    // 拉取并解析本地曲目的歌词：优先同名 .lrc（/lyric）；本地无则在线兜底
    // （/lyric/online：Host 按 QQ 音乐 → LRCLIB 匹配取词）。无词/切歌后返回皆静默。
    function loadLyricForTrack(id) {
      resetLyric();
      lyricTrackId = id;
      if (String(id).startsWith('qq:')) { loadQQLyric(id, String(id).slice(3)); return; }
      if (String(id).startsWith('kg:')) {
        // 酷狗在线曲目：从当前队列取完整歌曲对象（hash/标题/歌手/时长）取词。
        // startPlay（自动续播/上下曲）与刷新恢复续播都走这里——之前漏了 kg: 分支，
        // 而酷狗曲目没有本地 path，函数会提前 return → 自动/手动下一首时歌词不出现
        // （只有面板直接点歌的 startKGPlayback 才调 loadKGLyric）。
        const hash = String(id).slice(3);
        const song = (store.kgQueue || []).find((t) => String(t.hash) === hash);
        if (song) loadKGLyric(id, song);
        return;
      }
      const track = resolvePlayable(id);
      if (track === null || !track.path) return;
      fetch('/dsh-music/lyric?path=' + encodeURIComponent(track.path), { cache: 'no-store' })
        .then((r) => r.json())
        .then((d) => {
          if (store.currentId !== id) return; // 取词期间已切歌
          if (d && d.ok && Array.isArray(d.lrc) && d.lrc.length > 0) {
            // 本地 .lrc / 内嵌歌词：若 Host 从「格式 C」拆出了逐句翻译（trans），
            // 用与在线歌词相同的 mergeLyricTrans 合并成「原文 ／ 翻译」。
            musicLyric = mergeLyricTrans(d.lrc, d.trans);
            syncLyricPanelData();
            noteLyricSource(d.source === 'embedded' ? 'embedded' : 'local',
              (d.source === 'embedded' ? '文件内嵌歌词' : '本地同名 .lrc')
                + (Array.isArray(d.trans) && d.trans.length > 0 ? '（含逐句翻译）' : ''));
            updateLyric();
            return;
          }
          // 本地无同名 .lrc → 在线兜底（QQ → LRCLIB）
          loadOnlineLyric(id, track);
        })
        .catch(() => {});
    }
    // 从文件名 stem 拆「歌手 - 歌名」。常见命名：'周杰伦 - 乱舞春秋'、'周杰伦、温岚 - 屋顶'、
    // '周杰伦 余妮 - 懦夫'、'周杰伦 - 李玟 - 刀马旦'。以最后一个 ' - '/'–'/'—' 为界：
    // 前段当歌手（可含多位/空格/顿号），后段当歌名；没有分隔符时整段当歌名（歌手留空）。
    // 拆出干净歌名 + 歌手能显著提高在线歌词匹配精度（否则前缀会拖低匹配分）。
    function splitArtistTitle(stem) {
      const m = /^(.*)[-–—]\s*(.+)$/.exec(String(stem || ''));
      if (!m) return { title: String(stem || ''), artist: '' };
      return { title: m[2].trim(), artist: m[1].trim() };
    }
    // 本地歌曲在线歌词兜底：把文件名拆出的歌名/歌手 + 时长交给 Host 去 QQ/LRCLIB 匹配取词。
    function loadOnlineLyric(id, track) {
      const base = String(track.name || '').split(/[\\/]/).pop();
      const { title, artist } = splitArtistTitle(stripExt(base));
      const params = new URLSearchParams({ path: track.path, title });
      if (artist !== '') params.set('artist', artist);
      else if (Array.isArray(track.artists) && track.artists.length > 0) params.set('artist', track.artists.join('/'));
      if (Number.isFinite(audio.duration) && audio.duration > 0) params.set('duration', String(Math.round(audio.duration)));
      fetch('/dsh-music/lyric/online?' + params.toString(), { cache: 'no-store' })
        .then((r) => r.json())
        .then((d) => {
          if (!d || !d.ok) return;
          if (store.currentId !== id) return; // 取词期间已切歌
          // QRC 精确行窗口（wordLines）优先；无则回落普通 LRC。
          if (Array.isArray(d.wordLines) && d.wordLines.length > 0) {
            musicWordLyric = d.wordLines;
            syncLyricPanelData();
            noteLyricSource(d.source || 'qq-qrc', d.wordLines.length + ' 行（QRC 精确行窗口）');
            updateLyric();
            return;
          }
          if (!Array.isArray(d.lrc) || d.lrc.length === 0) return;
          musicLyric = mergeLyricTrans(d.lrc, d.trans);
          syncLyricPanelData();
          noteLyricSource(d.source || 'qq', d.lrc.length + ' 行（整行 LRC，无逐字时间轴）');
          updateLyric();
        })
        .catch(() => {});
    }
    // 在线 QQ 歌词：Host 按 songmid 取词（匿名，QRC 行窗口优先 → 整行 LRC 兜底），
    // 逐句翻译合并进同一行（原文 ／ 翻译）。
    function loadQQLyric(id, songmid) {
      // 先清掉旧的歌词/讲书字幕数据：本函数会被 startQQPlayback 直接调用（不经
      // loadLyricForTrack 的 resetLyric），若不重置，从 AI 讲书切到 QQ 时残留的
      // subtitleLines 会让歌词面板继续显示小说字幕（syncLyricPanelData 优先取字幕）。
      resetLyric();
      fetch('/dsh-music/qq/lyric?songmid=' + encodeURIComponent(songmid), { cache: 'no-store' })
        .then((r) => r.json())
        .then((d) => {
          if (!d || !d.ok) return;
          if (store.currentId !== id) return; // 取词期间已切歌
          // QRC 精确行窗口（wordLines）优先；无则回落普通 LRC。
          if (Array.isArray(d.wordLines) && d.wordLines.length > 0) {
            musicWordLyric = d.wordLines;
            syncLyricPanelData();
            noteLyricSource(d.source || 'qq-qrc', d.wordLines.length + ' 行（QRC 精确行窗口）');
            updateLyric();
            return;
          }
          if (!Array.isArray(d.lrc)) return;
          musicLyric = mergeLyricTrans(d.lrc, d.trans);
          syncLyricPanelData();
          noteLyricSource('qq', d.lrc.length + ' 行（QQ 在线歌曲，整行 LRC）');
          updateLyric();
        })
        .catch(() => {});
    }
    // 把翻译行并入原歌词：时间相近（<0.6s）的翻译拼到原行后面。
    function mergeLyricTrans(lrc, trans) {
      if (!Array.isArray(lrc)) return [];
      if (!Array.isArray(trans) || trans.length === 0) return lrc;
      return lrc.map((line) => {
        let best = null, bestD = 0.6;
        for (const tr of trans) {
          const d = Math.abs(tr.t - line.t);
          if (d < bestD) { bestD = d; best = tr; }
        }
        return best ? { t: line.t, text: line.text + ' ／ ' + best.text } : line;
      });
    }
    // 拉取当前讲书块文本并切成字幕行（每次切块时调用）。
    // 用 book.url 作为基座（真实书 /dsh-music/book/<id>，新闻期次 /dsh-music/news/<id>），
    // 字幕路由与音频/元数据一致——否则新闻期次会打到不存在的 /dsh-music/book/<news-id> 而无声幕。
    function loadBookSubtitle(id, from) {
      resetLyric();
      const book = bookById(id);
      if (book === null || !book.url) return;
      fetch(book.url + '/text?from=' + from, { cache: 'no-store' })
        .then((r) => r.json())
        .then((d) => {
          if (!d || !d.ok || currentBookId() !== id) return; // 已切书/切块
          subtitleLines = wrapSubtitleLine(d.text);
          subtitleWeights = subtitleCumWeights(subtitleLines);
          syncLyricPanelData();
          updateLyric();
        })
        .catch(() => {});
    }

    // 刷新恢复后（暂停态）预载歌词/字幕并显示到恢复位置：音乐按恢复位置定位当前行；
    // 讲书按恢复块显示该块字幕（块时长未合成前不可知，先展示块首句，播放后校正）。
    // 否则刷新后音频未加载、无 timeupdate，歌词/字幕数据也未被加载，播放条一直空白。
    function restoreLyricForCurrent() {
      if (store.currentId === null) return;
      if (String(store.currentId).startsWith('book:')) {
        if (bookFromRef >= 0) loadBookSubtitle(store.currentId.slice(5), bookFromRef);
      } else if (lyricTrackId !== store.currentId) {
        loadLyricForTrack(store.currentId);
      }
    }

    // ---- bar color + canvas drawing ----
    let barCanvasNode = null;
    let rafId = null;
    const smoothCur = new Float32Array(VIZ_BARS);
    const smoothPeak = new Float32Array(VIZ_BARS);
    const targetBuf = new Float32Array(VIZ_BARS);
    // Accent color for the spectrum bars. DSH defines its --dsw-alias-* theme
    // tokens on <body> — never on :root — so --dsh-music-accent must be read
    // from body (reading documentElement would always return the fallback and
    // the bars would never follow the theme). The value is cached but the cache
    // is invalidated whenever the theme changes at runtime: the ThemePresenter
    // projects tokens + the dark attribute onto body, so a MutationObserver on
    // body's style/dark-attribute keeps the bars tracking live brand changes.
    let accentColor = null;
    let accentObserver = null;
    function readAccent() {
      const el = document.body || document.documentElement;
      return getComputedStyle(el).getPropertyValue('--dsh-music-accent').trim() || '#2f9e6e';
    }
    function currentAccent() {
      if (accentColor === null) accentColor = readAccent();
      return accentColor;
    }
    // A peak-cap color that ALWAYS contrasts with the bar, whatever the theme:
    // parse the accent (hex or rgb) and push it toward white if it's dark, toward
    // black if it's light — so the trailing "渐落" line stays visible on both dark
    // and light themes (a fixed white cap would vanish on light themes).
    function parseColor(color) {
      if (typeof color !== 'string') return null;
      let m = /^#([0-9a-f]{3})$/i.exec(color);
      if (m) { const n = parseInt(m[1], 16); return [((n >> 8) & 0xf) * 17, ((n >> 4) & 0xf) * 17, (n & 0xf) * 17]; }
      m = /^#([0-9a-f]{6})$/i.exec(color);
      if (m) { const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
      m = /^rgba?\(([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/i.exec(color);
      if (m) return [Math.round(Number(m[1])), Math.round(Number(m[2])), Math.round(Number(m[3]))];
      return null;
    }
    function capColorFor(color) {
      const rgb = parseColor(color);
      if (rgb === null) return color; // can't derive → keep the bar color (no worse than before)
      const lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
      const target = lum > 128 ? 0 : 255;
      const mix = (v) => Math.round(v + (target - v) * 0.75);
      return 'rgb(' + mix(rgb[0]) + ',' + mix(rgb[1]) + ',' + mix(rgb[2]) + ')';
    }
    function watchAccent() {
      if (accentObserver !== null) return accentObserver;
      if (typeof MutationObserver === 'undefined') return null;
      accentObserver = new MutationObserver(() => { accentColor = readAccent(); });
      accentObserver.observe(document.body, { attributes: true, attributeFilter: ['style', 'data-ds-dark-theme'] });
      return accentObserver;
    }

    // ---- live real-time analyser (BEST-EFFORT tap; NEVER reroutes audio) ----
    // captureStream() is a read-only TAP of the playing <audio>: it does NOT redirect
    // the element's output (unlike createMediaElementSource, which routes it into the
    // Web Audio graph and goes SILENT whenever that graph/context isn't running — which
    // is exactly what killed the audio after switching a few tracks). So this can never
    // mute the player: worst case the analyser reads silence and the visualization
    // simply shows nothing (no offline fallback — "失败即不显示").
    //
    // It's created only once the element has a real src (startPlay / the play event) so
    // the captured MediaStream carries an audio track. If this browser's media pipeline
    // still refuses a track (the getTopURL bug), vizLive stays false and we draw nothing.
    // Fixed per-band frequency-weighting gain (0..1, top band = 1) used by the live
    // analyser. A raw frequency read is an ABSOLUTE dB magnitude, and music's natural 1/f
    // (bass-heavy) tilt maps the low bands near the top while the high bands sit low. This
    // FIXED, level-independent weighting flattens the SHAPE while ABSOLUTE loudness still
    // drives each bar — a quiet passage stays low (no per-band auto-gain, which would inflate a
    // quiet band to full). gain[b] = (center_b / center_top) ^ ALPHA. With ALPHA=0.12 the low
    // band is attenuated to ~0.53 while the top band keeps 1.0 — enough to counter the typical
    // bass-heavy envelope without inverting the spectrum or pinning the highs.
    const VIZ_TILT_ALPHA = 0.12;
    function bandTiltGain(sampleRate) {
      const g = new Float32Array(VIZ_BARS);
      const maxF = Math.min((sampleRate || 48000) / 2, 18000);
      const ratio = maxF / 40;
      let cTop = 0;
      for (let b = 0; b < VIZ_BARS; b++) cTop = 40 * Math.pow(ratio, (b + 0.5) / VIZ_BARS);
      for (let b = 0; b < VIZ_BARS; b++) {
        const c = 40 * Math.pow(ratio, (b + 0.5) / VIZ_BARS);
        g[b] = cTop > 0 ? Math.pow(c / cTop, VIZ_TILT_ALPHA) : 1;
      }
      return g;
    }
    let vizCtx = null;
    let vizAnalyser = null;
    let vizFreq = null;
    let vizWave = null;         // time-domain samples (waveform mode), Uint8Array
    let vizLive = false;
    let vizLiveOK = false;      // live analyser has produced real signal for the CURRENT track
    let vizSetupState = 0;      // 0 = not tried; 1 = live active; 2 = permanently unavailable
    const vizBands = new Float32Array(VIZ_BARS);
    // Per-frame smoothed time-domain samples for the waveform curve. Each point is
    // normalized to 0..1 (0.5 = center line) and eased toward the live read each frame
    // so the trace stays stable instead of jittering frame to frame.
    let vizWaveSmooth = null;
    // 分频段多线：每段一条归一化(0..1)时域波形，长度 = VIZ_WAVE_BANDS.length * n（平滑副本），
    // 以及每帧复用的 FFT 工作缓冲。
    let vizBandSmooth = null;
    let vizBandFilter = null;    // 每频段时域带通（2×HP + 2×LP biquad 级联）状态
    let vizScratchA = null;      // 每帧复用的滤波工作缓冲（避免反复分配）
    let vizScratchB = null;
    let vizBandPeak = null;      // 每频段慢峰值（自适应增益的响度参考）
    let vizBandGain = null;      // 每频段自适应增益（默认 VIZ_WAVE_GAIN）
    let vizBandMean = null;      // 每频段波形均值（分析路径算好，绘制直接复用免每帧重扫）
    let vizFilterTime = null;    // 上次消费音频缓冲的 vizCtx.currentTime（用于算新增样本数）
    // 降采样包络缓冲：每像素列的最小/最大偏差（复用缓冲，避免每帧分配）。
    let vizEnvMin = null;
    let vizEnvMax = null;
    let vizEnvW = 0;             // 包络缓冲对应的画布列数（变化时才重建）
    // 2d context 缓存：canvas 元素在播放条重挂载时才换新实例，按实例比对复用，
    // 省掉每帧 2-3 次 getContext('2d') 调用。
    let vizCanvas2d = null;
    let vizCanvas2dFor = null;
    function vizGet2D(canvas) {
      if (vizCanvas2dFor !== canvas || vizCanvas2d === null) {
        vizCanvas2d = canvas.getContext('2d');
        vizCanvas2dFor = canvas;
      }
      return vizCanvas2d;
    }
    // Cached per-band frequency-weighting gain for the live analyser; shared code is
    // bandTiltGain(sampleRate) in the spectrum section. Recomputing is needed only when the
    // AudioContext sample rate changes (a new tap), so it's reset in setupLiveViz.
    let vizTiltGain = null;
    function liveTiltGain() {
      if (vizTiltGain !== null) return vizTiltGain;
      const sr = (vizCtx && vizCtx.sampleRate) || 48000;
      vizTiltGain = bandTiltGain(sr);
      return vizTiltGain;
    }
    function resumeVizCtx() {
      try {
        if (vizCtx !== null && vizCtx.state === 'suspended') {
          const p = vizCtx.resume();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
      } catch (e) { /* best-effort */ }
    }
    function setupLiveViz() {
      if (vizLive) return true;
      if (vizSetupState === 2) return false;
      // Web Audio capability checks.
      const Ctor = window.AudioContext || window.webkitAudioContext;
      const hasCapture = typeof audio.captureStream === 'function';
      if (!hasCapture) { vizSetupState = 2; return false; }
      if (Ctor === undefined) { vizSetupState = 2; return false; }
      // IMPORTANT: calling captureStream() before the element has any data returns a
      // MediaStream with NO audio track — and because a media element returns the SAME
      // cached stream on every captureStream() call, that 0-track stream sticks forever.
      // So only capture once the element is actually playing (readyState >= 3);
      // otherwise retry from the 'playing' event.
      if (audio.readyState < 3) return false;
      try {
        const stream = audio.captureStream();
        let tracks = [];
        if (stream && typeof stream.getAudioTracks === 'function') { try { tracks = stream.getAudioTracks(); } catch (e) { tracks = []; } }
        if (!stream || typeof stream.getAudioTracks !== 'function') { vizSetupState = 2; return false; }
        if (tracks.length === 0) return false; // no audio track -> visualization shows nothing
        vizCtx = new Ctor();
        const srcNode = vizCtx.createMediaStreamSource(stream);
        vizAnalyser = vizCtx.createAnalyser();
        vizAnalyser.fftSize = 2048;
        // Bar HEIGHT is governed by the dB range below. This matches the audioMotion-analyzer
        // default (min:-85, max:-25) so the display scale is consistent with that mature
        // implementation. The temporal smoothing keeps the bars crisp and "follow the hand":
        // low value => the analyser tracks the instantaneous FFT so the bars snap to the music
        // (with only our own rise/fall smoothing in drawViz on top).
        vizAnalyser.smoothingTimeConstant = 0.3;
        vizAnalyser.minDecibels = -85;
        vizAnalyser.maxDecibels = -25;
        vizFreq = new Uint8Array(vizAnalyser.frequencyBinCount);
        // Time-domain buffer for the waveform view (a fresh 0..255 sample per analyser tap).
        vizWave = new Uint8Array(vizAnalyser.fftSize);
        vizWaveSmooth = new Float32Array(vizWave.length);
        for (let i = 0; i < vizWaveSmooth.length; i++) vizWaveSmooth[i] = 0.5;
        srcNode.connect(vizAnalyser); // analysis tap only — do NOT route to destination
        vizLive = true;
        vizSetupState = 1;
        // A fresh tap = a fresh song: drop the live-confirmed flag so a silent new tap shows
        // nothing, and recompute the frequency weighting for the new context.
        vizLiveOK = false;
        vizTiltGain = null;
        resumeVizCtx();
        return true;
      } catch (e) {
        if (vizCtx !== null) { try { vizCtx.close(); } catch (e2) {} }
        vizCtx = null; vizAnalyser = null; vizFreq = null; vizWave = null; vizWaveSmooth = null; vizBandSmooth = null; vizBandFilter = null; vizScratchA = null; vizScratchB = null; vizBandPeak = null; vizBandGain = null; vizBandMean = null; vizEnvMin = null; vizEnvMax = null; vizEnvW = 0; vizFilterTime = null; vizLive = false; vizSetupState = 2;
        return false;
      }
    }
    function closeLiveViz() {
      let closing = null;
      if (vizCtx !== null) { try { closing = vizCtx.close(); } catch (e) {} }
      vizCtx = null; vizAnalyser = null; vizFreq = null; vizWave = null; vizWaveSmooth = null; vizBandSmooth = null; vizBandFilter = null; vizScratchA = null; vizScratchB = null; vizBandPeak = null; vizBandGain = null; vizBandMean = null; vizEnvMin = null; vizEnvMax = null; vizEnvW = 0; vizFilterTime = null; vizLive = false; vizSetupState = 0;
      vizCanvas2d = null; vizCanvas2dFor = null;
      // 返回 close 的 promise：采集管线的拆除是异步的，换 src 前必须等它完成
      //（见 playBookFrom——拆除进行中换 src 会让新加载器永远不发请求）。
      return closing || Promise.resolve();
    }
    // 等采集管线拆除落定后执行 fn。close() 在本环境的 Chromium 上可能永不落定
    // （与 getTopURL 同源的媒体栈怪癖），故最多等 150ms 就继续——拆除的后续落定
    // 无害（closeLiveViz 已同步清空全部状态），但绝不能让它阻塞讲书块的加载。
    function quiesceThen(fn) {
      Promise.race([closeLiveViz(), new Promise((res) => setTimeout(res, 150))]).then(() => { fn(); }, fn);
    }
    // Map AnalyserNode's per-bin byte data (dB→0..255) into the VIZ_BARS
    // log-spaced bands. Marks vizLiveOK once the tap actually yields signal.
    function analyseLiveBands() {
      if (!vizLive || vizAnalyser === null) return false;
      vizAnalyser.getByteFrequencyData(vizFreq);
      const binHz = vizCtx.sampleRate / vizAnalyser.fftSize;
      const maxF = Math.min(binHz * vizFreq.length, 18000);
      const ratio = maxF / 40;
      const g = liveTiltGain();
      let any = false;
      for (let b = 0; b < VIZ_BARS; b++) {
        const e0 = 40 * Math.pow(ratio, b / VIZ_BARS);
        const e1 = 40 * Math.pow(ratio, (b + 1) / VIZ_BARS);
        const b0 = Math.max(0, Math.floor(e0 / binHz));
        const b1 = Math.min(vizFreq.length, Math.max(b0 + 1, Math.ceil(e1 / binHz)));
        let m = 0;
        for (let k = b0; k < b1; k++) { const v = vizFreq[k]; if (v > m) m = v; }
        const raw = m / 255; // byte ∈ dB range → 0..1 (the standard AnalyserNode normalization)
        // Absolute loudness drives this bar (so a quiet passage stays low), but a fixed
        // frequency weighting flattens the bass-heavy shape so the low bands aren't pinned at
        // the top during loud music. See liveTiltGain().
        vizBands[b] = Math.min(1, raw * g[b]);
        if (m > 4) any = true; // above the (minDecibels floor) silence => real signal
      }
      if (any && !vizLiveOK) vizLiveOK = true;
      return true;
    }
    // 时域 2 阶 Butterworth 高通/低通 biquad（RBJ cookbook，Q=1/√2）。
    // 每频段用 2×HP(lo) + 2×LP(hi) 级联（8 阶）做带通。相比逐帧 FFT 分频，
    // 时域滤波是连续流式处理、没有窗函数——波形曲线在整个画布宽度上都保持
    // 真实振幅，不会像 Hann 窗那样把左右两端淡出到中线。
    function biquadHP(f0, fs) {
      const w0 = (2 * Math.PI * f0) / fs;
      const alpha = Math.sin(w0) / Math.SQRT2;
      const c = Math.cos(w0);
      const a0 = 1 + alpha;
      return { b0: (1 + c) / (2 * a0), b1: -(1 + c) / a0, b2: (1 + c) / (2 * a0), a1: (-2 * c) / a0, a2: (1 - alpha) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
    }
    function biquadLP(f0, fs) {
      const w0 = (2 * Math.PI * f0) / fs;
      const alpha = Math.sin(w0) / Math.SQRT2;
      const c = Math.cos(w0);
      const a0 = 1 + alpha;
      return { b0: (1 - c) / (2 * a0), b1: (1 - c) / a0, b2: (1 - c) / (2 * a0), a1: (-2 * c) / a0, a2: (1 - alpha) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
    }
    // 单步 Direct Form I biquad（就地推进滤波器状态，返回滤波后的样本值）。
    function stepBiquad(sec, x) {
      const y = sec.b0 * x + sec.b1 * sec.x1 + sec.b2 * sec.x2 - sec.a1 * sec.y1 - sec.a2 * sec.y2;
      sec.x2 = sec.x1; sec.x1 = x; sec.y2 = sec.y1; sec.y1 = y;
      return y;
    }
    // Read the analyser's time-domain samples into vizBandSmooth (normalized 0..1,
    // 0.5 = silent center) with light per-frame easing so the trace is stable.
    function analyseLiveWave() {
      if (!vizLive || vizAnalyser === null || vizWave === null) return false;
      if (typeof vizAnalyser.getByteTimeDomainData !== 'function') return false;
      vizAnalyser.getByteTimeDomainData(vizWave);
      // 分频段多线：把当前时域窗经每频段的时域带通（2×HP + 2×LP biquad）滤波，
      // 得到该频段的连续波形，每条线反映一段频率的起伏，形成层次感。时域滤波
      // 无窗函数，曲线两端保持真实振幅（不会像逐帧 FFT 分频那样把左右淡出）。
      const n = vizWave.length;
      if (vizBandSmooth === null || vizBandSmooth.length !== VIZ_WAVE_BANDS.length * n) {
        vizBandSmooth = new Float32Array(VIZ_WAVE_BANDS.length * n);
        const sampleRate0 = (vizCtx && vizCtx.sampleRate) || 48000;
        vizBandFilter = VIZ_WAVE_BANDS.map((band) => [
          biquadHP(band.lo, sampleRate0), biquadHP(band.lo, sampleRate0),
          biquadLP(band.hi, sampleRate0), biquadLP(band.hi, sampleRate0),
        ]);
        // 复用工作缓冲，避免每帧分配（60fps 下会很卡）。
        vizScratchA = new Float32Array(n);
        vizScratchB = new Float32Array(n);
        vizBandPeak = new Float32Array(VIZ_WAVE_BANDS.length);
        vizBandGain = new Float32Array(VIZ_WAVE_BANDS.length);
        vizBandMean = new Float32Array(VIZ_WAVE_BANDS.length);
        for (let i = 0; i < vizBandSmooth.length; i++) vizBandSmooth[i] = 0.5;
        for (let i = 0; i < vizBandMean.length; i++) vizBandMean[i] = 0.5;
        vizFilterTime = null;
      }
      // 时域路径的 tap 信号确认（与 analyseLiveBands 的 m>4 等价）：死 tap 只会给
      // 恒定 128（静音），任一样本偏离中心 >4 即视为真实信号。wave 模式不再调
      // analyseLiveBands，vizLiveOK 改由这里维护。
      if (!vizLiveOK) {
        for (let i = 0; i < n; i++) {
          const d = vizWave[i] >= 128 ? vizWave[i] - 128 : 128 - vizWave[i];
          if (d > 4) { vizLiveOK = true; break; }
        }
      }
      // 算出「自上次处理后新增的样本数」hop：只把缓冲末尾的新样本喂给滤波器。
      // 关键：若整窗都喂且滤波器状态跨帧保留，重叠区会被重复滤波、状态跑得比
      // 真实时间快 → 强低音会错误地在高频段激起（实测 100Hz → 中频 0.46）。
      // 只喂新增样本后每个样本恰好被滤波一次，得到真正连续的带通波形。
      const sr = (vizCtx && vizCtx.sampleRate) || 48000;
      const now = (vizCtx && vizCtx.currentTime) || 0;
      let hop;
      if (vizFilterTime === null) {
        hop = n; // 首帧：消费整个窗口
      } else {
        const dt = now - vizFilterTime;
        hop = (Number.isFinite(dt) && dt > 0) ? Math.max(1, Math.min(n, Math.round(dt * sr))) : n;
      }
      vizFilterTime = now;
      // 每段：把新增 hop 个样本逐级过该段带通（状态跨帧保留），滚动写入平滑缓冲。
      for (let bi = 0; bi < VIZ_WAVE_BANDS.length; bi++) {
        const sections = vizBandFilter[bi];
        const base = bi * n;
        // 滚动：旧数据左移 hop，为末尾的新样本腾出位置。
        if (hop < n) {
          for (let i = hop; i < n; i++) vizBandSmooth[base + i - hop] = vizBandSmooth[base + i];
        }
        // 逐级滤波新增样本（vizWave[n-hop, n)），滤波器状态跨帧保留。
        const bufA = vizScratchA; const bufB = vizScratchB;
        let cur = bufA; let nxt = bufB;
        for (let j = 0; j < hop; j++) cur[j] = stepBiquad(sections[0], vizWave[n - hop + j] - 128);
        for (let s = 1; s < sections.length; s++) {
          const sec = sections[s];
          for (let j = 0; j < hop; j++) nxt[j] = stepBiquad(sec, cur[j]);
          const tmp = cur; cur = nxt; nxt = tmp;
        }
        // cur[0..hop) 是该段的带通时域（通带增益 0dB，满幅 ≈ ±128）。直接写入：
        // 滚动缓冲本身提供帧间连续性，无需逐帧缓动——缓动会让最早写入的样本
        // 永远停在半幅、导致波形左端振幅被压低。
        for (let j = 0; j < hop; j++) {
          vizBandSmooth[base + n - hop + j] = 0.5 + cur[j] / 255;
        }
        // 自适应增益（安静感知）：取该段平滑波形的峰值偏差，经慢峰值（瞬时上升、
        // ~1s 缓落，vizBandPeak）得到响度参考，据此把大声段落归一为全幅（下限 1x，
        // 不压缩响度），安静段落放大到上限 VIZ_WAVE_GAIN 保持可见；缓落让响度
        // 变化（渐强/渐弱）仍能被看见。
        let bm = 0;
        for (let i = 0; i < n; i++) bm += vizBandSmooth[base + i];
        bm /= n;
        vizBandMean[bi] = bm; // 绘制侧直接复用（drawOneWave 免每帧重扫一遍求均值）
        let bp = 0;
        for (let i = 0; i < n; i++) { const d = Math.abs(vizBandSmooth[base + i] - bm); if (d > bp) bp = d; }
        const sp = Math.max(bp, vizBandPeak[bi] * VIZ_WAVE_PEAK_DECAY);
        vizBandPeak[bi] = sp;
        vizBandGain[bi] = Math.min(VIZ_WAVE_GAIN, Math.max(VIZ_WAVE_GAIN_MIN, VIZ_WAVE_PEAK_TARGET / Math.max(sp, 1e-3)));
      }
      // 单条回落波形（vizWaveSmooth）同样以 0.5 为中线、对称平滑；仅作降级回退用。
      // 分段缓冲已就绪时回退路径不可达（drawWaveform 走分频段多线），跳过缓动省
      // 每帧 2048 次无效运算。
      if (vizBandSmooth === null) {
        for (let i = 0; i < vizWave.length; i++) {
          // 用 256 作归一化基准：getByteTimeDomainData 的静音中心是 128，128/256 = 0.5
          // 正好是画布垂直中线，波形严格围绕中线上下对称（若用 /255 则中心落在 ~0.502，
          // 整条线会系统性偏上约 0.002*(h-1)）。
          const t = vizWave[i] / 256;
          const s = vizWaveSmooth[i];
          vizWaveSmooth[i] = s + (t - s) * 0.4;
        }
      }
      return true;
    }
    function drawBars(canvas, useCaps) {
      const c = vizGet2D(canvas);
      const w = canvas.width; const h = canvas.height;
      c.clearRect(0, 0, w, h);
      const gap = 2;
      const bw = 3; // fixed 3px bar width (12 bars fit the 60px bar without crowding)
      // Center the group of bars within the canvas.
      const x0 = Math.max(0, Math.round((w - (bw * VIZ_BARS + gap * (VIZ_BARS - 1))) / 2));
      const color = currentAccent();
      // 峰值帽用亮度自适应色（暗主题→提亮、浅主题→压暗），任何主题下都与柱体区分。
      const capColor = capColorFor(color);
      for (let i = 0; i < VIZ_BARS; i++) {
        const bh = Math.max(2, Math.round(smoothCur[i] * (h - 2)));
        const x = x0 + i * (bw + gap);
        c.fillStyle = color;
        c.fillRect(x, h - 1 - bh, Math.max(1, Math.floor(bw)), bh);
        if (useCaps && smoothPeak[i] > smoothCur[i] + 0.03) {
          const py = h - 1 - Math.round(smoothPeak[i] * (h - 2));
          c.fillStyle = capColor;
          c.fillRect(x, Math.max(0, py), Math.max(1, Math.floor(bw)), 3);
        }
      }
    }
    // Oscilloscope-style multi-line waveform: one continuous curve per frequency band
    // (see VIZ_WAVE_BANDS). Each band is drawn with its own opacity/width so the low band
    // reads as the main contour while mids/highs layer on top, vertically centered on the
    // canvas midline (0.5) to line up with the left-aligned track name.
    function drawWaveform(canvas) {
      if (vizWaveSmooth === null) { vizGet2D(canvas).clearRect(0, 0, canvas.width, canvas.height); return; }
      const c = vizGet2D(canvas);
      const w = canvas.width; const h = canvas.height;
      c.clearRect(0, 0, w, h);
      c.lineCap = 'round';
      c.lineJoin = 'round';
      const n = vizWaveSmooth.length;
      const bands = (vizBandSmooth !== null && vizBandSmooth.length === VIZ_WAVE_BANDS.length * n)
        ? VIZ_WAVE_BANDS : null;
      if (bands === null) {
        // 分段缓冲未就绪：退化为单条完整波形（仍围绕 DC 中心放大）。
        drawOneWave(c, w, h, n, vizWaveSmooth, 1.0, 1.5);
        return;
      }
      const color = currentAccent();
      for (let b = 0; b < bands.length; b++) {
        const src = vizBandSmooth.subarray(b * n, (b + 1) * n);
        // 用该频段的自适应增益（安静感知）替换固定放大：大声归一全幅、安静提亮，
        // 见 analyseLiveWave 的 vizBandGain。
        const gain = (vizBandGain !== null && vizBandGain.length === bands.length) ? vizBandGain[b] : VIZ_WAVE_GAIN;
        const mean = (vizBandMean !== null && vizBandMean.length === bands.length) ? vizBandMean[b] : undefined;
        drawOneWave(c, w, h, n, src, bands[b].alpha, bands[b].width, color, gain, mean);
      }
    }
    // Draw a single waveform curve from a normalized(0..1) sample buffer. The curve is
    // centered on its OWN mean so its vertical centroid always lands on the canvas midline
    // (0.5), regardless of any DC bias or content asymmetry — otherwise a non-symmetric
    // waveform (real vocals/rock) would sit visibly toward the top or bottom.
    //
    // 绘制前按像素列做 min/max 包络降采样：画布只有 ~60px 宽，逐点画 n=2048 的折线
    // 点间距仅 ~0.03px（~30 倍超采样），抗锯齿描边是波形模式的主要绘制开销。每列
    // 只取最大/最小偏差各 1 点（峰值保留 → 与全点绘制视觉无差），描边顶点数从
    // 3×2048 降到 3×2×w（~94%↓）。分析路径已算出均值时直接复用（mean 参数）。
    function drawOneWave(c, w, h, n, samples, alpha, width, color, gain, mean) {
      const col = color || currentAccent();
      // gain：该频段的自适应增益（默认固定放大 VIZ_WAVE_GAIN）。
      const g = (typeof gain === 'number' && Number.isFinite(gain) && gain > 0) ? gain : VIZ_WAVE_GAIN;
      // 用 globalAlpha 分层，让低频主轮廓实、中高频半透明叠加。
      c.globalAlpha = alpha;
      c.strokeStyle = col;
      c.lineWidth = width;
      // 求本条波形自身的均值，作为竖直居中轴（强制质心落在画布中线 0.5）。
      let mu = mean;
      if (typeof mu !== 'number' || !Number.isFinite(mu)) {
        mu = 0;
        for (let i = 0; i < n; i++) mu += samples[i];
        mu /= n;
      }
      // 逐列聚合 min/max 偏差（相对均值）。缓冲按列数复用，宽度变化才重建。
      const cols = Math.max(1, Math.min(w, n));
      if (vizEnvW !== cols || vizEnvMin === null || vizEnvMax === null) {
        vizEnvMin = new Float32Array(cols);
        vizEnvMax = new Float32Array(cols);
        vizEnvW = cols;
      }
      vizEnvMin.fill(Infinity);
      vizEnvMax.fill(-Infinity);
      for (let i = 0; i < n; i++) {
        const ci = Math.min(cols - 1, Math.floor((i * cols) / n));
        const d = samples[i] - mu;
        if (d < vizEnvMin[ci]) vizEnvMin[ci] = d;
        if (d > vizEnvMax[ci]) vizEnvMax[ci] = d;
      }
      c.beginPath();
      // min/max 之字形：每列先 max 后 min（列内竖直连线），相邻列首尾相接，
      // 形成与全点折线等观的连续包络。y 用 +0.5 把中心精确对齐到画布视觉正中
      // h/2（20px 画布的 y=10）：直接用 (1-norm)*(h-1) 会把中心落在 9.5，
      // 整整偏上 0.5px，直线/波形都会看起来没垂直居中。
      let started = false;
      for (let ci = 0; ci < cols; ci++) {
        const lo = vizEnvMin[ci]; const hi = vizEnvMax[ci];
        if (!(lo <= hi)) continue; // 空列（理论上不发生，防御 NaN/Inf）
        const x = ((ci + 0.5) / cols) * w;
        const yHi = (1 - (0.5 + hi * g)) * (h - 1) + 0.5;
        const yLo = (1 - (0.5 + lo * g)) * (h - 1) + 0.5;
        if (!started) { c.moveTo(x, yHi); started = true; } else { c.lineTo(x, yHi); }
        c.lineTo(x, yLo);
      }
      c.stroke();
      c.globalAlpha = 1;
    }
    function drawViz() {
      if (barCanvasNode === null) return;
      const canvas = barCanvasNode;
      const w = canvas.width; const h = canvas.height;
      // 暂停/无 tap 时只清画布，不做任何 DSP——对静音做 FFT/时域读取 + 3 频段
      // biquad 滤波（vizCtx.currentTime 暂停时照走，hop 每帧 ~800 样本）都是无效功。
      // vizLiveOK 的确认因此发生在播放首帧，不影响显示（未确认本来就不画）。
      if (!vizLive || vizAnalyser === null || !store.playing) {
        vizGet2D(canvas).clearRect(0, 0, w, h);
        return;
      }
      // 模式互斥读取：wave 只走时域（biquad 分频段），bars 只走频域（对数分段）——
      // 另一条路径的读取+映射对当前显示是纯开销。vizLiveOK 由各自路径确认
      // （bars：analyseLiveBands 内频段能量 m>4；wave：analyseLiveWave 内 |x-128|>4）。
      const waveMode = store.vizMode === 'wave';
      const analysed = waveMode ? analyseLiveWave() : analyseLiveBands();
      // 失败/未确认信号 -> 直接不显示（无离线回退）。仅当实时路径确认在出信号
      // 且正在播放时才画，否则清空画布。
      if (!analysed || !vizLiveOK) { vizGet2D(canvas).clearRect(0, 0, w, h); return; }
      if (waveMode) {
        drawWaveform(canvas);
        return;
      }
      // bars（柱状图）：只由实时频域能量驱动。
      for (let i = 0; i < VIZ_BARS; i++) targetBuf[i] = vizBands[i];
      for (let i = 0; i < VIZ_BARS; i++) {
        const t = targetBuf[i];
        // 柱体保持对音乐的快速响应（上升 0.6、回落 0.1）；「渐落」由峰值帽承担：
        // 峰值帽以 PEAK_DECAY 线性缓慢落下，形成经典频谱的拖尾渐落观感。
        if (t > smoothCur[i]) smoothCur[i] += (t - smoothCur[i]) * 0.6;
        else smoothCur[i] += (t - smoothCur[i]) * 0.1;
        if (t > smoothPeak[i]) smoothPeak[i] = t;
        else smoothPeak[i] -= PEAK_DECAY;
        if (smoothPeak[i] < 0) smoothPeak[i] = 0;
      }
      drawBars(canvas, true);
    }
    let rafRunning = false;
    function startRaf() {
      if (rafRunning) return;
      rafRunning = true;
      const tick = () => { if (!rafRunning) return; rafId = requestAnimationFrame(tick); drawViz(); karaokeFrame(); };
      tick();
    }
    function stopRaf() {
      rafRunning = false;
      if (rafId !== null) cancelAnimationFrame(rafId);
    }

    // ---- player actions ----
    // Shuffle playback uses a pre-shuffled queue with a position pointer so
    // "next" plays an unplayed track and "prev" returns to the previously
    // played one, instead of random-without-repeat or list-order neighbors.
    let shuffleQueue = [];
    let shufflePos = -1;
    let shuffleScopeKey = null;
    // 在线 QQ 队列连续失败的跳过次数：某首歌因版权下架/拿不到地址而触发
    // <audio> error 时自动跳到下一首；连续跳过次数达到队列长度（整列都试过）
    // 即停止报错——且停止后不再 step，杜绝无限循环跳歌。成功播放(onPlay)清零。
    let qqErrorSkipCount = 0;
    function buildShuffleQueue(anchorId) {
      const ids = activeIds();
      // Fisher-Yates
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp;
      }
      const a = anchorId !== undefined ? anchorId : store.currentId;
      if (a !== null && ids.includes(a)) {
        const ai = ids.indexOf(a);
        if (ai !== 0) { ids.splice(ai, 1); ids.unshift(a); }
      }
      shuffleQueue = ids;
      shuffleScopeKey = scopeKey();
      shufflePos = a !== null && ids[0] === a ? 0 : -1;
    }
    // 确保乱序队列与当前范围一致（范围切换后自动重建）。
    function ensureShuffleReady() {
      if (store.mode !== 'shuffle') return;
      const ids = activeIds();
      if (shuffleScopeKey !== scopeKey() || shuffleQueue.length !== ids.length
        || (store.currentId !== null && !shuffleQueue.includes(store.currentId))) {
        buildShuffleQueue(store.currentId);
      }
      if (store.currentId !== null) shufflePos = shuffleQueue.indexOf(store.currentId);
    }
    function syncShufflePos() {
      if (store.mode !== 'shuffle') return;
      ensureShuffleReady();
    }
    // play() 的失败原因五花八门：AbortError（被 pause()/load()/切歌中断）、
    // “interrupted by ...”等都不是自动播放被拦截。这里**反向判断**：只有错误
    // 明确是自动播放被拦截（NotAllowedError，或 Chromium 的 not-allowed 文案）才
    // 提示“浏览器拦截了自动播放”。这样双击/连点/快速切歌产生的中断一律不会误报
    // （本环境里中断错误未必是标准 AbortError，只过滤 AbortError 会漏网）。
    function isAutoplayBlocked(err) {
      try {
        if (!err) return false;
        const n = String(err.name || '');
        const m = String((err && err.message) || '');
        if (n === 'NotAllowedError') return true;
        return /not allowed|autoplay|user (gesture|interaction|activation)|didn'?t interact|play\(\) failed/i.test(m);
      } catch (e) { return false; }
    }
    // 播放被主动中断（pause/stop/切歌）：用于抑制“播放失败”这类误导提示。
    function isPlayAborted(err) {
      try {
        return !!err && (err.name === 'AbortError' || /abort|interrupted/i.test(String((err && err.message) || '')));
      } catch (e) { return false; }
    }
    // 最近一次点击启动曲目的时刻。双击的第二次点击会落在已激活的行上；部分
    // 浏览器/环境里那次点击的 detail 仍为 1，仅靠 detail>=2 判断不可靠，这里用
    // 时间窗兜底：刚（600ms 内）通过点击启动的曲目被再次点击，一律视为双击的
    // 第二次点击而忽略，避免把它当成“再点一次=暂停/重播”并触发上面的误报。
    let lastPlayStartTs = 0;
    function shouldIgnoreRowClick(e, isActive) {
      if (e && e.detail >= 2) return true;
      if (isActive && Date.now() - lastPlayStartTs < 600) return true;
      return false;
    }
    function startPlay(id) {
      const track = resolvePlayable(id);
      if (track === null) return;
      lastPlayStartTs = Date.now();
      restoredMusicPos = null;
      bookRestorePos = -1;
      // A fresh track gets a fresh live tap: the captureStream tap is tied to the
      // media pipeline of the src it was created on, so switching songs must tear it
      // down and let the 'playing' event re-capture for the NEW src (otherwise the tap
      // reads the old song's silence and we'd wrongly fall back to offline).
      closeLiveViz();
      audio.src = track.url;
      audio.load();
      // (Re)attempt the live spectrum tap now that a real src is loaded — the captured
      // MediaStream only carries an audio track once the element has a source.
      setupLiveViz();
      // A fresh track always starts from 0 (audio.src/load resets currentTime) —
      // reset the readout so a stale restored position (from the previous song)
      // never lingers on the bar before the first timeupdate.
      set({ currentId: id, currentName: track.name, currentArtists: track.artists || [], pendingId: null, pendingName: null, error: null, tocOpen: false, currentSection: '', qqFaved: false, kgFaved: false, currentQuality: (track && track.quality) || '', bookProgress: 0, position: 0, duration: 0 });
      syncShufflePos();
      loadLyricForTrack(id);
      savePlayback();
      // 在线曲目：判断当前曲目是否已收藏到「我喜欢」，点亮爱心；并补发轻量 HEAD
      // 探测「真实品质」（startPlay 是切歌/自动续播的通用路径，不走 startQQPlayback，
      // 必须在这里也触发一次，否则下一首的标签不会出现）。
      if (String(id).startsWith('qq:')) {
        checkQQFavForCurrent();
        loadQQQuality(String(id).slice(3), track.url);
      }
      // 酷狗同理：startPlay 是切歌/自动续播/上下曲的通用路径，不走 startKGPlayback，
      // 必须在这里也补一次轻量 HEAD 探测「真实品质」，否则自动切到下一首/上下曲时
      // 音质徽章只显示「酷狗音乐」、不显示 无损/高音质/标准。
      if (String(id).startsWith('kg:')) {
        checkKGFavForCurrent(); // 点亮酷狗「我喜欢」爱心
        loadKGQuality(String(id).slice(3), track.url);
      }
      const promise = audio.play();
      if (promise !== undefined && typeof promise.catch === 'function') {
        promise.catch((err) => {
          if (!isAutoplayBlocked(err)) return;
          set({ error: '浏览器拦截了自动播放，请点击一次播放按钮', pendingId: id, pendingName: track.name });
        });
      }
    }
    // ---- 每日新闻播报：期次数据 + 「虚拟书」桥接 ----
    // 新闻期次不复制讲书的播放管线（blob 回退/看门狗/字幕/进度…约 600 行），而是把
    // 期次包装成一本「虚拟书」接入既有管线：bookById 能解析期次 → playBookFrom/
    // 字幕（/text?from=）/进度（charOffsets）/预加载/续播/声音切换/ ended 自动下一块
    // 全部原样继承，仅 URL 前缀换成 /dsh-music/news/。meta 的 sections 即类别
    // （heading=类别名、fromChunk=类别起始块），因此 📖 目录与「上/下一类」也免费。
    let newsEditions = []; // 期次列表（GET /dsh-music/news 的摘要行）
    // 与 Host 端 news-core.js 对齐的常量（客户端只需要 UI 用到的上限与预设类别）。
    const PRESET_CATEGORIES = ['热点', '国内', '国际', '科技', '财经', '体育', '娱乐'];
    const LIMITS_NEWS = {
      topicsPerShift: 5, shifts: 6,
      itemCountMin: 1, itemCountMax: 20, itemCountDefault: 8, // 定时任务新闻条数
    };
    async function loadNewsEditions() {
      try {
        const r = await fetch('/dsh-music/news', { cache: 'no-store' });
        if (!r.ok) return newsEditions;
        const data = await r.json();
        if (data && Array.isArray(data.editions)) {
          newsEditions = data.editions;
          set({ newsEditions });
        }
      } catch { /* 网络失败保留旧列表 */ }
      return newsEditions;
    }
    const newsById = (id) => newsEditions.find((e) => e.id === id) || null;
    // 期次 → 虚拟书：name=期次标题（播放条主文案）、url=新闻路由（?from/&voice 兼容）。
    const newsBookById = (id) => {
      const e = newsById(id);
      return e === null ? null : { id: e.id, name: e.title, url: '/dsh-music/news/' + e.id, path: '', isNews: true };
    };
    const markNewsPlayed = (id) => {
      fetch('/dsh-music/news/played', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
      }).then(() => { const e = newsById(id); if (e && !e.played) { e.played = true; set({ newsEditions: [...newsEditions] }); } })
        .catch(() => {});
    };
    // 从新闻期次某块起播（条目跳播/类别跳播/整期播放都归到这里）。
    function playNewsFrom(id, from) {
      void loadNewsEditions().then((list) => {
        if (!list.some((e) => e.id === id)) return;
        markNewsPlayed(id);
        playBook(id, from || 0);
      });
    }
    const bookById = (id) => (store.books || []).find((b) => b.id === id) || newsBookById(id) || null;
    const currentBookId = () => (store.currentId !== null && String(store.currentId).startsWith('book:'))
      ? String(store.currentId).slice('book:'.length)
      : null;
    // Re-synthesize / replay the current chunk after an error.
    function retryBook() {
      const id = currentBookId();
      if (id !== null) {
        unlockAutoplay();
        bookAutoRetried = false; // manual retry resets the auto-retry budget
        set({ bookError: '', bookBuffering: true, bookBufferingSince: Date.now() });
        playBookFrom(id, bookFromRef, false);
      }
    }
    // Double-buffered preload: while chunk N plays we synthesize chunk N+1 in
    // the background, so onEnded can start the next chunk with zero network wait.
    // Chunk bounds come from a /meta call (total), not a custom response header —
    // some HTTP layers strip custom headers, which would otherwise make a book
    // stop after the first chunk.
    // Book playback streams each chunk over HTTP directly into <audio> (no blob
    // URLs — those tripped a browser "getTopURL" TypeError in this environment).
    // A hidden companion <audio> warms the next chunk so the switch is near-instant.
    let bookTotal = -1;    // total chunks of the current book (-1 = unknown)
    let bookFromRef = 0;   // current chunk index being played
    // Monotonic token so only the LATEST voice switch applies (a slow synthesis
    // for an older selection must not override a newer one).
    let voiceSwitchSeq = 0;
    let bookBufferedFrom = -1; // chunk index already buffered in preAudio
    let bookBaseTime = 0;  // cumulative seconds of all completed chunks (for a
                           // continuous book-wide time readout that never resets)
    let bookStuckTimer = null; // single synthesis-timeout guard (see playBookFrom)
    // 解楔看门狗：从「正在播放的在线音乐流」直接切到慢 TTFB 的讲书块（冷合成，
    // 首字节要等数秒~数十秒）时，该环境的媒体流水线可能楔死——无声音、不派发
    // error/timeupdate、pause/play 均无效，只有下一次换 src（如点下一章节）才恢复。
    // 一次显式重新 load()（+play）即可解除：服务端在途合成有去重（ttsAudioInflight），
    // 重发请求只是重新挂到同一个合成上，正常等合成的场景下也无副作用。
    let bookUnwedgeTimer = null;
    // 看门狗 blob 播放的 object URL（换新/停止时 revoke）。
    let bookBlobUrl = null;
    // 看门狗重新 load() 的时刻：它会 AbortError 掉旧的 play promise，两处 play 的
    // catch 据此识别「自家看门狗的中断」，保持「AI 合成中」提示不被误清。
    let bookUnwedgeReloadAt = 0;
    const clearBookUnwedge = () => { if (bookUnwedgeTimer !== null) { clearTimeout(bookUnwedgeTimer); bookUnwedgeTimer = null; } };
    function armBookUnwedge(id, from) {
      clearBookUnwedge();
      bookUnwedgeTimer = setTimeout(() => {
        bookUnwedgeTimer = null;
        if (!store.bookBuffering || store.playing) { return; }
        // 主元素的媒体加载器在本环境可能压根不发请求（rs0/net2、tts-logs 无该请求的
        // arrive——预热 fetch 与 preAudio 的请求都正常到达）。因此 10s 仍 rs0 时不再
        // 依赖元素加载器：直接 fetch 回字节、用 Blob URL 播放（fetch 路径实测可达）。
        // blob src 完整支持 currentTime/seek/ended/字幕；讲书块 ≤几 MB 完全可行。
        fetch(bookUrl(id, from), { cache: 'no-store' }).then((r) => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.blob();
        }).then((blob) => {
          if (!store.bookBuffering || store.playing) return; // 等待期间已恢复 → 丢弃
          if (bookBlobUrl !== null) { try { URL.revokeObjectURL(bookBlobUrl); } catch (e) {} }
          bookBlobUrl = URL.createObjectURL(blob);
          bookUnwedgeReloadAt = Date.now();
          try { audio.src = bookBlobUrl; audio.load(); } catch (e) {}
          const p = audio.play();
          if (p !== undefined && typeof p.then === 'function') {
            p.then(() => {
              if (bookStuckTimer !== null) { clearTimeout(bookStuckTimer); bookStuckTimer = null; }
              set({ bookBuffering: false, bookBufferingSilent: false, bookBufferingSince: 0, bookError: '' });
            }).catch(() => {});
          }
        }).catch(() => {
          // blob 路径也失败（如服务端 500 已由 onError 处理）→ 退回换 URL 直接重载。
          bookAudioBust += 1;
          const url = bookUrl(id, from);
          if (url === null) return;
          bookUnwedgeReloadAt = Date.now();
          try { audio.src = url; audio.load(); } catch (e) {}
          const p = audio.play();
          if (p !== undefined && typeof p.catch === 'function') p.catch(() => {});
        });
      }, 10000);
    }
    const revokeBookBlob = () => {
      if (bookBlobUrl !== null) { try { URL.revokeObjectURL(bookBlobUrl); } catch (e) {} bookBlobUrl = null; }
    };
    // 「字节就绪即接管」兜底：与元素加载并行 fetch 同一块。合成完成（fetch resolve，
    // 字节在手）后给元素 1.5s 宽限；届时仍未起播（rs0——本环境媒体加载器对讲书
    // 音频不可靠：请求可能迟到数秒、字节送达后也不消费）就直接用这份字节 Blob
    // 播放，不再等 10s 看门狗。元素先起播则整个兜底静默丢弃（seq 失配/状态检查）。
    let bookPlaySeq = 0;
    let bookGraceTimer = null;
    const clearBookGrace = () => { if (bookGraceTimer !== null) { clearTimeout(bookGraceTimer); bookGraceTimer = null; } };
    // 同一块只武装一次：连点/反复点击不得清除或重置宽限计时——否则 Blob 接管永远
    // 差 1.5s 触发不了（实测「点了好几次都不行」的直接原因之一）。
    let bookFallbackFor = '';
    // 元素「真的在出声」的信号：onTime（timeupdate）只在音频实际推进时触发。
    // store.playing 不行——play() 一调用它就变 true（只是播放意图），缓冲期恒为
    // true，会把 Blob 接管永远挡在门外（实测「音乐→小说冷启动卡死」的根因）。
    let bookElementProgressed = false;
    // Blob 通道赢过一次后，同书后续切块直接走 Blob（元素加载器对讲书不可靠）。
    let bookUseBlob = false;
    // 定位钉 seek 的一次性标记 + 尝试时刻（本环境元素对 WAV seek 可能不生效）。
    let bookPinSeekTried = false;
    let bookPinSeekAt = 0;
    function armBookBlobFallback(id, from, onStarted, onFail) {
      const key = id + ':' + from;
      if (bookFallbackFor === key) { return; }
      bookFallbackFor = key;
      const seq = ++bookPlaySeq;
      const url = bookUrl(id, from);
      if (url === null) return;
      const fT0 = Date.now();
      fetch(url, { cache: 'no-store' }).then(async (r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        // 非常规响应（测试桩等没有 blob 方法）→ 无法 Blob 播放，静默跳过不报错。
        if (typeof r.blob !== 'function') return null;
        return r.blob();
      }).then((blob) => {
        if (seq !== bookPlaySeq || blob === null) return;
        clearBookGrace();
        // Blob 赢过一次 → 元素路径基本没戏，宽限缩到 100ms（切块间隙最小化）。
        const grace = bookUseBlob ? 100 : 1500;
        bookGraceTimer = setTimeout(() => {
          bookGraceTimer = null;
          if (seq !== bookPlaySeq) { return; }
          // 只认真实进度信号（timeupdate 出现过）。store.playing 在缓冲期恒为 true
          //（play() 一调用它就变 true，只是播放意图）；readyState≥1 只代表元数据
          // 就绪——都不能证明真的在出声。
          if (bookElementProgressed) { return; }
          if (!store.bookBuffering) { return; }
          if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
          revokeBookBlob();
          bookBlobUrl = URL.createObjectURL(blob);
          bookUseBlob = true;
          bookRestorePos = -1; // 兜底接管后从块头播（本环境 seek 不可靠，避免 blob 上重复 seek）
          bookUnwedgeReloadAt = Date.now(); // 让 play promise 的 catch 识别自家切换
          try { audio.src = bookBlobUrl; audio.load(); } catch (e) { return; }
          const p = audio.play();
          if (p !== undefined && typeof p.then === 'function') {
            p.then(() => { onStarted(); }).catch((e) => {
              // 不再静默：把拒绝原因亮出来（NotAllowed=自动播放策略 / Abort=被打断 /
              // NotSupported=解码失败），下一轮排查不用猜。
              const name = (e && e.name) || '未知';
              const msg = String((e && e.message) || e || '').slice(0, 100);
              set({ bookError: 'Blob 播放被拒（' + name + '）：' + msg + ' —— 请点 ▶ 重试' });
            });
          }
        }, grace);
      }).catch((e) => {
        if (seq !== bookPlaySeq) return;
        if (onFail) onFail(String((e && e.message) || e));
      });
    }
    // 60s 合成超时时的服务端探测：用 fetch（no-store，绕过一切缓存）直接拉同一个
    // 块，把 HTTP 状态/耗时/字节数写进错误提示。元素 rs0/net2 卡死时，这个读数
    // 能一锤定音：fetch 很快且字节正常 → 数据在、媒体层没收到（浏览器侧）；
    // fetch 也挂起/报错 → Host/合成层问题。
    function bookStuckProbe(id, from) {
      const t0 = Date.now();
      const url = bookUrl(id, from);
      if (url === null) return;
      fetch(url, { cache: 'no-store' }).then((r) => {
        return r.arrayBuffer().then((b) => {
          if (!store.bookError) return; // 已恢复播放/已切走 → 丢弃过期探测
          const ms = Date.now() - t0;
          const tag = b.byteLength > 44 ? '' : '（异常小：只有头或空）';
          set({ bookError: 'AI 合成超时（元素 rs0 未收到音频数据）。服务端探测：HTTP ' + r.status + '，' + ms + 'ms，' + b.byteLength + 'B' + tag + '。可点「重试」，或查看 /dsh-music/tts-logs' });
        });
      }).catch((e) => {
        if (!store.bookError) return;
        set({ bookError: 'AI 合成超时（元素 rs0 未收到音频数据）。服务端探测失败：' + String((e && e.message) || e) });
      });
    }
    let lastPosSaveAt = 0;     // throttle for the periodic playback-state save
    // 单块时长上限：分块是 ≤150 字的散文，实测全书块长 10~36 秒，极端慢读也不
    // 会超过 2 分钟。若浏览器报的 duration 远超此值，说明该块 WAV 异常（截断/
    // 字节率错误导致时长虚高）——否则 <audio> 会「播静音」直到虚高时长走完。
    // 注意：这只是兜底。命中时仅静音重试一次；重试后仍超长则正常播放、不报错
    // （万一真是极慢的真实长块也不会被误杀）。主防御在 Host 的 WAV 头/静音校验。
    const BOOK_MAX_CHUNK_SEC = 180;
    let restoredMusicPos = null; // restored music position to display until the audio truly reaches it
    let newsResume = null; // 新闻打断快照：{ newsId, kind, id? }（新闻播完自动切回原内容；null=无快照）
    let bookRestorePos = -1;   // restored book's in-chunk position, seeked on play
    // 刚发生过 ended→切块：其后到达的重复 ended 属于旧块陈旧事件（吞掉）；
    // 下一块真正开始播放（play promise 兑现）或用户主动重播/停止时清除。
    let bookJustAdvanced = false;
    // 当前块是否已自动重试过一次（瞬时 LLM 合成失败时先静音重试一次，
    // 只有重试仍失败才弹错误 + 手动重试）。成功播放后复位。
    let bookAutoRetried = false;
    const preAudio = new Audio();
    preAudio.preload = 'auto';
    // 讲书音频 URL 的「每次页面加载唯一令牌」：讲书响应带 Cache-Control:public,
    // max-age=3600，历史版本（预热 fetch 默认缓存模式且从不读取 body）可能把残缺
    // 条目写进浏览器 HTTP 缓存——之后同一 URL 的媒体请求会命中毒条目并永久卡死
    // （无声音、无 error、pause/play 无效；换一个块=换 URL 则正常）。令牌让每次
    // 页面加载都用全新 URL，彻底绕开一切历史条目；同会话内元素/preAudio/预热共享
    // 同一 URL，双缓冲预加载与服务端合成去重（服务端 key 不含 bt）不受影响。
    // bookAudioBust：会话内自愈升级（解楔看门狗重试时 +1），连会话内的可疑条目
    // （如传输中途被中止的响应）也能绕开。
    let bookAudioBust = 0;
    const BOOK_AUDIO_TOKEN = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const bookUrl = (id, from) => {
      const b = bookById(id);
      if (b === null) return null;
      // The chosen TTS voice rides the URL so the host re-synthesizes with it.
      // Only send voices we know (stale persisted voice selections are dropped;
      // the host then falls back to its default 白桦).
      const known = (store.voices && store.voices.length > 0) ? store.voices : FALLBACK_VOICES;
      const v = store.voice && known.some((x) => x.id === store.voice) ? '&voice=' + encodeURIComponent(store.voice) : '';
      // marker（warm/pre）：请求来源标记，仅供 tts-logs 的 book-arrive 归属排查，
      // Host 忽略之。主元素的加载 URL 不带 marker。
      return b.url + '?from=' + from + v + '&bt=' + BOOK_AUDIO_TOKEN + (bookAudioBust > 0 ? 'r' + bookAudioBust : '');
    };
    // ---- book meta (total chunks + chapter structure) ----
    // /meta now returns { total, title, author, sections } where sections carry a
    // fromChunk per section for the chapter table of contents. Cached per book id
    // (the content never changes within a session, and the synthesis already
    // de-dupes repeat chunks).
    const bookMetaCache = new Map();
    async function ensureBookMeta(id) {
      const hit = bookMetaCache.get(id);
      if (hit !== undefined) return hit;
      const book = bookById(id);
      if (book === null) return null;
      let meta = null;
      try {
        const r = await fetch(book.url + '/meta', { cache: 'no-store' });
        if (r.ok) {
          const m = await r.json();
          meta = {
            total: m && typeof m.total === 'number' ? m.total : -1,
            title: (m && m.title) || '',
            author: (m && m.author) || '',
            sections: (m && Array.isArray(m.sections)) ? m.sections : [],
            // 逐块累积字符偏移 + 全书总字符：用于「已读字符/全书字符」的实时进度。
            // 旧 Host 没有这俩字段时优雅降级（进度条保持 0/不显示），不影响其它功能。
            charOffsets: (m && Array.isArray(m.charOffsets) && m.charOffsets.length > 1) ? m.charOffsets : [],
            totalChars: m && typeof m.totalChars === 'number' && m.totalChars > 0 ? m.totalChars : -1,
          };
          bookMetaCache.set(id, meta);
        }
      } catch {}
      return meta;
    }
    async function ensureBookTotal(id) {
      if (bookTotal >= 0) return bookTotal;
      const meta = await ensureBookMeta(id);
      if (meta !== null && meta.total >= 0) bookTotal = meta.total;
      return bookTotal;
    }
    // Label a section type for display in the toc (chapter/分部/前言/后记/分节).
    const sectionTypeLabel = (t) => ({
      chapter: '章节', part: '分部', preface: '前言',
      epilogue: '后记', named: '分节', toc: '目录', category: '类别',
    })[t] || '正文';
    // Heading of the section that contains the given chunk index.
    function sectionForChunk(sections, chunk) {
      if (!Array.isArray(sections) || sections.length === 0) return '';
      let cur = sections[0];
      for (const s of sections) { if (s.fromChunk <= chunk) cur = s; else break; }
      return cur.heading || '';
    }
    // Populate the toc (sections) for the current book; used when a book starts
    // playing and when the toc popup opens.
    async function ensureBookToc(id) {
      const meta = await ensureBookMeta(id);
      if (meta !== null) set({ bookToc: meta.sections || [] });
      return meta;
    }
    function openToc() {
      const id = currentBookId();
      if (id === null) return;
      set({ tocOpen: true });
      void ensureBookToc(id).then((meta) => {
        if (meta === null) return;
        set({ tocOpen: true, bookToc: meta.sections || [] });
      });
    }
    function closeToc() { set({ tocOpen: false }); }
    // Open/close the playback panel. The visible tab is decided purely by the
    // current playback mode: a playing novel shows the 小说 list, anything else
    // (music or idle) shows the 音乐 list. No tab memory is kept.
    function togglePanel() {
      const opening = !store.panelOpen;
      if (opening) {
        const cid = store.currentId;
        const isBook = cid !== null && String(cid).startsWith('book:');
        const isQQ = cid !== null && String(cid).startsWith('qq:');
        const isKG = cid !== null && String(cid).startsWith('kg:');
        // 新闻播报：期次以「虚拟书」形态播放（currentId = book:news-…），回面板时
        // 打开「新闻播报」页签而非 AI 讲书。
        const isNews = isBook && currentBookId() !== null && String(currentBookId()).startsWith('news-');
        // 在线曲目：点播放条上的播放列表按钮 → 打开对应在线 tab（并恢复上次所在层）。
        set({ tab: isNews ? 'news' : (isBook ? 'book' : (isQQ ? 'qq' : (isKG ? 'kg' : 'music'))) });
      }
      set({ panelOpen: opening });
    }
    // Warm the next chunk in the hidden preAudio (same-origin HTTP -> browser cache).
    function preloadBook(id, from) {
      const url = bookUrl(id, from);
      if (url === null) return;
      // audio.src reports the resolved absolute URL, so compare like-for-like
      // (the old `preAudio.src === url` never matched and re-fired the load).
      if (preAudio.src === new URL(url, window.location.href).href) return; // already preloaded
      preAudio.src = url;
      preAudio.load();
      bookBufferedFrom = from;
    }
    async function playBookFrom(id, from, silent) {
      const book = bookById(id);
      if (book === null) return;
      // 从正在播放的流（QQ音乐/酷狗/上一块讲书）切换时，先显式退出播放态再换 src：
      // 「播放中 + captureStream 采流」的元素直接 load 一个慢 TTFB 的讲书块（冷合成
      // 首字节要等数秒~数十秒）会楔死媒体流水线——不响、不报错、无 timeupdate、
      // pause/play 全部无效（closeLiveViz 只拆分析探针，不解除元素的播放态）。
      // pause 必须在 set({currentId}) 之前：onPause 会按当时的 currentId 保存进度。
      if (!audio.paused) { try { audio.pause(); } catch (e) {} }
      // 用户点击/跳章启动小说同样刷新双击时间窗（与音乐 startPlay 对齐），
      // 保证 detail 不可靠的环境里双击小说的第二次点击也能被忽略。
      lastPlayStartTs = Date.now();
      restoredMusicPos = null;
      const wasFresh = from === 0;
      // `silent` is set for the hidden ended→next auto-advance: the switch is
      // near-instant (server-side synthesis cache) so we don't flash a spinner
      // at every chunk boundary. Only user-initiated plays show it.
      const showBuffer = !silent;
      set({ currentId: 'book:' + id, currentName: book.name, currentArtists: [], pendingId: null, pendingName: null, error: null, currentSection: '', bookToc: [], currentQuality: '', bookProgress: 0, scope: { kind: 'book' } });
      // Load the chapter structure for the toc + the current-section label (the
      // current section is derived from the chunk index once the meta arrives).
      const startFrom = from;
      void ensureBookToc(id).then((meta) => {
        if (meta !== null && meta.sections.length > 0) {
          set({ currentSection: sectionForChunk(meta.sections, startFrom) });
        }
      });
      set(wasFresh
        ? { bookBuffering: true, bookBufferingSilent: !showBuffer, bookError: '', bookBufferingSince: Date.now() }
        : { bookBuffering: true, bookBufferingSilent: !showBuffer, bookBufferingSince: Date.now() });
      // Client-side guard so a hung synthesis can never leave the bar on
      // "合成中…" forever (the host also aborts its own request at 60s). A
      // single shared timer means a retry never inherits a stale timeout.
      if (bookStuckTimer !== null) clearTimeout(bookStuckTimer);
      bookStuckTimer = setTimeout(() => {
        if (store.bookBuffering) { set({ bookBuffering: false, bookBufferingSilent: false, bookBufferingSince: 0, bookError: 'AI 合成超时，请点击「重试」' }); bookStuckProbe(id, from); }
      }, 60000);
      armBookUnwedge(id, from);
      const doneBuffering = () => { clearBookUnwedge(); clearBookGrace(); set({ bookBuffering: false, bookBufferingSilent: false, bookBufferingSince: 0 }); };
      const failBook = (message) => { clearBookUnwedge(); clearBookGrace(); set({ bookBuffering: false, bookBufferingSilent: false, bookBufferingSince: 0, bookError: message || '讲书音频获取失败，请重试' }); };
      const clearStuck = () => { clearBookUnwedge(); clearBookGrace(); if (bookStuckTimer !== null) { clearTimeout(bookStuckTimer); bookStuckTimer = null; } };
      try {
        const url = bookUrl(id, from);
        if (url === null) { clearStuck(); failBook('书籍信息缺失'); return; }
        bookFromRef = from;
        // 先拆除实时频谱探针（captureStream 采集）——但拆除必须「真正完成」才能换
        // src：AudioContext.close() 是异步的，采集管线拆除进行中时换 src，新 src 的
        // 媒体加载器可能永远不发请求（元素 rs0/net2 卡死、tts-logs 里连 arrive 都没
        // 有）。实测触发条件：QQ音乐播放中（采集活跃）点讲书 → 无声、字幕不动、
        // pause/play 失灵；「下一章节」之所以能恢复，是因为那时 close 早已完成、
        // 第二次 closeLiveViz 只是空操作。因此换 src 前先 quiesceThen（等拆除落定，
        // 最多 150ms）。
        const beginLoad = () => {
          // Blob 通道（bookUseBlob=true，元素加载器已被证明对讲书不可靠）：
          // 新块字节由 armBookBlobFallback 并行 fetch，就绪后由它换 src 播放。
          // 这里【绝不】调用 play()——元素此刻还挂着上一块的 blob src，直接 play
          // 会把旧书重新播起来，而旧书的 timeupdate 又会置位进度信号、把新块的
          // Blob 接管拦下 → 播放条显示新书、实际卡死（实测「中途切书冷启动」根因）。
          if (bookUseBlob) {
            try { bookElementProgressed = false; loadBookSubtitle(id, from); } catch (err) {}
            void ensureBookTotal(id).then((total) => {
              if (from + 1 < total) preloadBook(id, from + 1);
            });
            return;
          }
          // 元素网络路径（首次/元素被证明可靠时）：
          try {
            bookElementProgressed = false; // 新块：真实进度信号从零开始
            bookPinSeekTried = false;
            audio.src = url;
            audio.load();
            // 若上一块是看门狗 blob 播放的，src 已被替换 → 释放旧 object URL。
            revokeBookBlob();
            // 讲书实时字幕：拉取当前块文本并按句切分，随播放推进逐句显示。
            loadBookSubtitle(id, from);
          } catch (err) { clearStuck(); failBook('无法获取讲书音频：' + String((err && err.message) || err)); return; }
          const promise = audio.play();
          if (promise !== undefined && typeof promise.then === 'function') {
            promise.then(() => {
              clearStuck();
              doneBuffering();
              bookJustAdvanced = false; // 新块真正开始播放：其后同块的 ended 是真实结束
            }).catch((e) => {
              clearStuck();
              // Distinguish a real autoplay block (NotAllowedError) from a media
              // load/decode failure. Load failures are already surfaced by the
              // <audio> error handler (which fetches the server's real message);
              // here we only need to stop the spinner, not mislabel it as autoplay.
              const isAutoplay = e && (e.name === 'NotAllowedError' || /not allowed|autoplay|gesture/i.test(String(e && e.message)));
              if (isAutoplay) failBook('自动播放被拦截，请在播放条上点击 ▶ 解锁');
              else if (bookUnwedgeReloadAt !== 0 && Date.now() - bookUnwedgeReloadAt < 2000) {
                // 看门狗重新 load() 主动中断的旧 play：缓冲提示保留，由看门狗自己的
                // play() 接管（合成完成即开播，届时其 then 会清缓冲）。
              } else doneBuffering();
            });
          } else {
            clearStuck();
            doneBuffering();
          }
          // Resolve total in the background — a slow /meta must not stall the
          // initial play (that would leave it "buffering" with no network request).
          void ensureBookTotal(id).then((total) => {
            if (from + 1 < total) preloadBook(id, from + 1);
          });
        };
        // 等采集管线拆除落定后再加载（beginLoad）；拆除挂起时 150ms 后照常继续。
        quiesceThen(beginLoad);
        // 字节就绪即接管：合成完成 + 1.5s 宽限后元素仍未起播 → 用 fetch 到的字节
        // Blob 直接播放（本环境元素加载器对讲书音频不可靠）。
        armBookBlobFallback(id, from, () => { clearStuck(); doneBuffering(); }, (m) => { clearStuck(); failBook('讲书音频获取失败：' + m); });
      } catch (err) {
        clearStuck();
        failBook('无法获取讲书音频：' + String((err && err.message) || err));
      }
    }
    // `from` lets the toc jump straight to a chapter's chunk index.
    function playBook(id, from = 0) { unlockAutoplay(); bookTotal = -1; bookBufferedFrom = -1; bookBaseTime = 0; bookRestorePos = -1; bookAutoRetried = false; bookJustAdvanced = false; clearBookUnwedge(); clearBookGrace(); bookPlaySeq++; bookFallbackFor = ''; revokeBookBlob(); playBookFrom(id, from, false); saveCurrentBookPlayback(); }
    // Play a novel from its saved progress when available (e.g. switching to
    // music and back), otherwise start fresh from the beginning. Explicit
    // chapter jumps keep using playBook(id, fromChunk) and are unaffected.
    function resumeOrPlayBook(id) {
      const book = bookById(id);
      if (book === null) return;
      const entry = getBookPlayback(book.name);
      if (entry === null) { playBook(id); return; }
      // Seed chunk / cumulative clock / in-chunk position from this book's entry.
      restoreBookPlayback(book.name);
      if (String(store.currentId) === 'book:' + id) {
        // Restore applied: play the saved chunk; onTime seeks to the in-chunk pos.
        unlockAutoplay();
        playBookFrom(id, bookFromRef, false);
      } else {
        playBook(id); // restore bailed (book gone) → start fresh
      }
    }
    // ---- 新闻播完自动切回原内容 ----
    // 新闻意图到达（定时任务到点自动播报/面板整期播放）且当前有内容在播时，先快照被打断的
    // 来源；新闻虚拟书自然播完后再恢复。各来源的进度本就由 savePlayback 分键持久化
    // （本地/QQ/酷狗/每本讲书互不覆盖），恢复直接借用现有续播机制：讲书 resumeOrPlayBook
    // 从进度续播；音乐/QQ/酷狗 restore* 恢复曲目+定位钉后 togglePlay 从断点继续。
    function snapshotNewsResume(newsId) {
      const cid = store.currentId;
      if (cid === null || !store.playing) return null; // 没有在播的内容，无需恢复
      const s = String(cid);
      if (s.startsWith('book:news-')) return null; // 已在播新闻（不做新闻→新闻快照）
      if (s.startsWith('book:')) return { newsId, kind: 'book', id: currentBookId() };
      if (s.startsWith('kg:')) return { newsId, kind: 'kg' };
      if (s.startsWith('qq:')) return { newsId, kind: 'qq' };
      return { newsId, kind: 'music' };
    }
    // 新闻期次自然播完时调用：成功恢复返回 true（调用方跳过 stop）。仅当此刻仍在播
    // 快照对应的那期新闻才生效——期间用户手动切走/停止则放弃恢复并清除快照。
    function resumeAfterNews() {
      const snap = newsResume;
      if (snap === null) return false;
      newsResume = null;
      if (String(store.currentId || '') !== 'book:' + snap.newsId) return false;
      stop();
      if (snap.kind === 'book') { resumeOrPlayBook(snap.id); return true; }
      if (snap.kind === 'music') restorePlayback(store.tracks);
      else if (snap.kind === 'qq') restoreQQPlayback();
      else if (snap.kind === 'kg') restoreKGPlayback();
      if (store.currentId !== null) { togglePlay(); return true; }
      return false; // 恢复失败（如曲目已不存在）→ 维持停止态
    }
    // When a chunk ends, switch to the next HTTP chunk (warmed by preAudio).
    // The switch is silent: no buffering flash, and the book-wide clock keeps
    // the completed chunk's duration so the readout never resets.
    function maybeAdvanceBook() {
      if (store.currentId === null || !String(store.currentId).startsWith('book:')) return false;
      const id = String(store.currentId).slice('book:'.length);
      if (bookFromRef + 1 < bookTotal) {
        // 进入新块：每个块各拥有一次自动重试的机会。
        bookAutoRetried = false;
        // 恢复定位钉只属于「被恢复的那一块」：切到下一块必须丢弃，否则下一块的
        // 音频会被 seek 回上一块的恢复位置（跳到末尾即刻结束 → 卡住/无声音/字幕不动）。
        bookRestorePos = -1;
        restoredMusicPos = null;
        const endedDur = Number.isFinite(audio.duration) ? audio.duration : (audio.currentTime || 0);
        if (Number.isFinite(endedDur)) bookBaseTime += endedDur;
        // 只有下一块确已预热（preAudio 缓冲就绪、切换瞬时完成）才静默切块；
        // 冷启动续播跳块时下一块尚未合成（需数秒~数十秒），必须显示「AI 合成中」
        // 并带上 60s 超时兜底，否则用户看到的是无声无息的「卡住」（既没声音、
        // 字幕也不动，又没有任何反馈）。
        const warmed = bookBufferedFrom === bookFromRef + 1;
        bookJustAdvanced = true; // 后续紧到的重复 ended 属旧块陈旧事件（onEnded 据此吞掉）
        playBookFrom(id, bookFromRef + 1, warmed);
        // Persist the new chunk/base immediately so a refresh after the switch
        // resumes from here (with the continuous clock) rather than the old chunk.
        lastPosSaveAt = Date.now();
        savePlayback();
        return true;
      }
      return false;
    }
    // 恢复续播的定位钉评估（onTime 与 onDur 共用）：
    //   真实播放明显越过恢复点 → 释放定位钉，交给实时时间；
    //   恢复点已超出本块实际时长（重启后冷合成可能更短）→ 用户其实已读完这一块，
    //     直接跳到下一块继续，而不是重听本块（否则整块重播，或钳到块尾卡住）；
    //   时长已知且恢复点在块内 → 才把音频 seek 到恢复点；
    //   时长未知 → 什么都不做（绝不提前把可能越界的位置塞进 currentTime）。
    // 关键：onDur（durationchange）也调用——只挂在 timeupdate 上时，若元素被钳在
    // 块尾（不再播放、不再派发 timeupdate），pastEnd 补救永远不会被评估，续播就会
    // 永久卡在「没声音、字幕不动」。
    function evaluateBookRestorePin() {
      if (!(bookRestorePos >= 0) || !String(store.currentId || '').startsWith('book:')) return false;
      const ct = audio.currentTime || 0;
      const dur = (Number.isFinite(audio.duration) && audio.duration > 0) ? audio.duration : 0;
      if (ct > bookRestorePos + 1) {
        bookRestorePos = -1; // real playback advanced past the spot — live time
        return false;
      }
      if (dur > 0 && bookRestorePos >= dur) {
        // maybeAdvanceBook 内部会清 bookRestorePos 并推进 bookBaseTime；若已到最后一
        // 块（无下一块）则释放定位钉、让本块自然播完后再结束。
        if (!maybeAdvanceBook()) bookRestorePos = -1;
        return true;
      }
      if (dur > 0) {
        if (store.playing && ct < bookRestorePos - 0.5) {
          // 只 seek 一次：本环境元素对讲书 WAV 的 seek 可能不生效（currentTime 停在
          // 0）。每次 timeupdate 都重 seek 会形成紧密循环（seek→timeupdate→seek…，
          // 实测 ct 永远停在 0.00、无声、字幕不动）。首次 seek 后记时刻；若 2s 内
          // ct 仍未前进到 0.05，则释放定位钉、让本块从头正常播放（从 0 播正常）。
          if (!bookPinSeekTried) {
            bookPinSeekTried = true;
            bookPinSeekAt = Date.now();
            try { audio.currentTime = bookRestorePos; } catch (e) {}
          } else if (ct < 0.05 && Date.now() - bookPinSeekAt > 2000) {
            bookRestorePos = -1;
            return false;
          }
        }
        set({ position: bookBaseTime + bookRestorePos });
        // 补齐：pin 阶段也推进字幕——续播时该块的实时字幕可能还没就绪，这里在
        // 每次 timeupdate 都尝试定位当前句，避免「先空白、切块后才出字幕」。
        updateLyric();
        return true;
      }
      return false; // dur 尚未知（元数据未加载）：等 onDur/onTime 再评估
    }
    function stopBookHelper() {
      preAudio.removeAttribute('src'); preAudio.load();
      if (bookStuckTimer !== null) { clearTimeout(bookStuckTimer); bookStuckTimer = null; }
      clearBookUnwedge();
      clearBookGrace();
      bookPlaySeq++;
      bookFallbackFor = '';
      revokeBookBlob();
      bookTotal = -1; bookFromRef = 0; bookBufferedFrom = -1; bookBaseTime = 0; bookRestorePos = -1; bookJustAdvanced = false;
    }
    function togglePlay() {
      if (store.pendingId !== null && store.currentId === null) { startPlay(store.pendingId); return; }
      if (store.currentId === null) { const ids = activeIds(); if (ids.length > 0) startPlay(ids[0]); return; }
      if (audio.paused) {
        // A restored track's <audio> was not pre-loaded (restore never touches
        // the element, to avoid the Chromium 'getTopURL' quirk), so load it now,
        // then apply the deferred seek so it resumes from the saved spot.
        if (restoredMusicPos !== null && restoredMusicPos > 0) {
          const track = resolvePlayable(store.currentId);
          if (track !== null && audio.currentSrc !== new URL(track.url, window.location.href).href) {
            audio.src = track.url;
            audio.load();
          }
          if ((audio.currentTime || 0) < restoredMusicPos - 0.5) {
            try { audio.currentTime = restoredMusicPos; } catch (e) {}
          }
        }
        // 在线 QQ 曲目：刷新恢复后没有保存进度，但需要主动加载流地址才能播放
        // （在线流每次经代理重新获取，不能沿用旧的 audio.src）。
        if (String(store.currentId).startsWith('qq:')) {
          const track = resolvePlayable(store.currentId);
          if (track !== null && audio.currentSrc !== new URL(track.url, window.location.href).href) {
            audio.src = track.url;
            audio.load();
          }
          // 刷新恢复的 QQ 曲目不经过 startQQPlayback，这里补发一次轻量 HEAD，
          // 让「真实品质」标签在续播后也能显示。
          if (track !== null) loadQQQuality(String(track.id).slice(3), track.url);
        }
        // 刷新恢复的酷狗曲目不经过 startKGPlayback，同样补发一次轻量 HEAD，
        // 让「真实品质」标签在续播后也能显示（与 QQ 同款处理）。
        if (String(store.currentId).startsWith('kg:')) {
          const track = resolvePlayable(store.currentId);
          if (track !== null && audio.currentSrc !== new URL(track.url, window.location.href).href) {
            audio.src = track.url;
            audio.load();
          }
          if (track !== null) loadKGQuality(String(track.id).slice(3), track.url);
        }
        if (bookRestorePos >= 0 && String(store.currentId).startsWith('book:')) {
          const id = currentBookId();
          const chunkUrl = bookUrl(id, bookFromRef);
          // 重启续播：Host TTS 合成缓存已清空，恢复的这块若尚未预热完成，点 ▶ 后仍要
          // 重新合成（数秒~数十秒）。若不置缓冲提示/合成超时，播放条会停在恢复位置、
          // 无声音、字幕不动——表现为「卡住」。这里沿用 playBookFrom 的「AI 合成中… Ns」
          // 提示 + 60s 超时兜底，让等待透明、且合成失败/挂起时有明确错误而非无限卡死。
          if (bookStuckTimer !== null) clearTimeout(bookStuckTimer);
          set({ bookBuffering: true, bookBufferingSilent: false, bookBufferingSince: Date.now() });
          bookStuckTimer = setTimeout(() => {
            if (store.bookBuffering) { set({ bookBuffering: false, bookBufferingSilent: false, bookBufferingSince: 0, bookError: 'AI 合成超时，请点击「重试」' }); bookStuckProbe(id, bookFromRef); }
          }, 60000);
          armBookUnwedge(id, bookFromRef);
          // 换 src 前必须等采集管线拆除真正完成（AudioContext.close 异步）——拆除进行中
          // 换 src 会让新加载器永远不发请求（rs0/net2 卡死，见 playBookFrom 内的说明）。
          // 注意：这里绝不能提前 seek（旧实现 load() 后立刻 currentTime=bookRestorePos）。
          // 冷启动续播时本块是重新合成的（TTS 非确定性，时长会变），越界 seek 会被浏览器
          // 钳到块末尾。seek 统一交给定位钉：onDur/onTime 确认恢复点在块内后才 seek。
          const beginLoad = () => {
            bookElementProgressed = false; // 新块：真实进度信号从零开始
            // blob 兜底已把字节装进元素（currentSrc=blob）时不要重置回网络 URL——
            // 那会丢掉已就绪的字节并重新踩进元素加载器的坑；此时 ▶ 只差一次 play()。
            const blobReady = bookBlobUrl !== null && audio.currentSrc === bookBlobUrl;
            if (!blobReady && chunkUrl !== null && audio.currentSrc !== new URL(chunkUrl, window.location.href).href) {
              audio.src = chunkUrl;
              audio.load();
            }
            if (bookTotal >= 0 && bookFromRef + 1 < bookTotal) preloadBook(id, bookFromRef + 1);
            // 恢复续播的这块之前没有拉取过字幕（restore 不动 audio、playBookFrom 不经过
            // 这里），必须补一次 loadBookSubtitle，否则续播后整块无字幕、直到切块才出现。
            loadBookSubtitle(id, bookFromRef);
            const promise = audio.play();
            if (promise !== undefined && typeof promise.then === 'function') {
              promise.then(() => {
                clearBookUnwedge();
                if (bookStuckTimer !== null || store.bookBuffering) {
                  if (bookStuckTimer !== null) { clearTimeout(bookStuckTimer); bookStuckTimer = null; }
                  set({ bookBuffering: false, bookBufferingSilent: false, bookBufferingSince: 0 });
                }
                bookJustAdvanced = false; // 本块真正开始播放：其后同块的 ended 是真实结束
              }).catch((err) => {
                // 播放被拒绝（如 autoplay 拦截）时同样清掉缓冲/超时：否则「AI 合成中…」
                // 会一直挂着，而错误提示又不显示（这里只对 autoplay 拦截报错）。
                if (bookUnwedgeReloadAt !== 0 && Date.now() - bookUnwedgeReloadAt < 2000) {
                  // 看门狗重新 load() 主动中断的旧 play：缓冲提示保留，由看门狗自己的
                  // play() 接管（其 then 会清缓冲）。
                  return;
                }
                clearBookUnwedge();
                if (bookStuckTimer !== null) { clearTimeout(bookStuckTimer); bookStuckTimer = null; }
                set({ bookBuffering: false, bookBufferingSilent: false, bookBufferingSince: 0 });
                if (isAutoplayBlocked(err)) set({ error: '浏览器拦截了自动播放，请点击播放按钮' });
              });
            }
          };
          // 拆除挂起时 150ms 后照常继续（quiesceThen 内部会先 closeLiveViz）。
          quiesceThen(beginLoad);
          // 字节就绪即接管（与 playBookFrom 同款）：合成完成 + 1.5s 宽限后元素仍
          // 未起播 → fetch 字节 Blob 直接播放。
          armBookBlobFallback(id, bookFromRef, () => {
            clearBookUnwedge(); clearBookGrace();
            if (bookStuckTimer !== null) { clearTimeout(bookStuckTimer); bookStuckTimer = null; }
            set({ bookBuffering: false, bookBufferingSilent: false, bookBufferingSince: 0, bookError: '' });
          }, (m) => {
            clearBookUnwedge(); clearBookGrace();
            if (bookStuckTimer !== null) { clearTimeout(bookStuckTimer); bookStuckTimer = null; }
            set({ bookBuffering: false, bookBufferingSilent: false, bookBufferingSince: 0, bookError: '讲书音频获取失败：' + m });
          });
          // 刷新恢复的曲目：续播时按需加载歌词（讲书走 loadBookSubtitle，无歌词文件）。
          return;
        }
        const promise = audio.play();
        if (promise !== undefined && typeof promise.then === 'function') {
          promise.then(() => {
            if (bookStuckTimer !== null || store.bookBuffering) {
              if (bookStuckTimer !== null) { clearTimeout(bookStuckTimer); bookStuckTimer = null; }
              set({ bookBuffering: false, bookBufferingSilent: false, bookBufferingSince: 0 });
            }
          }).catch((err) => {
            if (isAutoplayBlocked(err)) set({ error: '浏览器拦截了自动播放，请点击播放按钮' });
          });
        }
        // 刷新恢复的曲目：续播时按需加载歌词（startPlay 只覆盖手动点歌路径）。
        if (!String(store.currentId).startsWith('book:') && lyricTrackId !== store.currentId) {
          loadLyricForTrack(store.currentId);
        }
      } else audio.pause();
    }
    function step(delta) {
      const ids = activeIds();
      if (ids.length === 0) return;
      if (store.mode === 'shuffle' && ids.length > 1) {        // Walk the shuffled queue: next plays the next unplayed track, prev
        // returns to the previously played one (not a list-order neighbor).
        ensureShuffleReady();
        const pos = shuffleQueue.indexOf(store.currentId);
        if (store.currentId === null) {
          // Nothing playing yet: start from the head of the shuffled queue.
          if (delta > 0) startPlay(shuffleQueue[0]);
          return;
        }
        if (delta > 0) {
          if (pos >= 0 && pos + 1 < shuffleQueue.length) {
            startPlay(shuffleQueue[pos + 1]);
          } else {
            // Round finished: reshuffle anchored on the current track so the
            // next play is a fresh unplayed one, not the track that just ended.
            buildShuffleQueue(store.currentId);
            startPlay(shuffleQueue.length > 1 ? shuffleQueue[1] : shuffleQueue[0]);
          }
        } else if (pos > 0) {
          startPlay(shuffleQueue[pos - 1]);
        } else {
          // Already at the head of the shuffled queue: replay the current track.
          startPlay(store.currentId);
        }
        return;
      }
      const idx = ids.indexOf(store.currentId);
      const nextIdx = idx < 0 ? 0 : (idx + delta + ids.length) % ids.length;
      startPlay(ids[nextIdx]);
    }
    // In book (AI 讲书) mode the transport prev/next buttons jump between
    // CHAPTERS instead of music tracks. The current chapter is the section
    // whose fromChunk <= the playing chunk < the next section's fromChunk.
    function stepBook(delta) {
      const id = currentBookId();
      if (id === null) return;
      let sections = store.bookToc || [];
      if (sections.length === 0) {
        // structure not loaded yet: fetch it, then retry the jump once.
        void ensureBookToc(id).then((meta) => {
          if (meta !== null && meta.sections.length > 0 && currentBookId() === id) stepBook(delta);
        });
        return;
      }
      let curIdx = -1;
      for (let i = 0; i < sections.length; i++) {
        if (sections[i].fromChunk <= bookFromRef) curIdx = i; else break;
      }
      if (curIdx < 0) curIdx = 0;
      const nextIdx = Math.max(0, Math.min(sections.length - 1, curIdx + delta));
      if (nextIdx === curIdx) return; // already at the first/last chapter
      playBook(id, sections[nextIdx].fromChunk);
    }
    function changeVolume(value) {
      const v = Math.min(1, Math.max(0, value));
      audio.volume = v;
      set({ volume: v });
    }
    // Switch the AI 讲书 voice. The new voice must be synthesized (seconds), so we
    // pre-synthesize the current chunk in the background and only swap playback
    // once it is ready — the old voice keeps playing meanwhile, so switching never
    // causes a silent gap. On failure we revert the selection and keep the old
    // voice (the current audio is left untouched).
    function setVoice(voice) {
      if (!voice || voice === store.voice) return;
      const prevVoice = store.voice;
      set({ voice, voiceSwitching: false });
      const id = currentBookId();
      if (id === null || store.currentId === null || !String(store.currentId).startsWith('book:')) return;
      const from = bookFromRef;
      const mySeq = ++voiceSwitchSeq;
      set({ voiceSwitching: true });
      fetch(bookUrl(id, from), { cache: 'no-store' })
        .then((r) => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.arrayBuffer();
        })
        .then(() => {
          if (mySeq !== voiceSwitchSeq) return; // superseded by a newer switch
          // New-voice wav is synthesized (host cache + browser cache are warm);
          // swap the current chunk now — near-instant.
          set({ voiceSwitching: false });
          if (currentBookId() === id && bookFromRef === from) {
            unlockAutoplay();
            playBookFrom(id, from, true);
          }
        })
        .catch((err) => {
          if (mySeq !== voiceSwitchSeq) return;
          set({ voiceSwitching: false, voice: prevVoice, bookError: '声音切换失败：' + String((err && err.message) || err) });
        });
    }
    function stop() {
      // Capture the current novel before resetting, so stopping forgets only
      // that one book's position (other novels keep their own progress).
      const stoppedBook = (store.currentId !== null && String(store.currentId).startsWith('book:'))
        ? bookById(currentBookId()) : null;
      // 停止只清「当前来源」的持久化记录：本地清 PREF_PLAYBACK、在线 QQ 清
      // PREF_PLAYBACK_QQ、酷狗清 PREF_PLAYBACK_KG——彼此独立，停本地不会丢掉
      // 其他来源的队列，反之亦然。
      let stoppedMusicKey = null;
      if (store.currentId !== null) {
        if (String(store.currentId).startsWith('qq:')) stoppedMusicKey = PREF_PLAYBACK_QQ;
        else if (String(store.currentId).startsWith('kg:')) stoppedMusicKey = PREF_PLAYBACK_KG;
        else if (!String(store.currentId).startsWith('book:')) stoppedMusicKey = PREF_PLAYBACK;
      }
      restoredMusicPos = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      stopBookHelper();
      bookAutoRetried = false;
      set({ currentId: null, currentName: null, playing: false, position: 0, duration: 0, pendingId: null, pendingName: null, bookBuffering: false, bookError: '', bookBufferingSince: 0, bookBufferingSilent: false, tocOpen: false, currentSection: '', lyricText: '', voiceSwitching: false, bookProgress: 0 });
      resetLyric();
      // 歌词数据已随本次停止清空：失效「已加载歌词」标记（lyricTrackId），否则切回
      // 同一曲目续播时 togglePlay/restoreLyricForCurrent 的守卫会误判「歌词还在」
      // 而跳过重载（新闻播完自动切回原内容的场景就踩过：续播后无歌词）。
      lyricTrackId = null;
      if (stoppedMusicKey !== null) clearPref(stoppedMusicKey);
      if (stoppedBook !== null) clearBookPlayback(stoppedBook.name);
      releaseWakeLock();
    }

    // ---- Screen Wake Lock: keep the screen awake while music is playing ----
    // While audio plays we request a screen wake lock so the display (and, for
    // most power policies, the system) doesn't blank or sleep mid-song. Tabs
    // can't stop OS-level deep sleep, but holding a wake lock while visible
    // covers the common "screen blanked while I listened" case. Unsupported
    // browsers (e.g. Safari) silently skip it — never fatal.
    let wakeLock = null;
    const wakeLockSupported = (typeof navigator !== 'undefined') && ('wakeLock' in navigator);
    async function acquireWakeLock() {
      if (!wakeLockSupported || !store.playing) return;
      if (wakeLock !== null) return; // already held
      try {
        const sentinel = await navigator.wakeLock.request('screen');
        sentinel.addEventListener('release', () => { if (wakeLock === sentinel) wakeLock = null; });
        wakeLock = sentinel;
      } catch (e) {
        wakeLock = null; // denied or transient — non-fatal
      }
    }
    function releaseWakeLock() {
      if (wakeLock !== null) {
        try { wakeLock.release(); } catch (e) {}
        wakeLock = null;
      }
    }

    function bindAudio() {
      // Books report a continuous, book-wide clock: the cumulative seconds of
      // all completed chunks plus the current chunk's in-chunk position, so the
      // time readout grows across chunk boundaries instead of resetting each
      // block (it reads like one long audiobook). Music is unchanged.
      const bookTimeBase = () => (store.currentId !== null && String(store.currentId).startsWith('book:')) ? bookBaseTime : 0;
      const onTime = () => {
        // timeupdate 只在音频真实推进时触发 → 这是「元素真的在出声」的权威信号，
        // 供 Blob 兜底的宽限守卫判断（store.playing/readyState 都不可靠）。
        if ((audio.currentTime || 0) > 0.05) {
          if (!bookElementProgressed)          bookElementProgressed = true;
        }
        // 讲书：按「已读字符/全书字符」实时推进全书进度条。不用 position/duration 的
        // 时间占比——那是当前块内比例，切块会回退；且全书总时长在合成本书前不可知。
        if (String(store.currentId).startsWith('book:')) {
          const bp = bookProgressFor();
          if (bp !== store.bookProgress) set({ bookProgress: bp });
        }
        // A restored music track keeps showing its restored position until real
        // playback has clearly advanced past it. The <audio> currentTime is
        // unreliable right after a restore — it can seek to the spot and then
        // transiently reset to 0 (some browsers do this), so releasing the pin
        // too early makes the readout follow that 0. Release only once
        // currentTime is clearly past the spot (proving genuine progress); while
        // not there yet, show the target — and if playing but stuck behind it
        // (e.g. autoplay started from 0), re-seek so playback resumes from the
        // right place instead of silently from the start.
        if (restoredMusicPos !== null && restoredMusicPos > 0) {
          const ct = audio.currentTime || 0;
          if (ct > restoredMusicPos + 1) {
            restoredMusicPos = null; // real playback advanced past the spot — live time
          } else {
            if (store.playing && ct < restoredMusicPos - 0.5) {
              try { audio.currentTime = restoredMusicPos; } catch (e) {}
            }
            set({ position: bookTimeBase() + restoredMusicPos });
            return;
          }
        }
        // A restored book applies the same pin to its in-chunk position (its
        // deferred seek is applied once duration is known and we're playing) —
        // anchored on top of the book-wide clock. Shared with onDur so the
        // pastEnd rescue runs even when no timeupdate ever fires.
        if (bookRestorePos >= 0 && String(store.currentId).startsWith('book:') && evaluateBookRestorePin()) return;
        set({ position: bookTimeBase() + (audio.currentTime || 0) });
        // Persist the playback spot periodically (≈every 5s) for BOTH music and
        // novels, so a refresh at any moment resumes here instead of jumping
        // back to 0 (books additionally carry chunk + cumulative-clock state).
        if (store.playing && Date.now() - lastPosSaveAt > 5000) {
          lastPosSaveAt = Date.now();
          savePlayback();
        }
        // 跟随播放位置推进歌词/字幕当前行（文本变化时才 set）。
        updateLyric();
      };
      const onDur = () => {
        // Only overwrite when the media actually reports a real duration;
        // before metadata loads audio.duration is NaN and we'd clobber a
        // restored/stored value with 0 (leaving "0:00").
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          // 讲书字幕按块内播放比例定位句子：块时长就绪后立即校准。
          if (store.currentId !== null && String(store.currentId).startsWith('book:')) { subtitleDur = audio.duration; }
          // 讲书块兜底：若浏览器报的时长远超正常范围，先静音重试一次（坏 WAV
          // 可能靠重试恢复）。重试后仍超长则按真实长块正常播放——Host 已做
          // WAV 头/静音校验，能到这里的几乎不可能是坏 WAV，因此绝不误杀。
          if (store.currentId !== null && String(store.currentId).startsWith('book:')
            && audio.duration > BOOK_MAX_CHUNK_SEC) {
            if (!bookAutoRetried) {
              bookAutoRetried = true;
              const id = String(store.currentId).slice('book:'.length);
              unlockAutoplay();
              playBookFrom(id, bookFromRef, true);
              return; // retry re-loads; don't clobber duration yet
            }
          }
          // 恢复定位钉在「时长就绪」的瞬间先评估一次：这是 pastEnd（保存位置 ≥ 新块
          // 实际时长，冷合成块变短）能被最早发现的时机。只靠 onTime 评估会在元素被
          // 钳到块尾、不再播放、不再派发 timeupdate 时永远轮不到补救（冷启动续播
          // 「响一下→没声音、字幕不动」的残留卡死点）。
          if (bookRestorePos >= 0 && String(store.currentId).startsWith('book:')) evaluateBookRestorePin();
          set({ duration: (bookTimeBase() + audio.duration) });
        }
      };
      const onPlay = () => { qqErrorSkipCount = 0; set({ playing: true, error: null }); acquireWakeLock(); if (!String(store.currentId || '').startsWith('book:')) setupLiveViz(); resumeVizCtx(); };
      const onPause = () => { set({ playing: false }); savePlayback(); releaseWakeLock(); };
      const onEnded = () => {
        // A novel plays chunk-by-chunk: when a chunk ends, auto-advance to the
        // next block until the whole book is done, then stop (never step into
        // the music list). Book ids are 'book:'-prefixed.
        if (store.currentId !== null && String(store.currentId).startsWith('book:')) {
          // 切块进行中（bookBuffering 为真）时要区分两种 ended：
          //   ① 刚切块过（bookJustAdvanced）：这是旧块的陈旧重复事件，吞掉——否则
          //      会连跳两块；标记在下一块真正开始播放（play promise 兑现）时清除。
          //   ② 尚未切块过：这是「本块真结束」带着缓冲态到达（恢复续播被钳到块尾
          //      等场景），若一并吞掉就会不切块、不报错地永久卡住——清缓冲并正常切块。
          if (store.bookBuffering && bookJustAdvanced) return;
          if (store.bookBuffering) {
            if (bookStuckTimer !== null) { clearTimeout(bookStuckTimer); bookStuckTimer = null; }
            set({ bookBuffering: false, bookBufferingSilent: false, bookBufferingSince: 0 });
          }
          if (!maybeAdvanceBook()) {
            // 新闻期次自然播完 → 自动切回被打断的原内容（新闻开始时有快照才生效）
            if (resumeAfterNews()) return;
            stop();
          }
          return;
        }
        if (store.mode === 'single' && store.currentId !== null) {
          audio.currentTime = 0;
          const promise = audio.play();
          if (promise !== undefined && typeof promise.catch === 'function') promise.catch((err) => { if (!isPlayAborted(err)) set({ error: '播放失败', playing: false }); });
          return;
        }
        step(1);
      };
      const onError = () => {
        // A novel chunk that fails to load (TTS error / timeout / decode) must
        // clear the "合成中…" spinner and surface a real message instead of
        // leaving the bar stuck buffering forever.
        if (store.currentId !== null && String(store.currentId).startsWith('book:')) {
          // 瞬时 LLM 合成失败：先自动静音重试一次当前块（听书不中断），
          // 重试仍失败才进入错误 + 手动重试。
          if (!bookAutoRetried) {
            bookAutoRetried = true;
            const retryId = String(store.currentId).slice('book:'.length);
            unlockAutoplay();
            playBookFrom(retryId, bookFromRef, true);
            return;
          }
          set({ bookBuffering: false, bookBufferingSince: 0, playing: false, bookError: '讲书音频获取失败，请重试' });
          // Best-effort: fetch the URL to show the server's actual diagnostic
          // (e.g. "TTS 请求失败 401 ..."), which the <audio> error object lacks.
          const id = String(store.currentId).slice('book:'.length);
          const book = bookById(id);
          if (book !== null) {
            fetch(bookUrl(id, bookFromRef), { cache: 'no-store' }).then((r) => {
              if (!r.ok) return r.text().then((t) => {
                const msg = String(t || '').trim();
                if (msg) set({ bookError: msg.slice(0, 240) });
              });
            }).catch(() => {});
          }
        } else {
          // 在线队列（QQ/酷狗）：某首歌因版权下架/拿不到播放地址而加载失败时，自动
          // 跳到下一首继续播放（不因单曲失败中断整个队列）；只有队列里就这一
          // 首、或连续跳过次数已达队列长度（整列都试过）才停下报错——且停止后
          // 不再 step，杜绝无限循环跳歌。
          const onlineQueueLen = String(store.currentId || '').startsWith('kg:')
            ? (store.kgQueue || []).length
            : (store.qqQueue || []).length;
          const isOnlineTrack = store.currentId !== null
            && (String(store.currentId).startsWith('qq:') || String(store.currentId).startsWith('kg:'));
          // 酷狗取链失败（含登录已失效被服务端自动登出的情况）：顺手复查一次登录态，
          // 若已被清掉就通知面板回到扫码登录页，而不是让用户卡在「播放失败」里。
          if (isOnlineTrack && String(store.currentId).startsWith('kg:')) checkKgAuthAfterPlayFail();
          if (isOnlineTrack && onlineQueueLen > 1 && qqErrorSkipCount < onlineQueueLen) {
            qqErrorSkipCount++;
            step(1);
            return;
          }
          set({ error: '音频加载或解码失败', playing: false });
        }
      };
      audio.addEventListener('timeupdate', onTime);
      audio.addEventListener('durationchange', onDur);
      audio.addEventListener('play', onPlay);
      audio.addEventListener('pause', onPause);
      audio.addEventListener('ended', onEnded);
      audio.addEventListener('error', onError);
      // captureStream() only carries an audio track once the element is actually
      // playing (readyState >= 3); 'play' can fire before there is data, so retry here.
      // 讲书不显示频谱（面板条件就是 !isBook）：同样不建采集 tap，否则每个讲书块
      // 都会销毁又重建一次 AudioContext（浪费且曾污染元素、让加载器不可靠）。
      const onPlaying = () => { if (!String(store.currentId || '').startsWith('book:')) setupLiveViz(); resumeVizCtx(); };
      audio.addEventListener('playing', onPlaying);
      return () => {
        audio.pause();
        audio.removeEventListener('timeupdate', onTime);
        audio.removeEventListener('durationchange', onDur);
        audio.removeEventListener('play', onPlay);
        audio.removeEventListener('pause', onPause);
        audio.removeEventListener('ended', onEnded);
        audio.removeEventListener('playing', onPlaying);
        audio.removeEventListener('error', onError);
      };
    }

    // Restore the persisted playback scope (playlist/library); a stale playlist id falls back.
    function restoreScope(plists) {
      const raw = loadPref(PREF_SCOPE);
      try {
        const o = JSON.parse(raw);
        if (o && o.kind === 'qq') { set({ scope: { kind: 'qq' } }); return; }
        if (o && o.kind === 'kg') { set({ scope: { kind: 'kg' } }); return; }
        if (o && o.kind === 'book') { set({ scope: { kind: 'book' } }); return; }
        if (o && o.kind === 'playlist' && (plists || []).some((p) => p.id === o.id)) {
          set({ scope: { kind: 'playlist', id: o.id } });
          return;
        }
      } catch (e) {}
      set({ scope: { kind: 'library' } });
    }

    // Restore local-music playback (PREF_PLAYBACK). Online QQ lives in its own
    // key and is restored by restoreQQPlayback — they no longer clobber each other.
    function restorePlayback(list) {
      const saved = loadPlayback();
      if (saved === null) return;
      // A saved current track may be a library track or a playlist member ('p:'+path).
      let track = list.find((t) => t.id === saved.id);
      let scope = { kind: 'library' };
      if (track === undefined && String(saved.id).startsWith('p:')) {
        for (const p of store.playlists || []) {
          const m = (p.tracks || []).find((t) => t.id === saved.id);
          if (m) { track = m; scope = { kind: 'playlist', id: p.id }; break; }
        }
      }
      if (track === undefined) return;
      const pos = Number.isFinite(saved.position) ? saved.position : 0;
      const savedDur = Number.isFinite(saved.duration) && saved.duration > 0 ? saved.duration : 0;
      // We do NOT touch the <audio> element here: in this environment loading or
      // seeking a media element during restore trips a harmless-but-noisy
      // Chromium 'getTopURL' rejection. The track is set up lazily on play
      // (togglePlay), and the readout is pinned to the restored values.
      set({
        currentId: track.id, currentName: track.name,
        currentArtists: track.artists || [],
        position: pos, duration: savedDur,
        pendingId: null, pendingName: null, error: null, scope,
        currentQuality: (track && track.quality) || '',
      });
      if (pos > 0) {
        restoredMusicPos = pos;
      } else {
        restoredMusicPos = null;
      }
      // Save the restored spot explicitly so it survives another refresh.
      savePref(PREF_PLAYBACK, JSON.stringify({ id: track.id, name: track.name, position: pos, duration: savedDur, ts: Date.now() }));
    }
    // Restore online-QQ playback (PREF_PLAYBACK_QQ): current track + queue +
    // position + online scope + online tab, independent of local music.
    function restoreQQPlayback(saved) {
      if (!saved) saved = loadQQPlayback();
      if (saved === null) return;
      // 兼容旧版：分离前 QQ 数据也写在 PREF_PLAYBACK 里（kind==='qq'），这里迁移到
      // 新 key 并清掉旧位置，避免旧记录与本地音乐记录互相覆盖。
      const pos = Number.isFinite(saved.position) && saved.position > 0 ? saved.position : 0;
      const savedDur = Number.isFinite(saved.duration) && saved.duration > 0 ? saved.duration : 0;
      set({
        currentId: saved.id,
        currentName: saved.name || 'QQ音乐',
        currentArtists: Array.isArray(saved.artists) ? saved.artists : [],
        scope: { kind: 'qq' },
        qqQueue: Array.isArray(saved.queue) ? saved.queue : [],
        qqSource: saved.source || '在线',
        qqQueueFrom: (saved.queueFrom && typeof saved.queueFrom === 'object') ? saved.queueFrom : null,
        // 恢复出带来源歌单的队列 → bump 一次 rev，让面板「恢复后刷新」跟随最新歌单。
        qqQueueRev: (saved.queueFrom && typeof saved.queueFrom === 'object') ? (store.qqQueueRev || 0) + 1 : (store.qqQueueRev || 0),
        // 恢复在线曲目的中途位置：播放条立即显示保存的位置；用户点 ▶ 续播时
        // togglePlay 会经 restoredMusicPos 把流 seek 到该位置（与本地曲目一致）。
        position: pos, duration: savedDur,
        pendingId: null, pendingName: null, error: null,
        tab: 'qq',
        currentQuality: '',
      });
      restoredMusicPos = pos > 0 ? pos : null;
      // 更新时间戳，避免被当作旧数据。
      savePref(PREF_PLAYBACK_QQ, JSON.stringify({ ...saved, ts: Date.now() }));
      // 恢复在线曲目后按「我喜欢」集合刷新爱心状态。
      checkQQFavForCurrent();
    }
    // Restore online-KuGou playback（PREF_PLAYBACK_KG）——与 QQ 版同构，作用域 kind:'kg'。
    function restoreKGPlayback(saved) {
      if (!saved) saved = loadKGPlayback();
      if (saved === null) return;
      const pos = Number.isFinite(saved.position) && saved.position > 0 ? saved.position : 0;
      const savedDur = Number.isFinite(saved.duration) && saved.duration > 0 ? saved.duration : 0;
      set({
        currentId: saved.id,
        currentName: saved.name || '酷狗音乐',
        currentArtists: Array.isArray(saved.artists) ? saved.artists : [],
        scope: { kind: 'kg' },
        kgQueue: Array.isArray(saved.queue) ? saved.queue : [],
        kgSource: saved.source || '在线',
        kgQueueFrom: (saved.queueFrom && typeof saved.queueFrom === 'object') ? saved.queueFrom : null,
        // 恢复出带来源歌单的队列 → bump 一次 rev，让面板「恢复后刷新」跟随最新歌单。
        kgQueueRev: (saved.queueFrom && typeof saved.queueFrom === 'object') ? (store.kgQueueRev || 0) + 1 : (store.kgQueueRev || 0),
        position: pos, duration: savedDur,
        pendingId: null, pendingName: null, error: null,
        tab: 'kg',
        currentQuality: '',
        kgFaved: false,
      });
      restoredMusicPos = pos > 0 ? pos : null;
      savePref(PREF_PLAYBACK_KG, JSON.stringify({ ...saved, ts: Date.now() }));
      // 恢复酷狗曲目后按「我喜欢」集合刷新爱心状态。
      checkKGFavForCurrent();
    }

    // Restore a novel's playback after a refresh (or when resuming a book):
    // same book, same chunk, same cumulative clock, and same in-chunk position —
    // paused (tap ▶ to resume), matching how music is restored. When targetName
    // is given, restore that book; otherwise restore the most recently played
    // novel from the per-book map.
    function restoreBookPlayback(targetName) {
      const map = readBooksPlayback();
      let name = targetName;
      let entry = null;
      if (typeof name === 'string' && name !== '') {
        entry = map[name] || null;
      } else {
        for (const [n, e] of Object.entries(map)) {
          if (e && typeof e.from === 'number' && (entry === null || e.ts > entry.ts)) { entry = e; name = n; }
        }
      }
      if (entry === null || !name) return;
      const book = store.books.find((b) => b.name === name);
      if (book === undefined) return; // the book is no longer in the library
      const from = Number.isFinite(entry.from) && entry.from >= 0 ? entry.from : 0;
      const base = Number.isFinite(entry.base) ? entry.base : 0;
      const pos = Number.isFinite(entry.pos) ? entry.pos : 0;
      bookTotal = Number.isFinite(entry.total) ? entry.total : -1;
      bookFromRef = from;
      bookBaseTime = base;
      const url = bookUrl(book.id, from);
      if (url === null) return;
      // Mark the book as current. Like music restore, we do NOT touch the
      // <audio> element here (avoiding the Chromium 'getTopURL' quirk on
      // refresh); togglePlay loads + seeks the chunk when the user resumes.
      set({
        currentId: 'book:' + book.id, currentName: book.name, currentArtists: [],
        position: base + pos, duration: base + (Number.isFinite(audio.duration) ? audio.duration : 0),
        pendingId: null, pendingName: null, error: null, playing: false,
        bookBuffering: false, bookBufferingSilent: false, bookError: '', bookBufferingSince: 0,
        currentSection: '', bookToc: [], tocOpen: false,
        // 讲书恢复也写下自己的范畴信号（随 set 持久化到 PREF_SCOPE）：否则 scope
        // 停留在上次音乐的 library/qq/kg，刷新恢复的 scope 快捷分支永远轮不到讲书
        // （'book' 分支是死的）→ 刷新后被音乐恢复抢走。activeIds/scopeKey 对 'book'
        // 优雅回退曲库，面板列表不受影响。
        scope: { kind: 'book' },
      });
      bookRestorePos = pos;
      bookPinSeekTried = false;
      // 时间戳保鲜（同 QQ 恢复的「更新时间戳，避免被当作旧数据」）：恢复本身不产生
      // 播放、也就没有周期保存；而本地音乐的 restorePlayback 每次刷新都会重写自己的
      // ts——不 bump 的话 ts 比较会系统性偏向音乐，讲书恢复被抢。
      try {
        const m2 = readBooksPlayback();
        const e2 = m2[book.name];
        if (e2 && typeof e2 === 'object') { m2[book.name] = { ...e2, ts: Date.now() }; writeBooksPlayback(m2); }
      } catch (e3) {}
      // 恢复后立即加载章节结构并计算当前章节：让播放条章节徽标与章节目录
      // 立刻显示正在播放的章节（而不是等用户点 ▶、playBookFrom 才开始加载）。
      // ensureBookToc 内部会 set bookToc；这里再补上 currentSection。
      void ensureBookToc(book.id).then((meta) => {
        if (meta === null) return;
        // 刷新后书尚未播放（自动播放被拦截），onTime 不会触发、bookProgress 仍为 0，
        // 必须先在这里按「已读字符/全书字符」补一次，进度条才能立即显示正确的整体进度
        // （audio 未加载时 frac=0，即当前块起点位移 offset[from]；播放后由 onTime 微调）。
        const bp = bookProgressFor();
        if (bp !== store.bookProgress) set({ bookProgress: bp });
        if (meta.sections.length > 0) set({ currentSection: sectionForChunk(meta.sections, from) });
      });
      // Refresh the chunk total in the background (the book file may have
      // changed since the save); fall back to the saved total on failure.
      const savedTotal = bookTotal;
      bookTotal = -1;
      void ensureBookTotal(book.id).then((total) => {
        if (!Number.isFinite(total) || total < 0) { bookTotal = savedTotal; return; }
        bookTotal = total;
        // 预热「要续播的那一块」：重启后 Host 的 TTS 合成缓存与浏览器 HTTP 缓存都已
        // 清空/失效，续播时该块会重新合成（数秒~数十秒）。此时若不加处理，用户一点
        // ▶ 播放条就停在恢复位置、无声音、字幕不动——正是「重启后续播卡住」的根因。
        // 这里在恢复阶段就后台合成并缓存这一块，等用户点 ▶ 时即可秒起（或至少已
        // 在合成中，点 ▶ 只是等收尾，无需从零开始）。
        // 关键：必须 cache:'no-store'。响应带 Cache-Control:public,max-age=3600，
        // 默认缓存模式的 fetch 会把响应写入浏览器 HTTP 缓存；冷启动点 ▶ 时
        // <audio> 对同一 URL 的媒体请求与这次「边写边读」撞车（Chromium 媒体缓存
        // 锁竞态）会挂死在首帧——表现为「点小说没声音，点别的书再点回来就正常」
        // （换 URL 无竞态正常，回来时缓存条目已完成）。预热的目的只是把服务端
        // ttsAudioCache 焐热，完全不需要浏览器缓存参与。
        if (from >= 0 && from < total) fetch(bookUrl(book.id, from), { cache: 'no-store' }).catch(() => {});
        if (from + 1 < total) preloadBook(book.id, from + 1);
      });
    }

    // Restore whichever source (local music / online QQ / novel) was playing most
    // recently — each persists independently (PREF_PLAYBACK / PREF_PLAYBACK_QQ /
    // per-book map), so a local interlude never wipes an online queue and vice
    // versa. The one with the newest timestamp wins.
    function restoreLatest(list) {
      // 旧版兼容：分离前在线 QQ 数据也写在 PREF_PLAYBACK（kind==='qq'）。若发现旧
      // 位置仍是 QQ 记录，迁移到独立的 PREF_PLAYBACK_QQ 并从旧位置移除，避免它与
      // 本地音乐记录互相覆盖（一次性迁移，之后 savePlayback 各写各的 key）。
      migrateLegacyQQPlayback();
      let localTs = -1;
      try {
        const p = JSON.parse(loadPref(PREF_PLAYBACK) || 'null');
        if (p && typeof p.ts === 'number') localTs = p.ts;
      } catch (e) {}
      let qqTs = -1;
      try {
        const q = JSON.parse(loadPref(PREF_PLAYBACK_QQ) || 'null');
        if (q && typeof q.ts === 'number') qqTs = q.ts;
      } catch (e) {}
      let kgTs = -1;
      try {
        const g = JSON.parse(loadPref(PREF_PLAYBACK_KG) || 'null');
        if (g && typeof g.ts === 'number') kgTs = g.ts;
      } catch (e) {}
      const book = latestBookPlayback();
      const bookTs = book ? book.ts : -1;
      // 用户最后活动的「范畴」信号（播放时随 scope 持久化）：酷狗播放后 scope='kg'，
      // QQ 播放后 scope='qq'。当某个范畴的记录存在时，优先按其恢复，避免刷新后因
      // ts 竞态/毫秒差被更旧的其它在线记录抢走（例如「播酷狗时刷新却恢复成 QQ」）。
      let scopeKind = '';
      try {
        const sc = JSON.parse(loadPref(PREF_SCOPE) || 'null');
        if (sc && sc.kind) scopeKind = String(sc.kind);
      } catch (e) {}
      if (kgTs >= 0 && scopeKind === 'kg') { restoreKGPlayback(); restoreLyricForCurrent(); return; }
      if (qqTs >= 0 && scopeKind === 'qq') { restoreQQPlayback(); restoreLyricForCurrent(); return; }
      if (book !== null && scopeKind === 'book') { restoreBookPlayback(); restoreLyricForCurrent(); return; }
      // 恢复时间戳最新的那个来源；相等（tie/无时间戳）时本地优先。
      let best = 'local', bestTs = localTs;
      if (qqTs > bestTs) { best = 'qq'; bestTs = qqTs; }
      if (kgTs > bestTs) { best = 'kg'; bestTs = kgTs; }
      if (bookTs > bestTs) { best = 'book'; bestTs = bookTs; }
      if (best === 'book') { restoreBookPlayback(); restoreLyricForCurrent(); return; }
      if (best === 'qq') { restoreQQPlayback(); restoreLyricForCurrent(); return; }
      if (best === 'kg') { restoreKGPlayback(); restoreLyricForCurrent(); return; }
      restorePlayback(list); restoreLyricForCurrent();
    }
    // 一次性迁移：把旧版写在 PREF_PLAYBACK 里的 QQ 记录挪到 PREF_PLAYBACK_QQ。
    function migrateLegacyQQPlayback() {
      const raw = loadPref(PREF_PLAYBACK);
      if (raw === null) return;
      try {
        const p = JSON.parse(raw);
        if (p && typeof p.id === 'string' && (p.kind === 'qq' || String(p.id).startsWith('qq:'))) {
          savePref(PREF_PLAYBACK_QQ, JSON.stringify(p));
          clearPref(PREF_PLAYBACK);
        }
      } catch (e) {}
    }

    // ---- host data ----
    async function loadTracks() {
      set({ loading: true });
      try {
        // Load the Host prefs snapshot first so every restore below reads the
        // authoritative values (they survive dsh-desktop's random-port origin
        // changes). Re-apply mode/volume/voice on top of whatever the
        // synchronous startup restore already applied.
        await loadServerPrefs();
        applyStoredPrefs();
        set({ prefsReady: true });
        const result = await jsonGet('/dsh-music/manifest');
        set({
          root: result.root || null, bookRoot: result.bookRoot || null,
          tracks: result.tracks || [], books: result.books || [],
          playlists: result.playlists || [],
          count: result.count || 0, loading: false, error: result.error || null,
          voices: Array.isArray(result.voices) ? result.voices : [],
          version: result.version || '', description: result.description || '',
          ttsConfigured: !!result.ttsConfigured, ttsReason: result.ttsReason || '',
          ttsProvider: result.ttsProvider || '',
          qqLoggedIn: !!result.qqLoggedIn, qqUin: result.qqUin || '', qqNickname: result.qqNickname || '', qqLoginFrom: result.qqLoginFrom || '',
          kgLoggedIn: !!result.kgLoggedIn,
          // 版本更新弹窗四件套（Host 判定结论 + 内容），见 scheduleWhatsNewAuto。
          whatsNew: result.whatsNew || null,
          whatsNewHistory: Array.isArray(result.whatsNewHistory) ? result.whatsNewHistory : [],
          whatsNewWelcome: result.whatsNewWelcome || null,
          whatsNewState: result.whatsNewState || '',
        });
        const list = result.tracks || [];
        // Envelope (spectrum) decoding is deferred to actual playback — no need
        // to decode several full files eagerly at page load; the current track's
        // envelope decodes on play (startPlay / resume).
        restoreScope(result.playlists || []);
        restoreLatest(list);
        // 版本更新弹窗：首屏数据就绪后延迟自动弹（每次页面加载至多一次）。
        scheduleWhatsNewAuto();
      } catch (err) {
        set({ loading: false, error: '无法读取音乐库：' + String((err && err.message) || err) });
      }
    }
    function saveRoot(path, kind) {
      const target = kind === 'book' ? '/dsh-music/set-book-root' : '/dsh-music/set-root';
      set({ loading: true });
      fetch(target, {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      }).then((r) => r.json()).then((result) => {
        if (result && result.ok) {
          set({
            root: result.root || null, bookRoot: result.bookRoot || null,
            tracks: result.tracks || [], books: result.books || [],
            count: result.count || 0, loading: false, error: null,
          });
          // 换目录只刷新列表，不调用 restoreLatest：否则播放中的在线 QQ 曲目会
          // 触发 restorePlayback 把 tab 强制切回「QQ音乐」（选完目录被跳回的问题）。
        } else {
          set({ loading: false, error: (result && result.error) || '设置目录失败' });
        }
      }).catch((err) => {
        set({ loading: false, error: '设置目录失败：' + String((err && err.message) || err) });
      });
    }
    // 手动刷新：重新扫描当前音乐/小说目录并更新列表（面板「刷新」按钮）。
    // 与 saveRoot 一致只刷新列表、不调用 restoreLatest，避免把播放中的在线 QQ
    // 曲目/tab 跳走。返回 promise 供按钮等待扫描完成以复位「刷新中…」。
    function rescanLibrary() {
      return fetch('/dsh-music/rescan', {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
      }).then((r) => r.json()).then((result) => {
        if (result && result.ok) {
          set({
            root: result.root || null, bookRoot: result.bookRoot || null,
            tracks: result.tracks || [], books: result.books || [],
            playlists: result.playlists || [],
            count: result.count || 0, error: null,
            voices: Array.isArray(result.voices) ? result.voices : [],
            version: result.version || '', description: result.description || '',
            ttsConfigured: !!result.ttsConfigured, ttsReason: result.ttsReason || '',
            ttsProvider: result.ttsProvider || '',
            qqLoggedIn: !!result.qqLoggedIn, qqUin: result.qqUin || '', qqNickname: result.qqNickname || '', qqLoginFrom: result.qqLoginFrom || '',
            kgLoggedIn: !!result.kgLoggedIn,
            // 只同步弹窗内容，不重新触发自动弹窗（whatsNewAutoShown 一次性）。
            whatsNew: result.whatsNew || null,
            whatsNewHistory: Array.isArray(result.whatsNewHistory) ? result.whatsNewHistory : [],
            whatsNewWelcome: result.whatsNewWelcome || null,
            whatsNewState: result.whatsNewState || '',
          });
        } else {
          set({ error: (result && result.error) || '刷新失败' });
        }
      }).catch((err) => {
        set({ error: '刷新失败：' + String((err && err.message) || err) });
      });
    }

    function fmtTime(seconds) {
      if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
      // Books use a continuous book-wide clock that can pass an hour, so show
      // hours when present (e.g. "1:02:03"); music under an hour stays "m:ss".
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      const mm = h > 0 && m < 10 ? '0' + m : String(m);
      return h > 0 ? h + ':' + mm + ':' + (s < 10 ? '0' : '') + s : m + ':' + (s < 10 ? '0' : '') + s;
    }
    // Strip a trailing file extension from a display name ("song.mp3" -> "song",
    // "novel.txt" -> "novel"). Local music / AI 讲书 show the file name, so the
    // extension is noise; online QQ titles aren't file names and aren't stripped.
    function stripExt(name) {
      if (typeof name !== 'string' || name === '') return name;
      const m = /^(.*)\.([^.]+)$/.exec(name);
      return m ? m[1] : name;
    }
    // Adaptive file-size label for the playlist: MB when >= 1MiB, else KB.
    // Music and novels share this, so a large novel shows "1.6 MB" instead of
    // an unwieldy "1600 KB" and a tiny audio clip no longer reads "0 MB".
    function formatSize(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '';
      if (bytes >= 1024 * 1024) {
        const mb = bytes / 1024 / 1024;
        return (mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10) + ' MB';
      }
      return Math.round(bytes / 1024) + ' KB';
    }
    // 目录面包屑：把绝对路径渲染成逐个可点击的目录名，点击任一段即可直接跳到
    // 该目录；最后一段（当前目录）高亮展示、不可点击。crumbs 为空时回退显示
    // 目录名/路径纯文本（例如驱动列表或家目录未配置）。
    function renderCrumbs(crumbs, path, name, onGo) {
      if (!crumbs || crumbs.length === 0) {
        return React.createElement('span', { className: 'dsh-music-crumb-plain' }, name || path || '家目录');
      }
      const els = [];
      crumbs.forEach((c, i) => {
        if (i > 0) els.push(React.createElement('span', { key: 'sep' + i, className: 'dsh-music-crumb-sep' }, '\u203A'));
        const isLast = i === crumbs.length - 1;
        if (isLast) {
          els.push(React.createElement('span', { key: 'c' + i, className: 'dsh-music-crumb cur', title: c.path }, c.name));
        } else {
          els.push(React.createElement('button', {
            key: 'c' + i,
            className: 'dsh-music-crumb',
            title: c.path,
            onClick: () => onGo(c.path),
          }, c.name));
        }
      });
      return els;
    }
    function MusicNote(props) {
      const cls = props.className || '';
      return React.createElement('svg', { className: cls, width: 12, height: 12, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true },
        React.createElement('path', { d: 'M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z' }));
    }
    // 歌单卡片封面：有图显示图，无图显示音符占位块。酷狗「默认收藏」等系统默认歌单
    // 在云歌单接口（v7/get_all_list）里不返回 pic 封面字段，直接 <img src=""> 只会渲染
    // 一个空白方框（onError 后甚至整块消失）；「我喜欢」的爱心封面由酷狗后端内嵌返回，
    // 这里用音符占位兜底其余无封面场景，保证卡片始终有 56x56 封面视觉。
    function plCoverEl(item, cls = 'dsh-music-playlist-cover') {
      const cover = String((item && item.cover) || '').trim();
      if (cover) return React.createElement('img', { className: cls, src: cover, alt: '', loading: 'lazy', onError: (e) => { e.currentTarget.style.display = 'none'; } });
      return React.createElement('span', { className: cls + ' empty' }, React.createElement(MusicNote, { className: 'dsh-music-note' }));
    }
    // 讲书（AI 听书）时名称前的话筒图标，贴合「朗读/播讲」功能，
    // 与音乐的音符图标区分。
    function MicIcon(props) {
      const cls = props.className || '';
      return React.createElement('svg', { className: cls, width: 12, height: 12, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true },
        React.createElement('path', { d: 'M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z' }));
    }
    // 报纸图标（新闻播报模式的名称前缀，与音符/话筒同尺寸同色系）。
    function NewsIcon(props) {
      const cls = props.className || '';
      return React.createElement('svg', { className: cls, width: 12, height: 12, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true },
        React.createElement('path', { d: 'M4 5h13v14H5a2 2 0 0 1-2-2V5a1 1 0 0 1 1-1zm15 2h1a1 1 0 0 1 1 1v9.5a2.5 2.5 0 0 1-2.5 2.5H19V7zM6.5 8h8a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-2a.5.5 0 0 1 .5-.5zm.5 5h3v1.5H7V13zm4.5 0h3.5v1.5H11.5V13zM7 15.5h3V17H7v-1.5zm4.5 0h3.5V17H11.5v-1.5z' }));
    }
    // 播放控制图标（上一首/播放/暂停/下一首/停止）：用 SVG 替代 ⏮▶⏸⏭⏹ 文本字形。
    // 这些 Unicode 符号（尤其 ⏸ 常以 emoji 呈现）宽高/基线不一致，点击切换会让按钮
    // 大小与位置偏移；统一用同尺寸 viewBox=24 的 SVG，保证按钮恒定尺寸、图标精确居中。
    const iconSvg = (path, w = 16) => (props) => React.createElement('svg', { className: props.className || '', width: w, height: w, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true },
      React.createElement('path', { d: path }));
    const PlayIcon = iconSvg('M8 5v14l11-7z');
    const PauseIcon = iconSvg('M6 19h4V5H6v14zm8-14v14h4V5h-4z');
    const PrevIcon = iconSvg('M6 6h2v12H6zm3.5 6l8.5 6V6z');
    const NextIcon = iconSvg('M6 18l8.5-6L6 6v12zM16 6h2v12h-2z');
    const StopIcon = iconSvg('M6 6h12v12H6z');

    // ---- components ----
    // Custom vertical volume slider. The native <input type=range> cannot be
    // fully restyled in current Chrome (track keeps gray border lines and the
    // thumb ignores width/height once appearance:none is set), so the slider is
    // drawn with plain divs and driven by pointer events: click to jump, drag
    // the thumb to scrub. Value runs bottom (0) to top (1).
    function VolumeSlider() {
      const s = useStore();
      const trackRef = useRef(null);
      const draggingRef = useRef(false);
      const valueFor = (clientY) => {
        const el = trackRef.current;
        if (el === null) return s.volume;
        const r = el.getBoundingClientRect();
        if (r.height <= 0) return s.volume;
        const ratio = 1 - (clientY - r.top) / r.height;
        return Math.min(1, Math.max(0, ratio));
      };
      const onPointerDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        draggingRef.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        changeVolume(valueFor(e.clientY));
      };
      const onPointerMove = (e) => {
        if (!draggingRef.current) return;
        changeVolume(valueFor(e.clientY));
      };
      const onPointerUp = (e) => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      };
      const pct = Math.round(s.volume * 100);
      return React.createElement('div',
        { className: 'dsh-music-vol-slider', ref: trackRef,
          onPointerDown, onPointerMove, onPointerUp,
          title: '音量 ' + pct + '%' },
        React.createElement('div', { className: 'dsh-music-vol-track' }),
        React.createElement('div', { className: 'dsh-music-vol-fill', style: { height: pct + '%' } }),
        React.createElement('div', { className: 'dsh-music-vol-thumb', style: { bottom: 'calc(' + pct + '% - 7px)' } }),
      );
    }
    // Fallback voice list if /manifest hasn't delivered one (older host / offline).
    const FALLBACK_VOICES = [
      { id: '冰糖', label: '冰糖', gender: '女', lang: '中文' },
      { id: '茉莉', label: '茉莉', gender: '女', lang: '中文' },
      { id: '苏打', label: '苏打', gender: '男', lang: '中文' },
      { id: '白桦', label: '白桦', gender: '男', lang: '中文' },
    ];
    // AI 讲书 voice picker, shown in the volume popup only while reading a book.
    function VoicePicker() {
      const s = useStore();
      const voices = (s.voices && s.voices.length > 0) ? s.voices : FALLBACK_VOICES;
      const cur = voices.find((v) => v.id === s.voice);
      const currentLabel = cur ? (cur.label + (cur.gender && cur.gender !== '自动' ? '（' + cur.gender + '）' : '')) : s.voice;
      return React.createElement('div', { className: 'dsh-music-voice' },
        React.createElement('span', { className: 'dsh-music-voice-label' }, 'AI 声音'),
        React.createElement('select', {
          className: 'dsh-music-voice-select',
          value: voices.some((v) => v.id === s.voice) ? s.voice : '白桦',
          title: '当前：' + currentLabel,
          onChange: (e) => setVoice(e.target.value),
        },
          voices.map((v) => React.createElement('option', {
            key: v.id, value: v.id,
          }, (v.label || v.id) + (v.lang ? '·' + v.lang : '') + (v.gender && v.gender !== '自动' ? '（' + v.gender + '）' : ''))),
        ),
        s.voiceSwitching ? React.createElement('span', { className: 'dsh-music-voice-switching' }, '切换中…') : null,
      );
    }
    // Novel status shown after the title on the now-playing bar: a live
    // "AI 合成中… Ns" counter while a user-initiated chunk is being generated
    // (never a bare endless spinner), and on failure the real message plus a
    // retry button. Auto-advance between chunks is silent (bookBufferingSilent),
    // so only the initial click / explicit retry shows the counter.
    function BookStatus() {
      const s = useStore();
      const [now, setNow] = useState(Date.now());
      useEffect(() => {
        if (!s.bookBuffering) return;
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
      }, [s.bookBuffering]);
      if (s.bookBuffering && !s.bookBufferingSilent) {
        const secs = s.bookBufferingSince > 0 ? Math.floor((now - s.bookBufferingSince) / 1000) : 0;
        return React.createElement('span', { className: 'dsh-music-bar-buffering' },
          React.createElement('span', { className: 'dsh-music-spinner' }),
          ' AI 合成中… ' + secs + 's');
      }
      if (s.bookError) {
        return React.createElement('span', { className: 'dsh-music-bar-berr', title: s.bookError },
          React.createElement('span', { className: 'dsh-music-bar-berr-text' }, s.bookError),
          React.createElement('button', {
            className: 'dsh-music-bar-btn retry',
            title: '重新合成当前段落',
            onClick: retryBook,
          }, '重试'));
      }
      return null;
    }
    // ---- 播放条歌词/字幕（换行动效 + 跑马灯 + 边缘渐隐）----
    // 结构：outer(.dsh-music-bar-lyric，flex 定宽 + 裁剪 + 遮罩 + 溢出标记)
    //        └ run(跑马灯平移层；不溢出时静止)
    //            └ fx(key=seq，入场动画；data-prev 仅用于「首次挂载」的入场延迟判定，
    //               不承载退场——上一句随 fx 重挂即时消失，无退场动画)
    // 四种 fx：none=硬切(无 key 不重挂)；slide=上滑淡入；
    // blur=模糊浮入(Apple Music 风)；karaoke=扫色(整行渐变匀速点亮，走 lyricScan
    // 时间轴——QRC 提供精确行窗口，扫速即演唱速度)。
    // 跑马灯与边缘渐隐为内置行为（恒开，不是配置项）：超宽行自动滚动，两端渐隐。
    function BarLyric({ text, fx, playing, scan, src, onClick }) {
      const clipRef = useRef(null);
      const runRef = useRef(null);
      // 溢出测量（带行号标记）：run 实宽 − 可视宽。jsdom 无布局恒为 0 → 自动退化为
      // 静态居中，真浏览器由 ResizeObserver/resize 事件驱动重测。
      // mq 状态 = { seq: 本次测量对应的行号, px: 溢出量 }——跑马灯只在「测量属于当前行
      // 且溢出」时开启。换行后新句首帧 seq 不匹配 → 立即不带 mq，绝不会继承上一句的
      // --mq-over 平移（长句后的短句不再被滚动/跳位），等 effect 重测当前行后再按需开启。
      const [mq, setMq] = useState({ seq: -1, px: 0 });
      // 渲染期自缓存（官方推荐的 adjust-state-on-render 模式）：props 变化时把旧文本
      // 挪进 prev、seq 自增作为 remount key。幂等：StrictMode 二次渲染读取新缓存后
      // input === text，不再变更。
      const memoRef = useRef({ input: text, prev: '', seq: 0 });
      const memo = memoRef.current;
      if (memo.input !== text) { memo.prev = memo.input; memo.seq += 1; memo.input = text; }
      useEffect(() => {
        const measure = () => {
          const c = clipRef.current, r = runRef.current;
          if (!c || !r || typeof c.clientWidth !== 'number' || c.clientWidth <= 0) { setMq({ seq: memo.seq, px: 0 }); return; }
          // 用 run.clientWidth（元素自身盒子宽 = 当前文本宽）而非 scrollWidth：新句的
          // ::after 退场伪元素装着上一句文本（fx='slide'/'blur'），其内容溢出会撑大
          // scrollWidth → 短句被误判为溢出而错误跑马灯。clientWidth 不含伪元素溢出。
          const over = Math.ceil(Math.max(0, r.clientWidth - c.clientWidth));
          setMq((prev) => (prev.seq === memo.seq && Math.abs(prev.px - over) < 2 ? prev : { seq: memo.seq, px: over }));
        };
        measure();
        let ro = null;
        try { if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(measure); ro.observe(clipRef.current); } } catch {}
        window.addEventListener('resize', measure);
        return () => { if (ro) { try { ro.disconnect(); } catch {} } window.removeEventListener('resize', measure); };
      }, [text]);
      // 跑马灯仅在「测量属于当前行且有溢出」时开启；overPx 为当前行的溢出量。
      const mqOn = mq.seq === memo.seq && mq.px > 0;
      const overPx = mq.px;
      // 跑马灯速度约 30px/s，钳在 4..20s 一个来回，慢条斯理不打扰阅读。
      const runStyle = mqOn
        ? { '--mq-over': overPx + 'px', '--mq-dur': String(Math.min(20, Math.max(4, overPx / 30))) + 's' }
        : undefined;
      // 卡拉OK两种驱动模式：
      // ① 音频时钟（scan.baseT 存在 = QRC 行窗口）：不做 CSS 关键帧动画，位置由
      //    karPosPct 精确逆映射计算（elapsed/dur → background-position-x）——浏览器里
      //    karaokeFrame 每帧直写（帧级精度），React 渲染路径同步同一数值兜底；
      //    间奏期停在满亮。
      // ② 整行动画（普通 LRC 兜底）：维持原有 --kar-dur/--kar-delay 墙钟动画
      //    （没有逐行精确数据，两者精度等价）。
      const audioClock = fx === 'karaoke' && scan && Number.isFinite(scan.baseT) && Number(scan.dur) > 0;
      let karStyle;
      if (audioClock) {
        karStyle = { backgroundPositionX: karPosPct(Number(scan.elapsed) || 0, Number(scan.dur)).toFixed(2) + '%' };
      } else if (fx === 'karaoke' && scan && Number(scan.dur) > 0) {
        karStyle = { '--kar-dur': scan.dur + 'ms', '--kar-delay': (-Number(scan.elapsed) || 0) + 'ms' };
      }
      return React.createElement('span',
        {
          ref: clipRef,
          className: 'dsh-music-bar-lyric',
          title: text + '\n（单击打开歌词面板）',
          // 渐隐遮罩恒开；data-over 仅溢出时（信息性标记，测试断言 jsdom 无布局不误判）。
          // data-src：歌词来源（local/embedded/qq-qrc/qq/lrclib），DevTools 可直接确认来源。
          'data-mask': '1',
          'data-src': src || undefined,
          'data-over': mqOn ? '1' : undefined,
          onClick: onClick,
        },
        React.createElement('span', {
          ref: runRef,
          className: 'dsh-music-bar-lyric-run' + (mqOn ? ' mq' : '') + (playing ? '' : ' paused'),
          style: runStyle,
        },
        text === '' ? null : React.createElement('span', {
          key: fx === 'none' ? undefined : memo.seq,   // none 不重挂 = 原始硬切行为
          className: 'dsh-music-bar-lyric-fx' + (playing ? '' : ' fxfrozen'),
          // fxfrozen：暂停时冻结换行/扫色动画时钟（否则 CSS 动画按墙钟继续走，
          // 恢复播放后扫色位置会脱离音频进度）。切歌会重挂载重置，无需补偿。
          ref: (el) => { karScanNode = (audioClock && el) ? el : null; }, // 逐帧直写通道
          'data-fx': fx,
          'data-audioclock': audioClock ? '1' : undefined,
          'data-prev': (fx !== 'none' && memo.prev) || undefined,
          style: karStyle,
        }, text)));
    }

    function NowPlayingBar() {
      const s = useStore();
      const [volOpen, setVolOpen] = useState(false);
      const volRef = useRef(null);
      const volPopRef = useRef(null);
      const [barHover, setBarHover] = useState(false);
      // 滑出延迟：鼠标离开播放条后等 1s 再隐藏控制按钮，防止误移出导致按钮组收回。
      // 若在延迟内重新进入，取消定时器、保持展开。
      const hoverTimerRef = useRef(null);
      useEffect(() => () => { if (hoverTimerRef.current !== null) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; } }, []);
      const tocTriggerRef = useRef(null);
      useEffect(() => {
        if (!volOpen) return;
        // 点击外部关闭：目标在按钮容器内、或 portal 到 body 的弹窗内（弹窗已不在
        // 按钮容器的 DOM 子树上，需用 ref 单独判断，否则点击弹窗内部也会误关闭）。
        const onClick = (e) => {
          if (volRef.current !== null && volRef.current.contains(e.target)) return;
          if (volPopRef.current !== null && volPopRef.current.contains(e.target)) return;
          setVolOpen(false);
        };
        document.addEventListener('mousedown', onClick);
        return () => document.removeEventListener('mousedown', onClick);
      }, [volOpen]);
      const hasTrack = s.currentName !== null || s.pendingName !== null;
      const name = s.currentName || s.pendingName;
      const showHint = s.pendingName !== null && s.currentId === null;
      const panelCls = 'dsh-music-mode-trigger' + (s.panelOpen ? ' active' : '');
      // 频谱为实时捕获，失败即不显示（无离线回退），因此不渲染「不可用」徽标。
      const isQQTrack = s.currentId !== null && String(s.currentId).startsWith('qq:');
      const isBook = s.currentId !== null && String(s.currentId).startsWith('book:');
      // 新闻播报模式：期次以「虚拟书」形态复用讲书管线（currentId = book:news-…），
      // 在此仅做外观差异——报纸图标、名称行缀当前类别、目录按钮语义=类别目录。
      const isNews = isBook && currentBookId() !== null && String(currentBookId()).startsWith('news-');
      // 本地音乐/AI讲书：播放条显示的文件名去掉扩展名（如 .mp3、.txt）；在线 QQ 的
      // 歌名不是文件名，原样保留。
      const displayName = isQQTrack ? name : stripExt(name);
      // 名称前的图标：新闻用报纸图标，讲书用话筒图标，音乐用音符图标（空闲态无曲目 = 音乐）。
      const note = React.createElement(isNews ? NewsIcon : (isBook ? MicIcon : MusicNote), { className: 'dsh-music-note' });
      // While a novel chunk is being synthesized, show a live "合成中… Ns"
      // counter (so the wait is transparent, not an endless spinner) and, on
      // error, the real message plus a retry button. Music keeps its old UI.
      let afterName = null;
      if (isBook) afterName = React.createElement(BookStatus, null);
      // 讲书模式下不再用独立「章节徽标」占行：章节名像 QQ 音乐「歌名 - 歌手」那样，
      // 直接拼接在小说名后面（同一次要色、同一行），保持主信息紧凑可读。
      let chapterEl = null;
      if (isBook && s.currentSection) {
        chapterEl = React.createElement('span', { className: 'dsh-music-bar-artist' },
          '-',
          React.createElement('span', { className: 'dsh-music-bar-artist-name' }, s.currentSection));
      }
      // 音质徽章显示开关（系统配置「音质徽章显示」）：关闭时歌名后不再显示
      // 本地「格式 · 音质」标签与在线 QQ「QQ音乐 · 无损/高音质/标准」徽标。
      const showQuality = s.showQuality;
      // 音乐来源徽标：在线 QQ/酷狗 曲目在歌名后分别标「QQ音乐」「酷狗音乐」，
      // 取到「真实品质」时附加「 · 无损/高音质/标准」，取不到则只显示来源名。
      let sourceBadge = null;
      if (showQuality && s.currentId !== null) {
        const isQQ = String(s.currentId).startsWith('qq:');
        const isKG = String(s.currentId).startsWith('kg:');
        if (isQQ || isKG) {
          const q = (s.currentQuality || '').trim();
          const label = isQQ ? 'QQ音乐' : '酷狗音乐';
          const sub = isQQ ? '在线' : '在线';
          sourceBadge = React.createElement('span', { className: 'dsh-music-bar-src', title: q ? (label + '（' + sub + '）· ' + q) : label + '（' + sub + '）' },
            label + (q ? ' · ' + q : ''));
        }
      }
      // 本地音乐的「格式 · 音质」标签（如 FLAC · 无损 / MP3 · 高音质），与在线三档一致；
      // 解析不出（未知格式/不可读）则不显示。在线 QQ/酷狗 用上面的来源徽标，互不叠加。
      let localQualityBadge = null;
      if (showQuality && s.currentId !== null && !String(s.currentId).startsWith('qq:') && !String(s.currentId).startsWith('kg:') && !String(s.currentId).startsWith('book:') && s.currentQuality) {
        localQualityBadge = React.createElement('span', { className: 'dsh-music-bar-src', title: s.currentQuality }, s.currentQuality);
      }
      // 歌手名（在线歌曲有 artists；本地/讲书通常没有，则不显示）。
      const artistText = hasTrack ? (s.currentArtists || []).join(' / ') : '';
      const artistEl = artistText ? React.createElement('span', { className: 'dsh-music-bar-artist' },
        '-',
        React.createElement('span', { className: 'dsh-music-bar-artist-name' }, artistText)) : null;
      // 自建歌单：收藏爱心按钮（收藏时用主题色）。在线酷狗曲目收藏到酷狗「我喜欢」。
      const faved = hasTrack && !isBook && isCurrentFaved();
      const kgCur = hasTrack && String(s.currentId || '').startsWith('kg:');
      const favTitle = kgCur
        ? (faved ? '取消收藏（从酷狗「我喜欢」移除）' : '收藏到酷狗「我喜欢」')
        : (faved ? '取消收藏（从「我最喜欢」移除）' : '收藏到「我最喜欢」');
      const heartBtn = hasTrack && !isBook ? React.createElement('button', {
        className: 'dsh-music-bar-btn fav' + (faved ? ' on' : ''),
        title: favTitle,
        onClick: toggleFav,
      }, React.createElement('svg', {
        viewBox: '0 0 24 24', width: 16, height: 16,
        fill: faved ? 'currentColor' : 'none', stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': true,
      }, React.createElement('path', { d: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z' }))) : null;
      const showBarBtns = () => { if (hoverTimerRef.current !== null) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; } setBarHover(true); };
      // 单击名称区域打开面板：歌名/歌手/章节等附属信息都触发；唯独音质徽章
      // （.dsh-music-bar-src）不触发——它是纯信息展示，单击不应打开面板。
      const togglePanelOnName = (e) => {
        if (e && e.target && typeof e.target.closest === 'function' && e.target.closest('.dsh-music-bar-src')) return;
        togglePanel();
      };
      // 任一弹层打开时保持按钮展开（弹层 portal 到 body，鼠标可能在弹层上）。
      // 注意：barHover 只反映鼠标是否停留在右端控件区（.dsh-music-bar-controls）上；
      // 弹层打开期间由 anyPopOpen 让 .on 保持 true，弹层关闭后 .on 随 anyPopOpen
      // 立即收起，无需额外触发。
      const anyPopOpen = volOpen || s.modeMenuOpen || s.tocOpen;
      const hideBarBtns = () => {
        // 滑出延迟 1s：鼠标离开右端控件区后暂不收起按钮组；若延迟内重新进入则取消。
        if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = setTimeout(() => { hoverTimerRef.current = null; setBarHover(false); }, 1000);
      };
      const onBarLeave = () => hideBarBtns();
      // 热区离开：热区与按钮组是兄弟元素（鼠标从热区移到展开的按钮上会触发热区
      // mouseleave），此时若 relatedTarget 仍在按钮组内则保持展开，不安排收起。
      const leaveHotspot = (e) => {
        const rt = e && e.relatedTarget;
        if (rt && typeof rt.closest === 'function' && rt.closest('.dsh-music-bar-controls')) return;
        hideBarBtns();
      };
      // 播放条整体透明度：鼠标在右端控件区（或任一弹层打开）时完全不透明；离开 1s
      // 收起控件组的同时变半透明（50%），营造「后台静默播放」效果，不干扰用户其它工作。
      // 与控件组 .on 完全同源（barHover || anyPopOpen），保证两者同步变化。
      // 这些「闲置/工作态」交互（透明度、控件滑入滑出、时长显隐）只在有播放内容时生效；
      // 无内容（点击停止 / 插件刚安装）时恒定工作态：不透明度 100%、控件组展开，无任何特效。
      const active = barHover || anyPopOpen || !hasTrack;
      const barDimmed = !active;
      // 沉浸感由系统配置驱动：数值越大越「沉浸」（播放条越透明融入背景）。
      // 传给播放条的 opacity 是 1-immersee：沉浸 0% → 不透明(1)，沉浸 100% → 全透明(0)。
      const barStyle = { '--dsh-music-immerse': String(1 - s.immerse) };
      // 播放进度细线：音乐按 position/duration（单曲时长），讲书按「已读字符/全书字符」
      // 的 bookProgress——全书总时长在合成本书前不可知，用时长占比会切块回退，字符占比
      // 才稳定且只增不减。
      const progressPct = isBook
        ? Math.min(100, Math.max(0, s.bookProgress * 100))
        : ((hasTrack && s.duration > 0) ? Math.min(100, Math.max(0, (s.position / s.duration) * 100)) : 0);
      return React.createElement('div', { id: 'dsh-music-bar-wrap', className: 'dsh-music-bar-wrap' },
        React.createElement('div',
          { className: 'dsh-music-bar' + (isBook ? ' book' : '') + (barDimmed ? ' dimmed' : '') + (s.showBarBg ? '' : ' bare'), style: barStyle },
          hasTrack
            ? React.createElement('span', { className: 'dsh-music-bar-name', title: displayName + (artistText ? ' - ' + artistText : '') + (chapterEl ? ' - ' + s.currentSection : '') + '\n（单击打开播放列表）', onClick: togglePanelOnName },
                // 单击事件挂在名称容器上：歌名/歌手/章节等附属信息单击都打开面板；
                // togglePanelOnName 内部排除音质徽章（.dsh-music-bar-src）不触发。
                React.createElement('span', { className: 'dsh-music-bar-name-text' }, note, ' ', displayName),
                artistEl, sourceBadge, localQualityBadge, chapterEl, afterName)
            : React.createElement('span', { className: 'dsh-music-bar-idle', title: '双击打开播放列表', onDoubleClick: togglePanel }, note, ' DSH音乐播放器'),
          !isBook && hasTrack && s.playing && s.showViz ? React.createElement('canvas', { className: 'dsh-music-viz', width: 60, height: 20, ref: (el) => { barCanvasNode = el; } }) : null,
          // 歌词/字幕：位于频谱之后、时长之前；仅"非使用态"（控件组已折叠、播放条
          // 半透明）显示——正在操作时收起，不给滑入的按钮组让路。换行动效由系统配置
          // 驱动，跑马灯/边缘渐隐恒开（BarLyric 内部处理结构/CSS，textContent 恒为当前行）。
          s.lyricText && barDimmed && hasTrack && s.showLyric
            ? React.createElement(BarLyric, {
                text: s.lyricText, fx: s.lyricFx,
                playing: s.playing, scan: s.lyricScan,
                src: s.lyricSource,
                onClick: () => set({ lyricPanelOpen: !store.lyricPanelOpen }),
              })
            : null,
          // 时长 + 右侧控制按钮是一个组合：右对齐（margin-left:auto）。鼠标移入/移出
          // 播放条「右端部分区域」（.dsh-music-bar-hotspot，绝对定位覆盖右端）时按钮组
          // 才从右向左滑入/滑出，离开时按钮组折叠、时长也一并隐藏。整个播放条不再触发
          // ——只有移入右端热区才激活，大幅减少工作时的误触发。热区不占 flex 宽度，
          // 因此不会挤压中间的歌词/字幕。
          // 控件组自身只挂 onMouseLeave（展开态鼠标移出按钮组 → 收起）；进入由热区触发。
          React.createElement('div', { className: 'dsh-music-bar-controls' + (active ? ' on' : ''), onMouseLeave: onBarLeave },
            hasTrack
              ? (showHint
                  ? React.createElement('span', { className: 'dsh-music-bar-hint' }, '⚠ 自动播放被拦截，点击▶解锁')
                  : (isBook
                      ? (!barDimmed ? React.createElement('span', { className: 'dsh-music-bar-time' }, Math.round(s.bookProgress * 100) + '%') : null)
                      : (!barDimmed ? React.createElement('span', { className: 'dsh-music-bar-time' }, fmtTime(s.position) + ' / ' + fmtTime(s.duration)) : null)))
              : null,
            React.createElement('div', { className: 'dsh-music-bar-btns' },
              heartBtn,
              hasTrack ? React.createElement('button', { className: 'dsh-music-bar-btn', title: isBook ? '上一章' : '上一首', onClick: () => (isBook ? stepBook(-1) : step(-1)) }, React.createElement(PrevIcon, null)) : null,
              hasTrack ? React.createElement('button', { className: 'dsh-music-bar-btn', title: '播放/暂停', onClick: togglePlay }, React.createElement(s.playing ? PauseIcon : PlayIcon, null)) : null,
              hasTrack ? React.createElement('button', { className: 'dsh-music-bar-btn', title: isBook ? '下一章' : '下一首', onClick: () => (isBook ? stepBook(1) : step(1)) }, React.createElement(NextIcon, null)) : null,
              hasTrack ? React.createElement('button', { className: 'dsh-music-bar-btn', title: '停止', onClick: stop }, React.createElement(StopIcon, null)) : null,
              // 章节目录按钮：仅讲书（book）时出现，点击弹出章节列表并可跳章。
              // 与音量/播放模式按钮同款圆形样式（dsh-music-mode-trigger）。
              isBook ? React.createElement('div', { className: 'dsh-music-toc-trigger', ref: tocTriggerRef },
                React.createElement('button', {
                  className: 'dsh-music-mode-trigger' + (s.tocOpen ? ' active' : ''),
                  title: '章节目录',
                  onClick: openToc,
                }, React.createElement('svg', {
                  viewBox: '0 0 24 24', width: 16, height: 16, fill: 'currentColor', 'aria-hidden': true,
                }, React.createElement('path', { d: 'M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h10v2H4v-2z' }))),
                React.createElement(BookTocPanel, { anchorRef: tocTriggerRef }),
              ) : null,
              // 音乐播放模式按钮：仅在音乐语境（非讲书）显示，与章节目录按钮互斥。
              !isBook ? React.createElement(ModeDropdown, null) : null,
              React.createElement('div', { className: 'dsh-music-bar-vol', ref: volRef },
                React.createElement('button', {
                  className: 'dsh-music-mode-trigger' + (volOpen ? ' active' : ''),
                  title: '音量',
                  onClick: () => setVolOpen((o) => !o),
                }, React.createElement('svg', {
                  viewBox: '0 0 24 24', width: 16, height: 16, fill: 'currentColor', 'aria-hidden': true,
                }, React.createElement('path', { d: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z' }))),
              ),
              React.createElement('button', {
                className: panelCls,
                title: s.panelOpen ? '关闭播放列表' : '打开播放列表',
                onClick: togglePanel,
              }, React.createElement('svg', {
                viewBox: '0 0 24 24', width: 16, height: 16, fill: 'currentColor', 'aria-hidden': true,
              }, React.createElement('path', {
                d: 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z',
              }))),
            ),
          ),
          // 右端热区：绝对定位覆盖播放条右端（不占 flex 宽，不挤压歌词/字幕），承接
          // 鼠标移入/移出触发按钮组滑入/滑出。与控件组是兄弟元素，故离开时用
          // leaveHotspot 检查 relatedTarget 是否仍在按钮组内（防止移到按钮上误收起）。
          React.createElement('div', { className: 'dsh-music-bar-hotspot', onMouseEnter: showBarBtns, onMouseLeave: leaveHotspot }),
          // 音量弹层：portal 到 body + fixed 定位，锚定在音量按钮正上方。放在
          // .dsh-music-bar-btns（overflow:hidden 折叠容器）之外，避免被折叠裁剪。
          // 讲书模式弹窗为可变高度（AI 声音选择 + 音量滑块），用 anchorPopAbove
          // （bottom 锚定 + 高度限制），与章节目录一致，避免过高顶到视口被截断、
          // 底边脱离播放条；音乐模式是固定 108px 小弹窗，继续用 anchorAbove。
          volOpen ? portalToBody(React.createElement('div', {
            className: 'dsh-music-bar-vol-pop' + (isBook ? ' book' : ''),
            style: isBook ? anchorPopAbove(volRef.current, 136) : anchorAbove(volRef.current, 36),
            ref: volPopRef,
          },
            isBook ? React.createElement(VoicePicker, null) : null,
            React.createElement(VolumeSlider, null),
          )) : null,
          // 播放进度细线：绝对定位在播放条底部，与播放条等宽、高约 1px，随播放实时填充。
          // 音乐按单曲时长，讲书按「已读字符/全书字符」的 bookProgress（见 progressPct）。
          hasTrack && (isBook || s.duration > 0) && s.showProgress
            ? React.createElement('div', { className: 'dsh-music-bar-progress' },
                React.createElement('div', { className: 'dsh-music-bar-progress-fill', style: { width: progressPct + '%' } }))
            : null,
        ),
      );
    }
    // Playback-mode metadata + an icon-only dropdown. Icons are inline SVGs filled
    // with currentColor so they match the accent of the other round transport
    // buttons (green), which a native <select> cannot color.
    const MODES = [
      { id: 'single', label: '单曲循环', title: '单曲循环：播放结束重复当前曲目', d: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z' },
      { id: 'order', label: '顺序播放', title: '顺序播放：自动播放列表中的下一首', d: 'M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zm14-10v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z' },
      { id: 'shuffle', label: '乱序播放', title: '乱序播放：随机挑选下一首', d: 'M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z' },
    ];
    function ModeIcon(props) {
      return React.createElement('svg', {
        viewBox: '0 0 24 24', width: 16, height: 16, fill: 'currentColor', 'aria-hidden': true,
      }, React.createElement('path', { d: props.d }));
    }
    function ModeDropdown() {
      const s = useStore();
      const open = s.modeMenuOpen;
      const ref = useRef(null);
      const popRef = useRef(null);
      useEffect(() => {
        if (!open) return;
        // 点击外部关闭：目标在按钮容器内、或 portal 到 body 的弹窗内（弹窗已不在
        // 按钮容器的 DOM 子树上，需用 popRef 单独判断，否则点击弹窗内选项也会误关闭）。
        const onClick = (e) => {
          if (ref.current !== null && ref.current.contains(e.target)) return;
          if (popRef.current !== null && popRef.current.contains(e.target)) return;
          set({ modeMenuOpen: false });
        };
        document.addEventListener('mousedown', onClick);
        return () => document.removeEventListener('mousedown', onClick);
      }, [open]);
      const cur = MODES.find((m) => m.id === s.mode) || MODES[1];
      // Right-align the mode+volume+panel cluster when there is no track: during
      // playback the time span already carries margin-left:auto to push these
      // right, so only apply the auto margin when a name/pending name is absent.
      const barRight = s.currentName === null && s.pendingName === null;
      return React.createElement('div',
        { className: 'dsh-music-mode-menu' + (barRight ? ' right' : ''), ref },
        React.createElement('button', {
          className: 'dsh-music-mode-trigger' + (open ? ' active' : ''),
          title: cur.label,
          onClick: () => set({ modeMenuOpen: !open }),
        }, React.createElement(ModeIcon, { d: cur.d })),
        // 模式弹层 portal 到 body（fixed 定位，锚定按钮正上方）：按钮组在折叠
        // （overflow:hidden）容器内，弹层需逃逸才能不被裁剪。
        open ? portalToBody(React.createElement('div', { className: 'dsh-music-mode-pop', style: anchorAbove(ref.current, 120), ref: popRef },
          MODES.map((m) => React.createElement('button', {
            key: m.id,
            className: 'dsh-music-mode-item' + (s.mode === m.id ? ' active' : ''),
            title: m.title,
            onClick: () => { set({ mode: m.id, modeMenuOpen: false }); },
          }, React.createElement(ModeIcon, { d: m.d }))),
        )) : null,
      );
    }
    // 章节目录弹层：列出当前小说的 前言/章节/尾声 等，点击某节从该章开头播放。
    // ---- 每日新闻播报页签（NewsPane）----
    // 四层导航：期次列表（含定时状态行）→ 期次详情 → 文字版；另有定时规则编辑器。
    // 数据：GET /dsh-music/news（列表，存 store.newsEditions）、/<id>/meta（详情）、
    // /runstate + /schedule（状态行与编辑器，仅页签激活时 5s 轮询）。播放走
    // playNewsFrom（虚拟书桥接，见 playNewsFrom 处注释）。
    function NewsPane({ panelRef }) {
      const s = useStore();
      // view：{kind:'list'} | {kind:'detail',id} | {kind:'read',id} | {kind:'schedule'}
      const [view, setView] = useState({ kind: 'list' });
      const [meta, setMeta] = useState(null);        // 当前详情/文字版期次的 meta
      const [schedule, setSchedule] = useState(null); // { schedulePrefs, failures }
      const [running, setRunning] = useState(null);   // 当前收集运行态（null=空闲）
      const [form, setForm] = useState(null);         // 编辑器表单（保存前的工作副本）
      const [topicDraft, setTopicDraft] = useState(''); // 自定义主题输入框草稿
      const [models, setModels] = useState(null);        // 可选 provider/model（新闻采集模型选择器）
      const [shiftEditor, setShiftEditor] = useState(null); // 定时任务编辑弹窗：null=关闭；{index:number|null, draft} 打开（index null=新增）
      // 定时偏好自动保存（防抖）：编辑即落盘，替代手动「保存」按钮。
      // NewsPane 常驻挂载（面板/切页只切换 display、不卸载），离开定时视图时由
      // 下方 useEffect 冲刷防抖窗口内未提交的改动，保证编辑不丢。
      const saveTimerRef = useRef(null);
      const savePendingRef = useRef(null);

      // 首次挂载拉一次期次列表（此后播放/删除/保存会主动刷新）。
      useEffect(() => { void loadNewsEditions(); }, []);
      // 页签激活时轮询运行态与定时偏好/失败日志（5s；不激活不轮询，省请求）。
      // 状态行同时需要 schedule 数据（同步状态摘要 + 最近失败），因此一并刷新。
      useEffect(() => {
        if (s.tab !== 'news') return undefined;
        let stop = false;
        const tick = () => {
          if (stop) return;
          fetch('/dsh-music/news/runstate', { cache: 'no-store' }).then((r) => r.json()).then((d) => {
            if (!stop) setRunning(d && d.run ? d.run : null);
          }).catch(() => {});
          fetch('/dsh-music/news/schedule', { cache: 'no-store' }).then((r) => r.json()).then((d) => {
            if (!stop) setSchedule(d && d.ok ? d : null);
          }).catch(() => {});
        };
        tick();
        const timer = setInterval(tick, 5000);
        return () => { stop = true; clearInterval(timer); };
      }, [s.tab]);
      // 进入详情/文字版时拉取期次 meta（章节结构 + 条目）。
      useEffect(() => {
        if (view.kind !== 'detail' && view.kind !== 'read') { setMeta(null); return; }
        let stale = false;
        setMeta(null);
        fetch('/dsh-music/news/' + view.id + '/meta', { cache: 'no-store' })
          .then((r) => r.json())
          .then((m) => { if (!stale) setMeta(m && m.ok ? m : null); })
          .catch(() => {});
        return () => { stale = true; };
      }, [view.kind, view.id]);
      // 进入定时编辑器时拉取偏好 + 可选模型列表。
      useEffect(() => {
        if (view.kind !== 'schedule') return;
        fetch('/dsh-music/news/schedule', { cache: 'no-store' })
          .then((r) => r.json())
          .then((d) => { if (d && d.ok) { setSchedule(d); setForm(JSON.parse(JSON.stringify(d.schedulePrefs))); } })
          .catch(() => {});
        fetch('/dsh-music/news/models', { cache: 'no-store' })
          .then((r) => r.json())
          .then((d) => { if (d && d.ok) setModels(d.providers || null); })
          .catch(() => {});
      }, [view.kind]);

      const fmtTs = (ts) => {
        const d = new Date(ts);
        const pad = (n) => String(n).padStart(2, '0');
        const now = new Date();
        const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
        const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
        return sameDay ? '今天 · ' + hm : pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' · ' + hm;
      };
      const playingEditionId = () => {
        const cid = store.currentId;
        return (cid !== null && String(cid).startsWith('book:news-')) ? String(currentBookId()) : null;
      };
      const deleteEdition = (id) => {
        openConfirm('删除期次', '确定删除这一期新闻简报吗？', () => {
          fetch('/dsh-music/news/' + id, { method: 'DELETE' })
            .then(() => { if (playingEditionId() === id) stop(); void loadNewsEditions(); showToast('已删除', true); })
            .catch(() => showToast('删除失败', false));
        }, '删除', true);
      };
      const playFrom = (id, from) => playNewsFrom(id, from || 0);

      // ---- 定时编辑器辅助 ----
      // 范围摘要文本（手动执行指令用）：scope 必填；空/旧 null 范围兜底展示全部预设类别。
      const scopeSummaryText = (scope) => {
        const cats = (scope && scope.categories && scope.categories.length > 0) ? scope.categories : [];
        const topics = (scope && scope.topics) ? scope.topics : [];
        const parts = [];
        if (cats.length > 0) parts.push(cats.join('/'));
        if (topics.length > 0) parts.push('主题:' + topics.join(','));
        return parts.length > 0 ? parts.join('+') : PRESET_CATEGORIES.join('/');
      };
      const loadSchedule = () => fetch('/dsh-music/news/schedule', { cache: 'no-store' })
        .then((r) => r.json())
        .then((d) => { if (d && d.ok) setSchedule(d); })
        .catch(() => {});
      // 注：RSS 信源池无任何 UI（状态行/配置均不展示）——由 Host 在后台自动懒拉取使用，
      // 无需用户配置（默认内置 10 源、默认开启）。清除收集失败记录（失败提示行「✕」）：
      const clearFailures = () => {
        fetch('/dsh-music/news/failures/clear', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
        }).then((r) => r.json()).then((d) => {
          if (d && d.ok) {
            setSchedule((prev) => (prev ? { ...prev, failures: [] } : prev));
            showToast('已清除失败提示', true);
          } else showToast('清除失败', false);
        }).catch(() => showToast('清除失败', false));
      };
      // 静默落盘（无「已保存」toast，自动保存场景不需要提示；失败才提示）。
      const persistSchedule = (next) => {
        fetch('/dsh-music/news/schedule', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
        }).then((r) => r.json()).then((d) => {
          if (d && d.ok) setSchedule((prev) => ({ ...(prev || {}), schedulePrefs: d.schedulePrefs }));
          else showToast('保存失败', false);
        }).catch(() => showToast('保存失败', false));
      };
      // 编辑即防抖保存：500ms 静默提交（后续编辑会重置计时，只有停顿后才落盘）。
      const updateForm = (next) => {
        setForm(next);
        savePendingRef.current = next;
        if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
          saveTimerRef.current = null;
          const n = savePendingRef.current;
          savePendingRef.current = null;
          if (n !== null) persistSchedule(n);
        }, 500);
      };
      // 离开定时视图时冲刷防抖窗口内未提交的改动（如改完定时任务立刻点「返回」）。
      useEffect(() => {
        if (view.kind === 'schedule') return undefined;
        if (savePendingRef.current !== null) { persistSchedule(savePendingRef.current); savePendingRef.current = null; }
        if (saveTimerRef.current !== null) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
        return undefined;
      }, [view.kind]);
      // 组件卸载兜底冲刷（当前 NewsPane 常驻，防御性保留）。
      useEffect(() => () => {
        if (savePendingRef.current !== null) { persistSchedule(savePendingRef.current); savePendingRef.current = null; }
        if (saveTimerRef.current !== null) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
      }, []);
      const copyText = (text, okTip) => {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => {});
        showToast(okTip, true);
      };
      const runShiftNow = (shift) => {
        // 立即执行（自动）：注入执行指令，agent 立刻按该定时任务配置跑一轮；失败回退复制。
        fetch('/dsh-music/news/run-now', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shiftId: shift.id }),
        })
          .then((r) => r.json())
          .then((d) => {
            if (d && d.ok) showToast('已触发执行：agent 正在收集', true);
            else if (d && d.busy) showToast(d.error || '已有收集进行中，请等当前收集完成', false);
            else runShiftNowManual(shift);
          })
          .catch(() => runShiftNowManual(shift));
      };
      const runShiftNowManual = (shift) => {
        const scopeText = scopeSummaryText(shift.scope);
        const itemCount = (shift.itemCount === undefined || shift.itemCount === null) ? LIMITS_NEWS.itemCountDefault : shift.itemCount;
        const workdayNote = shift.workdaysOnly ? '（该定时任务为仅工作日执行：法定节假日除外、周末调休补班照常；手动触发不受限）' : '';
        const text = `立即执行我的 ${shift.time} 新闻定时任务：收集${scopeText}相关的头条（共 ${itemCount} 条，多类别时尽量平均分配），整理后用 news_broadcast 提交，收集完${shift.autoplay === false ? '先不播放（静默收集）' : '立即播放'}。${workdayNote}`;
        copyText(text, '执行指令已复制，发送给 agent 即执行');
      };
      // 定时任务卡片/弹窗：范围摘要（scope 必填；旧 null/空范围兜底按全部预设类别展示）。
      const shiftScopeLabel = (sh) => {
        const scope = sh && sh.scope;
        const cats = (scope && scope.categories && scope.categories.length > 0) ? scope.categories : [];
        const topics = (scope && scope.topics) ? scope.topics : [];
        if (cats.length === 0 && topics.length === 0) return PRESET_CATEGORIES.join('/');
        const catText = cats.length > 0 ? cats.join('/') : '';
        const topicText = topics.length > 0 ? '主题:' + topics.join(',') : '';
        return [catText, topicText].filter(Boolean).join('+');
      };
      // 打开定时任务编辑弹窗：index=null 表示新增，否则编辑第 index 个定时任务（深拷贝工作副本）。
      const openShiftEditor = (index) => {
        const p = form || (schedule && schedule.schedulePrefs) || null;
        if (p === null) return;
        const existing = (index === null || index === undefined) ? null : (p.shifts || [])[index];
        setTopicDraft('');
        setShiftEditor(existing === undefined || existing === null
          ? { index: null, draft: { id: 's' + Math.random().toString(36).slice(2, 8), time: '08:00', autoplay: true, workdaysOnly: false, itemCount: LIMITS_NEWS.itemCountDefault, scope: { categories: [], topics: [] } } }
          : { index, draft: { ...existing, itemCount: existing.itemCount === undefined || existing.itemCount === null ? LIMITS_NEWS.itemCountDefault : existing.itemCount, scope: existing.scope ? JSON.parse(JSON.stringify(existing.scope)) : { categories: PRESET_CATEGORIES.slice(), topics: [] } } });
      };

      // ---- 渲染：期次列表行 ----
      const editionRows = (s.newsEditions || []).map((e) => {
        const chips = (e.categories || []).map((c) => c.name + ' ' + c.count).join(' · ');
        const playing = playingEditionId() === e.id;
        // 卡片式期次条目：两行布局（标题行含待播/正在播徽标，元信息行含时间与类别 chips），
        // 点击卡片任意位置进详情；卡片内 ▶/🗑 按钮 stopPropagation，避免误触导航。
        return React.createElement('div', {
          key: e.id, className: 'dsh-music-news-card' + (playing ? ' current' : ''),
          style: { cursor: 'pointer' },
          onClick: () => setView({ kind: 'detail', id: e.id }),
        },
          React.createElement('div', { className: 'dsh-music-news-card-main', title: e.title },
            React.createElement('div', { className: 'dsh-music-news-card-title' },
              playing ? React.createElement('span', { className: 'dsh-music-news-card-badge live' }, '正在播')
                : (!e.played ? React.createElement('span', { className: 'dsh-music-news-card-badge' }, '待播') : null),
              React.createElement('span', { className: 'dsh-music-news-card-name' }, e.title),
            ),
            React.createElement('div', { className: 'dsh-music-news-card-meta' },
              fmtTs(e.createdAt) + (chips ? ' · ' + chips : '')),
          ),
          React.createElement('div', { className: 'dsh-music-news-card-actions' },
            React.createElement('button', { className: 'dsh-music-settings-btn', title: '播放整期', onClick: (ev) => { ev.stopPropagation(); playFrom(e.id, 0); } }, '▶'),
            React.createElement('button', {
              className: 'dsh-music-icon-btn', title: '删除',
              onClick: (ev) => { ev.stopPropagation(); deleteEdition(e.id); },
            }, '🗑'),
          ),
        );
      });

      // ---- 渲染：定时状态行 + 列表层 ----
      const scheduleStatus = (() => {
        if (schedule === null) return '';
        const p = schedule.schedulePrefs || {};
        if (!p.enabled) return '已停用';
        if (!p.shifts || p.shifts.length === 0) return '未设置 · 点击配置';
        return p.shifts.length + ' 个定时任务';
      })();
      const lastFailure = (schedule && Array.isArray(schedule.failures) && schedule.failures.length > 0)
        ? schedule.failures[schedule.failures.length - 1] : null;
      // 执行中标签：显示定时任务触发时刻（如「08:00 定时任务」）而非内部随机 id——对用户那是乱码
      const runningLabel = (() => {
        if (!running) return '';
        if (!running.shiftId) return '手动 收集中…';
        const sh = (schedule && schedule.schedulePrefs && schedule.schedulePrefs.shifts || [])
          .find((x) => x.id === running.shiftId);
        return (sh ? sh.time + ' 定时任务' : '定时任务') + ' 收集中…';
      })();
      const statusLine = React.createElement('div', { className: 'dsh-music-subtabs', style: { marginBottom: 4, flexWrap: 'nowrap' } },
        React.createElement('button', {
          className: 'dsh-music-subtab',
          title: '定时规则：' + scheduleStatus,
          style: { textAlign: 'left', flex: '1', minWidth: 0, maxWidth: 'none', overflow: 'hidden', textOverflow: 'ellipsis' },
          onClick: () => setView({ kind: 'schedule' }),
        },
          '⏰ 每日定时　' + scheduleStatus + (runningLabel ? '　·　' + runningLabel : '')),
      );
      const failureLine = lastFailure !== null
        ? React.createElement('div', { className: 'dsh-music-news-failure' },
            React.createElement('span', { className: 'dsh-music-news-failure-text' },
              '⚠ ' + fmtTs(lastFailure.ts) + ' 收集' + (lastFailure.kind === 'empty' ? '无结果' : '失败') + (lastFailure.reason ? ' · ' + lastFailure.reason : '')),
            React.createElement('button', {
              className: 'dsh-music-news-failure-close', title: '清除失败提示',
              onClick: clearFailures,
            }, '✕'))
        : null;

      const listBody = React.createElement('div', { className: 'dsh-music-news-card-list' },
        (s.newsEditions || []).length > 0 ? editionRows
          : React.createElement('div', { className: 'dsh-music-empty' },
            '还没有新闻简报。\n在对话框对我说「播报今天的新闻」即可生成；\n也可以说「每天早上 9 点播报新闻」设置每日定时。'),
      );

      // ---- 渲染：期次详情层 ----
      const metaView = (readOnly) => {
        if (meta === null) return React.createElement('div', { className: 'dsh-music-empty' }, '加载中…');
        const id = meta.id;
        let seq = 0;
        const sections = (meta.sections || []).map((sec, si) => {
          const rows = (meta.categories ? meta.categories[si].items : []).map((it) => {
            seq += 1;
            const chunk = (meta.itemChunk || [])[seq - 1] || 0;
            // 文字版（readOnly）：文章排版——标题段 + 完整摘要段 + 来源行；不截断、无 ▶。
            if (readOnly) {
              return React.createElement('div', { key: seq, style: { marginBottom: 10 } },
                React.createElement('div', { style: { fontWeight: 600, marginBottom: 2 } }, seq + '. ' + it.title),
                React.createElement('div', { style: { marginBottom: 2 } }, it.summary),
                React.createElement('div', { className: 'dsh-music-track-size' },
                  '—— ' + (it.source || '来源未知') + (it.publishedAt ? ' · ' + it.publishedAt : '')),
              );
            }
            return React.createElement('div', { key: seq, className: 'dsh-music-track' },
              React.createElement('div', {
                className: 'dsh-music-track-main', style: { cursor: 'pointer', flex: '1', minWidth: 0 },
                title: it.summary,
                onClick: () => { if (!readOnly) playFrom(id, chunk); },
              },
                React.createElement('span', { className: 'dsh-music-track-name' }, seq + '. ' + it.title),
                React.createElement('span', { className: 'dsh-music-track-size' }, (it.source || '来源未知') + (it.publishedAt ? ' · ' + it.publishedAt : '') + ' · ' + it.summary),
              ),
              readOnly ? null : React.createElement('button', { className: 'dsh-music-settings-btn', title: '从这条开始播', onClick: () => playFrom(id, chunk) }, '▶'),
            );
          });
          return React.createElement('div', { key: si },
            React.createElement('div', { style: { fontWeight: 600, margin: '8px 0 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
              React.createElement('span', null, sec.heading + '（' + sec.itemCount + '）'),
              readOnly ? null : React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: () => playFrom(id, sec.fromChunk) }, '▶'),
            ),
            rows,
          );
        });
        return React.createElement('div', null,
          React.createElement('div', { className: 'dsh-music-track-size', style: { marginBottom: 6 } },
            meta.date + ' · 共 ' + (meta.itemChunk || []).length + ' 条 · 全文 ' + meta.totalChars + ' 字'
            + (readOnly ? ' · 约 ' + Math.max(1, Math.ceil(meta.totalChars / 260)) + ' 分钟' : '')),
          sections,
          readOnly ? React.createElement('div', { className: 'dsh-music-track-size', style: { marginTop: 10, borderTop: '1px solid rgba(128,128,128,0.2)', paddingTop: 6 } },
            '由 AI 自动收集整理，内容以来源报道为准，请自行甄别。') : null,
        );
      };

      const headBar = (title, backView) => React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
        React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: () => setView(backView) }, '← 返回'),
        React.createElement('span', { style: { fontWeight: 600, flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, title),
      );

      let body = null;
      if (view.kind === 'detail' || view.kind === 'read') {
        const readOnly = view.kind === 'read';
        const edition = newsById(view.id) || {};
        // 头部（返回/标题/操作按钮）固定，仅下方新闻内容列表纵向滚动。
        body = React.createElement('div', { className: 'dsh-music-news-pane-inner' },
          React.createElement('div', { className: 'dsh-music-news-head' },
            headBar(edition.title || '期次详情', { kind: 'list' }),
            React.createElement('div', { style: { display: 'flex', gap: 8, marginBottom: 6 } },
              readOnly ? null : React.createElement('button', { className: 'dsh-music-settings-btn', onClick: () => playFrom(view.id, 0) }, '▶ 播放整期'),
              React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: () => setView(readOnly ? { kind: 'detail', id: view.id } : { kind: 'read', id: view.id }) }, readOnly ? '◀ 条目视图' : '文字版'),
              readOnly ? null : React.createElement('button', { className: 'dsh-music-settings-btn ghost', style: { color: '#c0392b' }, onClick: () => deleteEdition(view.id) }, '删除'),
            ),
          ),
          React.createElement('div', { className: 'dsh-music-news-body' }, metaView(readOnly)),
        );
      } else if (view.kind === 'schedule') {
        // ---- 定时规则编辑器 ----
        const pRaw = form || (schedule && schedule.schedulePrefs) || null;
        if (pRaw === null) {
          body = React.createElement('div', { className: 'dsh-music-news-pane-inner' },
            React.createElement('div', { className: 'dsh-music-news-head' }, headBar('每日定时规则', { kind: 'list' })),
            React.createElement('div', { className: 'dsh-music-news-body' }, React.createElement('div', { className: 'dsh-music-empty' }, '加载中…')),
          );
        } else {
          // 展示与编辑共用一份「按触发时刻升序」的定时任务副本（HH:MM 字典序即时间序）：
          // 先建 12:00 再建 09:00 时，列表仍按时刻从早到晚排列；排序副本上的编辑
          // （增删改）会随 updateForm 整体落盘，服务端 sanitize 也做同一归一化。
          const p = { ...pRaw, shifts: [...(pRaw.shifts || [])].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0)) };
          const shiftCount = (p.shifts || []).length;
          // 定时任务卡片列表：时间 / 类别摘要 / 新闻条数 / 立即播放开关 / 操作按钮（立即执行·编辑·删除）。
          const shiftCards = (p.shifts || []).map((sh, i) => {
            const setShift = (patch) => {
              const shifts = p.shifts.slice();
              shifts[i] = { ...sh, ...patch };
              updateForm({ ...p, shifts });
            };
            const cardItemCount = (sh.itemCount === undefined || sh.itemCount === null) ? LIMITS_NEWS.itemCountDefault : sh.itemCount;
            return React.createElement('div', { key: sh.id, className: 'dsh-music-news-shift-card' },
              React.createElement('span', { className: 'dsh-music-news-shift-time' }, sh.time),
              sh.workdaysOnly ? React.createElement('span', { className: 'dsh-music-news-shift-badge', title: '仅工作日执行：周一至周五扣除法定节假日、周末调休补班照常；节假日数据自动联网更新，无需手工维护' }, '工作日') : null,
              React.createElement('span', { className: 'dsh-music-news-shift-scope', title: shiftScopeLabel(sh) + (sh.workdaysOnly ? '（仅工作日执行）' : '') },
                shiftScopeLabel(sh) + ' · ' + cardItemCount + ' 条'),
              React.createElement('div', { className: 'dsh-music-news-shift-actions' },
                React.createElement('label', { className: 'dsh-music-news-shift-toggle', title: '收集后立即播放' },
                  React.createElement('input', { type: 'checkbox', checked: sh.autoplay !== false, onChange: (e) => setShift({ autoplay: e.target.checked }) }),
                  '立即播放',
                ),
                React.createElement('button', {
                  className: 'dsh-music-settings-btn ghost',
                  title: running ? '收集进行中，请稍候' : '立即执行该定时任务',
                  disabled: Boolean(running),
                  onClick: () => runShiftNow(sh),
                }, running ? '⟳' : '▶'),
                React.createElement('button', { className: 'dsh-music-settings-btn ghost', title: '编辑定时任务', onClick: () => openShiftEditor(i) }, '✎'),
                React.createElement('button', { className: 'dsh-music-icon-btn', title: '删除定时任务', onClick: () => updateForm({ ...p, shifts: p.shifts.filter((x) => x.id !== sh.id) }) }, '🗑'),
              ),
            );
          });
          const shiftList = shiftCount > 0
            ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, margin: '2px 0 8px' } }, shiftCards)
            : React.createElement('div', { className: 'dsh-music-news-shift-empty', style: { marginBottom: 8 } }, '还没有定时任务，点击上方「＋ 添加定时任务」设置每日定时。');
          // 新闻采集模型选择器（每次执行新建的执行会话用）：不选 = 跟随当前活跃会话模型。
          const modelRow = models !== null && models.length > 0 ? (() => {
            const sel = p.model || {};
            const curProvider = models.find((x) => x.id === sel.provider) || null;
            const modelsFor = curProvider ? (curProvider.models || []) : [];
            return React.createElement('div', { style: { margin: '4px 0 10px' } },
              React.createElement('div', { style: { fontWeight: 600, marginBottom: 4 } }, '新闻采集模型'),
              React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                React.createElement('select', {
                  value: sel.provider || '',
                  onChange: (e) => {
                    const pid = e.target.value;
                    const prov = models.find((x) => x.id === pid);
                    const first = prov && prov.models && prov.models[0];
                    updateForm({ ...p, model: pid === '' ? null : { provider: pid, model: first ? first.id : '' } });
                  },
                  style: { padding: '2px 6px' },
                },
                  React.createElement('option', { value: '' }, '跟随当前会话'),
                  models.map((pr) => React.createElement('option', { key: pr.id, value: pr.id }, pr.name)),
                ),
                curProvider ? React.createElement('select', {
                  value: sel.model || '',
                  onChange: (e) => updateForm({ ...p, model: { provider: curProvider.id, model: e.target.value } }),
                  style: { padding: '2px 6px' },
                },
                  modelsFor.map((m) => React.createElement('option', { key: m.id, value: m.id }, m.name)),
                ) : null,
              ),
            );
          })() : null;
          // 定时任务编辑弹窗（新增/编辑都走这里；portal 到 body，以面板中心为基准居中）。
          const shiftModal = shiftEditor !== null ? (() => {
            const d = shiftEditor.draft;
            const isNew = shiftEditor.index === null;
            const setDraft = (patch) => setShiftEditor({ ...shiftEditor, draft: { ...d, ...patch } });
            const setDraftScope = (patch) => {
              const base = d.scope || { categories: PRESET_CATEGORIES.slice(), topics: [] };
              setDraft({ scope: { ...base, ...patch } });
            };
            // 范围必填校验：至少选中一个类别或添加一个主题，否则禁用保存。
            // 输入框里有未回车的主题也算数——输入即生效，不必先按回车。
            const draftTopic = topicDraft.trim();
            const scopeFilled = Boolean(d.scope
              && ((d.scope.categories && d.scope.categories.length > 0)
                || (d.scope.topics && d.scope.topics.length > 0)
                || draftTopic !== ''));
            const commit = () => {
              // 未回车的主题在保存时一并收进范围（去重、限量）；回车只是「立即转为 chip」的快捷方式。
              let draft = d;
              const cur = (d.scope && d.scope.topics) || [];
              if (draftTopic !== '' && d.scope && !cur.includes(draftTopic) && cur.length < LIMITS_NEWS.topicsPerShift) {
                draft = { ...d, scope: { ...d.scope, topics: cur.concat(draftTopic) } };
              }
              const shifts = (p.shifts || []).slice();
              if (isNew) {
                if (shifts.length >= LIMITS_NEWS.shifts) { setShiftEditor(null); return; }
                shifts.push(draft);
              } else {
                shifts[shiftEditor.index] = draft;
              }
              updateForm({ ...p, shifts });
              setShiftEditor(null);
            };
            const onKeyDown = (e) => {
              if (e.key === 'Escape') { e.preventDefault(); setShiftEditor(null); }
            };
            const scopeCats = (d.scope && d.scope.categories) || [];
            const topics = (d.scope && d.scope.topics) || [];
            return portalToBody(React.createElement('div', {
              className: 'dsh-music-picker-overlay',
              onClick: (e) => { if (e.target === e.currentTarget) setShiftEditor(null); },
            },
              React.createElement('div', { className: 'dsh-music-picker dsh-music-news-shift-modal', style: panelCenterStyle(panelRef, true, 190, 560), onKeyDown },
                React.createElement('div', { className: 'dsh-music-picker-head' },
                  React.createElement('span', { className: 'dsh-music-picker-title' }, isNew ? '添加定时任务' : '编辑定时任务'),
                  React.createElement('button', { className: 'dsh-music-icon-btn', title: '关闭', onClick: () => setShiftEditor(null) }, '✕')),
                React.createElement('div', { className: 'dsh-music-news-field' },
                  React.createElement('div', { className: 'dsh-music-news-field-label' }, '触发时刻'),
                  React.createElement('input', {
                    className: 'dsh-music-news-time-input', type: 'time', value: d.time,
                    onChange: (e) => { if (/^([01]\d|2[0-3]):[0-5]\d$/.test(e.target.value)) setDraft({ time: e.target.value }); },
                  }),
                ),
                React.createElement('div', { className: 'dsh-music-news-field' },
                  React.createElement('div', { className: 'dsh-music-news-field-label' }, '新闻条数'),
                  React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                    React.createElement('input', {
                      type: 'number', min: LIMITS_NEWS.itemCountMin, max: LIMITS_NEWS.itemCountMax, step: 1,
                      value: d.itemCount, className: 'dsh-music-news-time-input',
                      style: { width: 64 },
                      onChange: (e) => {
                        const raw = e.target.value;
                        let v = raw === '' ? LIMITS_NEWS.itemCountDefault : Number(raw);
                        if (!Number.isFinite(v)) v = LIMITS_NEWS.itemCountDefault;
                        v = Math.round(v);
                        v = Math.max(LIMITS_NEWS.itemCountMin, Math.min(LIMITS_NEWS.itemCountMax, v));
                        setDraft({ itemCount: v });
                      },
                    }),
                    React.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #8a8f98)' } },
                      '条（1-' + LIMITS_NEWS.itemCountMax + '，默认 ' + LIMITS_NEWS.itemCountDefault + '；多类别时尽量平均分配）'),
                  ),
                ),
                React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' } },
                  React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12 } },
                    React.createElement('input', { type: 'checkbox', checked: d.autoplay !== false, onChange: (e) => setDraft({ autoplay: e.target.checked }) }),
                    '收集后立即播放',
                  ),
                  React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12 }, title: '工作日 = 周一至周五扣除法定节假日，周末调休补班视为工作日照常执行；节假日数据自动联网更新（离线回退内置日历），手动「立即执行」不受限' },
                    React.createElement('input', { type: 'checkbox', checked: d.workdaysOnly === true, onChange: (e) => setDraft({ workdaysOnly: e.target.checked }) }),
                    '仅工作日执行（节假日除外）',
                  ),
                ),
                React.createElement('div', { className: 'dsh-music-news-field' },
                  React.createElement('div', { className: 'dsh-music-news-field-label' }, '收集范围类别'),
                  React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
                    PRESET_CATEGORIES.map((c) => React.createElement('button', {
                      key: c, className: 'dsh-music-subtab' + (scopeCats.includes(c) ? ' active' : ''),
                      style: { padding: '2px 8px' },
                      onClick: () => {
                        const cur = scopeCats;
                        setDraftScope({ categories: cur.includes(c) ? cur.filter((x) => x !== c) : cur.concat(c) });
                      },
                    }, c)),
                  ),
                ),
                React.createElement('div', { className: 'dsh-music-news-field' },
                  React.createElement('div', { className: 'dsh-music-news-field-label' }, '自定义主题（可选）'),
                  React.createElement('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 } },
                    topics.map((t) => React.createElement('button', {
                      key: t, className: 'dsh-music-subtab active', style: { padding: '2px 8px' },
                      onClick: () => setDraftScope({ topics: topics.filter((x) => x !== t) }),
                      title: '点击移除',
                    }, t + ' ✕')),
                    topics.length < LIMITS_NEWS.topicsPerShift ? React.createElement('input', {
                      value: topicDraft, placeholder: '如 AI、新能源汽车', className: 'dsh-music-news-time-input',
                      style: { width: 130 },
                      onChange: (e) => setTopicDraft(e.target.value),
                      onKeyDown: (e) => {
                        if (e.key === 'Enter' && topicDraft.trim() !== '') {
                          setDraftScope({ topics: topics.concat(topicDraft.trim()) });
                          setTopicDraft('');
                        }
                      },
                    }) : null,
                  ),
                ),
                React.createElement('div', { className: 'dsh-music-picker-foot' },
                  React.createElement('button', {
                    className: 'dsh-music-settings-btn', onClick: commit,
                    disabled: (isNew && shiftCount >= LIMITS_NEWS.shifts) || !scopeFilled,
                  }, isNew ? '添加' : '保存'),
                  React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: () => setShiftEditor(null) }, '取消'),
                ),
              ),
            ));
          })() : null;
          body = React.createElement('div', { className: 'dsh-music-news-pane-inner' },
            React.createElement('div', { className: 'dsh-music-news-head' }, headBar('每日定时规则', { kind: 'list' })),
            React.createElement('div', { className: 'dsh-music-news-body' },
              React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 6, margin: '4px 0 10px', cursor: 'pointer' } },
                React.createElement('input', { type: 'checkbox', checked: p.enabled !== false, onChange: (e) => updateForm({ ...p, enabled: e.target.checked }) }),
                '启用每日定时',
              ),
              modelRow,
              React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '2px 0 6px' } },
                React.createElement('div', { style: { fontWeight: 600 } }, '定时任务（每天按以下时刻触发）'),
                React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: () => openShiftEditor(null), disabled: shiftCount >= LIMITS_NEWS.shifts }, '＋ 添加定时任务'),
              ),
              shiftList,
              shiftModal,
            ),
          );
        }
      } else {
        // 工具栏（定时状态行 + 最近失败）固定在滚动区外：滚动条从卡片列表顶部开始、
        // 与卡片对齐；工具栏与卡片列表之间有明确的分隔（间距 + 分隔线）。
        body = React.createElement('div', { className: 'dsh-music-news-pane-inner' },
          React.createElement('div', { className: 'dsh-music-news-toolbar' }, statusLine, failureLine),
          React.createElement('div', { className: 'dsh-music-news-body' }, listBody),
        );
      }

      return body;
    }
    // 章节目录弹层（新闻播报复用同一组件：sections=类别，heading=类别名）。
    function BookTocPanel({ anchorRef }) {
      const s = useStore();
      const ref = useRef(null);
      const listRef = useRef(null);
      useEffect(() => {
        if (!s.tocOpen) return;
        const onDown = (e) => {
          if (ref.current !== null && !ref.current.contains(e.target)) closeToc();
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
      }, [s.tocOpen]);
      // 打开章节目录时定位到正在播放的章节：把高亮的当前章节滚动进可视区，
      // 而不是从列表顶部开始。依赖 bookToc（打开时可能先为空、随后异步到达）。
      useEffect(() => {
        if (!s.tocOpen) return;
        const list = listRef.current;
        if (list === null) return;
        const active = list.querySelector('.dsh-music-toc-item.active');
        if (active !== null && typeof active.scrollIntoView === 'function') active.scrollIntoView({ block: 'nearest' });
      }, [s.tocOpen, s.bookToc]);
      if (!s.tocOpen) return null;
      if (s.currentId === null || !String(s.currentId).startsWith('book:')) return null;
      const id = currentBookId();
      const rows = (s.bookToc || []).map((sec, i) => {
        const active = sec.heading === s.currentSection && sec.heading !== '';
        const label = sectionTypeLabel(sec.type);
        return React.createElement('button', {
          key: i,
          className: 'dsh-music-toc-item' + (active ? ' active' : ''),
          title: sec.heading,
          // Same double-click guard as the track/book rows: the second click of a
          // dblclick must not re-start the chapter (which would re-synthesize the
          // same chunk and visibly restart it).
          onClick: (e) => {
            if (e.detail >= 2) return;
            if (id !== null) playBook(id, sec.fromChunk);
            closeToc();
          },
        },
          React.createElement('span', { className: 'dsh-music-toc-type' }, label),
          React.createElement('span', { className: 'dsh-music-toc-heading' }, sec.heading),
        );
      });
      const body = (s.bookToc || []).length > 0
        ? rows
        : React.createElement('div', { className: 'dsh-music-empty' }, '暂无章节结构（该书无法识别分节。）');
      // 弹层 portal 到 body + fixed 定位，锚定在「章节目录」按钮正上方：
      // 按钮组在折叠（overflow:hidden）容器内，弹层需逃逸才能不被裁剪。
      // 用 anchorPopAbove（bottom 锚定 + 高度限制），避免章节多时弹窗过高顶到
      // 视口顶被截断、底边脱离播放条——与音量/播放顺序弹窗保持一致的紧贴效果。
      return portalToBody(React.createElement('div', { className: 'dsh-music-toc', ref, style: anchorPopAbove(anchorRef ? anchorRef.current : null) },
        React.createElement('div', { className: 'dsh-music-toc-head' },
          React.createElement('span', { className: 'dsh-music-toc-title' }, '章节目录'),
          React.createElement('button', { className: 'dsh-music-icon-btn', title: '关闭', onClick: closeToc }, '✕')),
        React.createElement('div', { className: 'dsh-music-toc-list', ref: listRef }, body),
      ));
    }
    // ---- 在线 QQ 音乐：扫码登录 + 搜索 + 播放（登录后可播 VIP/高音质） ----
    // 播放一首 QQ 在线歌曲（单曲搜索与歌单详情共用）；代理为同源流，走频谱解码。
    // queue：可选，当前来源的歌单/搜索结果，用于播完自动接下一首；不传则只播这一首。
    // 播放一首 QQ 在线歌曲（搜索/歌单/工具共用）；代理为同源流，走频谱解码。
    // queue：当前来源队列（搜索结果或歌单歌曲），播完自动接下一首；sourceLabel：队列来源名。
    // 用轻量 HEAD 探测「真实品质」：不等整首音频流下载完再读（无损歌几十 MB 会
    // 拖慢几秒），通过 /dsh-music/qq/play 的响应头立即读取。
    // 响应头——无损歌一首几十 MB，整首下完标签才出现会很慢。HEAD 只取响应头（取链结果
    // 被 Host 缓存、与音频流同档位），歌曲一开始即可显示品质。
    function loadQQQuality(id, url) {
      fetch(url, { method: 'HEAD', cache: 'no-store' }).then((r) => {
        if (store.currentId !== 'qq:' + id) return; // 响应返回时已切歌 → 丢弃
        const hdrs = r && r.headers;
        if (!hdrs || typeof hdrs.get !== 'function') return;
        const raw = hdrs.get('X-DSH-QQ-Quality');
        if (raw) {
          let q = raw;
          try { q = decodeURIComponent(raw); } catch { /* keep raw */ }
          if (q) set({ currentQuality: q });
        }
      }).catch(() => {});
    }
    function startQQPlayback(song, queue, sourceLabel, from) {
      const id = String(song.songmid || song.id);
      const url = '/dsh-music/qq/play/' + id;
      const q = (Array.isArray(queue) && queue.length > 0) ? queue.slice() : [song];
      // 换到一首「新」的在线曲目：必须清除刷新恢复的定位钉，否则 onTime 会把这条
      // 新流 seek 回上一首的保存进度（换歌从旧进度开始）。startQQPlayback 只在点/
      // 切到新曲目时被调用（同曲目在面板上走 togglePlay 续播），因此这里无条件清除。
      restoredMusicPos = null;
      bookRestorePos = -1;
      // Fresh live tap per track (see startPlay): re-capture for the NEW src.
      closeLiveViz();
      audio.src = url;
      audio.load();
      setupLiveViz();
      set({ currentId: 'qq:' + id, currentName: song.title, currentArtists: (song.artists || []), scope: { kind: 'qq' }, qqQueue: q, qqSource: sourceLabel || (q.length > 1 ? '在线' : ''), qqQueueFrom: from === undefined ? (store.qqQueueFrom || null) : from, error: null, qqFaved: false, currentQuality: '', position: 0, duration: 0 });
      loadQQQuality(id, url);
      loadQQLyric('qq:' + id, id);
      checkQQFavForCurrent();
      savePlayback();
      const p = audio.play();
      if (p !== undefined && typeof p.catch === 'function') {
        p.catch((err) => { if (!isAutoplayBlocked(err)) return; set({ error: '浏览器拦截了自动播放，请在播放条点击▶解锁', pendingId: 'qq:' + id, pendingName: song.title }); });
      }
    }

    // ---- 在线酷狗音乐（kg:）：与 QQ 同构的播放/歌词/品质链路 ----
    // 取链响应头 X-DSH-KG-Quality（Host 由 tracker 授予档位回传），HEAD 探测立即显示。
    function loadKGQuality(id, url) {
      fetch(url, { method: 'HEAD', cache: 'no-store' }).then((r) => {
        if (store.currentId !== 'kg:' + id) return; // 响应返回时已切歌 → 丢弃
        const hdrs = r && r.headers;
        if (!hdrs || typeof hdrs.get !== 'function') return;
        const raw = hdrs.get('X-DSH-KG-Quality');
        if (raw) {
          let q = raw;
          try { q = decodeURIComponent(raw); } catch { /* keep raw */ }
          if (q) set({ currentQuality: q });
        }
      }).catch(() => {});
    }
    // 酷狗歌词：Host 按 hash+歌名+时长匹配 KRC 候选（逐字行窗口优先 → 整行 LRC 兜底）。
    // 与 QQ 不同点：未登录/匿名也可取词（krcs 端点无鉴权）。
    function loadKGLyric(id, song) {
      // 与 loadQQLyric 同理：startKGPlayback 直接调用本函数，先清掉旧歌词/讲书字幕，
      // 否则从讲书/其它来源切到酷狗时歌词面板会残留旧内容。
      resetLyric();
      const q = new URLSearchParams({
        hash: String(song.hash || ''),
        title: String(song.title || ''),
        artist: (song.artists || []).join('/'),
        duration: String(Math.round(Number(song.interval) || 0)),
      });
      fetch('/dsh-music/kg/lyric?' + q.toString(), { cache: 'no-store' })
        .then((r) => r.json())
        .then((d) => {
          if (!d || !d.ok) return;
          if (store.currentId !== id) return; // 取词期间已切歌
          if (Array.isArray(d.wordLines) && d.wordLines.length > 0) {
            musicWordLyric = d.wordLines;
            syncLyricPanelData();
            noteLyricSource(d.source || 'kg-krc', d.wordLines.length + ' 行（KRC 逐字行窗口）');
            updateLyric();
            return;
          }
          if (!Array.isArray(d.lrc)) return;
          musicLyric = mergeLyricTrans(d.lrc, d.trans);
          syncLyricPanelData();
          noteLyricSource('kugou', d.lrc.length + ' 行（酷狗在线歌曲，整行 LRC）');
          updateLyric();
        })
        .catch(() => {});
    }
    function startKGPlayback(song, queue, sourceLabel, from) {
      const id = String(song.hash || song.id);
      const url = '/dsh-music/kg/play/' + id;
      const q = (Array.isArray(queue) && queue.length > 0) ? queue.slice() : [song];
      restoredMusicPos = null;
      bookRestorePos = -1;
      closeLiveViz();
      audio.src = url;
      audio.load();
      setupLiveViz();
      set({
        currentId: 'kg:' + id, currentName: song.title, currentArtists: (song.artists || []),
        scope: { kind: 'kg' }, kgQueue: q, kgSource: sourceLabel || (q.length > 1 ? '在线' : ''),
        kgQueueFrom: from === undefined ? (store.kgQueueFrom || null) : from,
        error: null, currentQuality: '', position: 0, duration: 0, kgFaved: false,
      });
      loadKGQuality(id, url);
      loadKGLyric('kg:' + id, song);
      checkKGFavForCurrent(); // 点亮酷狗「我喜欢」爱心
      savePlayback();
      const p = audio.play();
      if (p !== undefined && typeof p.catch === 'function') {
        p.catch((err) => { if (!isAutoplayBlocked(err)) return; set({ error: '浏览器拦截了自动播放，请在播放条点击▶解锁', pendingId: 'kg:' + id, pendingName: song.title }); });
      }
    }
    // ------------------------------------------------------------------
    // 在线酷狗面板（KGOnlinePanel）：结构复用 QQOnlinePanel 的两层 UI
    // （main 浏览层 / playlist 播放列表层）与 dsh-music-qq-* 样式类。差异点：
    //  - 登录只有一种方式（酷狗 App 扫码），一次轮询拿 token，比 QQ 简单；
    //  - 未登录也可浏览榜单/歌单/搜索（匿名元数据接口），但播放必须登录；
    //  - KRC 逐字歌词内嵌翻译。
    // ------------------------------------------------------------------
    function KGOnlinePanel({ panelRef }) {
      const s = useStore();
      const json = (url) => jsonGet(url).then((d) => { if (isKgAuthDead(d)) markKgAuthDead(d.error); return d; }).catch(() => ({ ok: false, error: '网络错误' }));
      const kgPost = (url, body) => jsonPost(url, body).then((d) => { if (isKgAuthDead(d)) markKgAuthDead(d.error); return d; }).catch(() => ({ ok: false, error: '网络错误' }));
      // 酷狗登录已失效（服务端已自动登出）→ 复位面板到扫码登录页并给出提示。
      // 由引擎侧 markKgAuthDead 置位、本 effect 统一消费（json/kgPost 检测到也会走这里）。
      function resetKgToLogin(msg) {
        const playingKg = String(store.currentId || '').startsWith('kg:') || (store.scope && store.scope.kind === 'kg');
        if (playingKg) stop();
        clearPref(PREF_PLAYBACK_KG);
        kgFavPromise = null;
        set({ kgQueue: [], kgSource: '', kgQueueFrom: null, kgQueueRev: 0, kgFaved: false, kgFavHashes: [], kgFavFiles: [], kgFavListId: 0, kgAuthDeadMsg: '' });
        setLoggedIn(false); setUserid(''); setMinePlays([]); setMineLoaded(false);
        setKgPlCounts(null);
        setBrowseTab('recommend'); setBrowseErr(''); setMineErr(''); setQError('');
        setLayer('main'); setActivePl(null); setPlLoading(false);
        setLoginMsg(msg || '酷狗登录已失效（登录态与设备不匹配），请重新扫码登录');
      }
      useEffect(() => {
        if (!s.kgAuthDeadMsg) return;
        resetKgToLogin(s.kgAuthDeadMsg);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [s.kgAuthDeadMsg]);
      // ---- 登录态 ----
      const [loggedIn, setLoggedIn] = useState(null); // null=检测中 false=未登录 true=已登录
      const [userid, setUserid] = useState('');
      const [qrImage, setQrImage] = useState('');
      const [qrKey, setQrKey] = useState('');
      const [loginMsg, setLoginMsg] = useState('');
      const [loginBusy, setLoginBusy] = useState(false);
      const [loginOpen, setLoginOpen] = useState(false);
      const pollTimer = useRef(null);
      useEffect(() => {
        jsonGet('/dsh-music/kg/status').then((d) => {
          if (d) { setLoggedIn(!!d.loggedIn); setUserid(d.userid || ''); }
        }).catch(() => {});
        return () => { if (pollTimer.current !== null) clearTimeout(pollTimer.current); };
      }, []);
      function stopPoll() {
        if (pollTimer.current !== null) { clearTimeout(pollTimer.current); pollTimer.current = null; }
      }
      function startLogin() {
        if (loginBusy) return;
        setLoginBusy(true); setQrImage(''); setQrKey(''); setLoginMsg('正在获取二维码…');
        stopPoll();
        jsonPost('/dsh-music/kg/login/start', {}).then((d) => {
          if (!d || !d.ok || !d.key) { setLoginMsg((d && d.error) || '二维码获取失败'); return; }
          setQrKey(d.key); setQrImage(d.image || '');
          setLoginMsg('请用酷狗 App 扫码登录' + (d.warning ? '（' + d.warning + '）' : ''));
          const tick = () => {
            fetch('/dsh-music/kg/login/check?key=' + encodeURIComponent(d.key), { cache: 'no-store' })
              .then((r) => r.json())
              .then((c) => {
                if (!c || !c.ok) { setLoginMsg((c && c.error) || '状态未知'); return; }
                if (c.status === 'success') {
                  setLoggedIn(true); setUserid(c.userid || ''); setQrImage(''); setQrKey('');
                  // 登录成功直接关闭二维码弹窗，不显示任何提示。
                  setLoginOpen(false); setLoginMsg('');
                } else if (c.status === 'expired') { setLoginMsg('二维码已过期，请点击刷新'); }
                else if (c.status === 'scanned') { setLoginMsg('已扫码，请在手机上确认'); pollTimer.current = setTimeout(tick, 1500); }
                else { pollTimer.current = setTimeout(tick, 1500); }
              })
              .catch(() => { pollTimer.current = setTimeout(tick, 2500); });
          };
          pollTimer.current = setTimeout(tick, 1500);
        }).catch(() => setLoginMsg('网络错误')).finally(() => setLoginBusy(false));
      }
      function doLogout() {
        jsonPost('/dsh-music/kg/login/logout', {}).then(() => {
          const playingKg = String(store.currentId || '').startsWith('kg:') || store.scope?.kind === 'kg';
          if (playingKg) stop();
          clearPref(PREF_PLAYBACK_KG);
          setLoggedIn(false); setUserid(''); setMinePlays([]); setMineLoaded(false);
          setKgPlCounts(null);
          set({ kgQueue: [], kgSource: '', kgQueueFrom: null, kgQueueRev: 0 });
          // 清空「我喜欢」集合与爱心状态，下次登录重新拉取。
          kgFavPromise = null;
          set({ kgFaved: false, kgFavHashes: [], kgFavFiles: [], kgFavListId: 0 });
        }).catch(() => {});
      }

      // ---- 两层 UI：main / playlist ----
      const [layer, setLayer] = useState('main');
      const [activePl, setActivePl] = useState(null); // { name, songs, source, listId?, public?, mine?, creator?, description? }
      const [plLoading, setPlLoading] = useState(false);
      // 子标签 + 各区数据（各自懒加载，进面板常驻不丢）
      const [browseTab, setBrowseTab] = useState(loggedIn ? 'mine' : 'recommend'); // mine|recommend|category|tops|search
      // 搜索
      const [q, setQ] = useState('');
      const [searched, setSearched] = useState(false);
      const [searching, setSearching] = useState(false);
      const [results, setResults] = useState([]);
      const [plResults, setPlResults] = useState([]);
      const [resultTab, setResultTab] = useState('songs');
      const [qError, setQError] = useState('');
      // 搜索分页（歌曲 pagesize=480 一次拿全、歌单 pagesize=30；「还有更多」用接口 total 判定）
      const [searchPage, setSearchPage] = useState(1);
      const [searchLastLen, setSearchLastLen] = useState(0);
      const [searchTotal, setSearchTotal] = useState(0);
      const [searchingMore, setSearchingMore] = useState(false);
      const [plSearchPage, setPlSearchPage] = useState(1);
      const [plSearchLastLen, setPlSearchLastLen] = useState(0);
      const [plSearchTotal, setPlSearchTotal] = useState(0);
      const [plSearchingMore, setPlSearchingMore] = useState(false);
      // 搜索历史（Host 持久化）
      const [hist, setHist] = useState([]);
      const [histOpen, setHistOpen] = useState(false);
      const histRef = useRef(null);
      const histPopRef = useRef(null);
      // 推荐歌单
      const [recs, setRecs] = useState([]);
      const [recLoading, setRecLoading] = useState(false);
      const [recPage, setRecPage] = useState(1);
      const [recLoadingMore, setRecLoadingMore] = useState(false);
      const [recHasMore, setRecHasMore] = useState(true);
      // 分类
      const [cats, setCats] = useState([]);
      const [curGroup, setCurGroup] = useState(null); // 当前选中的一级分类（如「场景/风格/语种」）
      const [curCategory, setCurCategory] = useState(null); // 当前选中的二级分类（其下展示歌单）
      const [catPlays, setCatPlays] = useState([]);
      const [catPage, setCatPage] = useState(1);
      const [catHasMore, setCatHasMore] = useState(true);
      const [catLoadingMore, setCatLoadingMore] = useState(false);
      const [browseErr, setBrowseErr] = useState('');
      const [browseLoading, setBrowseLoading] = useState(false);
      // 排行榜
      const [topGroups, setTopGroups] = useState([]);
      const [topLoaded, setTopLoaded] = useState(false);
      const [topDetail, setTopDetail] = useState(null);
      const [topOffset, setTopOffset] = useState(0);
      const [topTotal, setTopTotal] = useState(0);
      const [topLoading, setTopLoading] = useState(false);
      const [topLoadingMore, setTopLoadingMore] = useState(false);
      const [topHasMore, setTopHasMore] = useState(false);
      // 我的歌单
      const [minePlays, setMinePlays] = useState([]);
      const [mineLoaded, setMineLoaded] = useState(false);
      const [mineErr, setMineErr] = useState('');
      // 我的歌单卡片本地计数表（id -> 数目）：以服务端 trackCount 为基数，增删歌曲时
      // 乐观 ±1。服务端计数有滞后，refreshMine 只填充「本地还没有的」键，不覆盖本地
      // 乐观值 → 自建歌单数目实时变化（「我喜欢」用 kgFavHashes 集合，不走这张表）。
      const [kgPlCounts, setKgPlCounts] = useState(null); // null=尚未初始化
      const kgPlCountsInit = (playlists) => {
        setKgPlCounts((prev) => {
          const m = prev === null ? {} : { ...prev };
          for (const p of playlists || []) {
            const k = String(p.id);
            if (m[k] === undefined) m[k] = Number(p.trackCount) || 0;
          }
          return m;
        });
      };
      // 「加入歌单」弹窗（+ 号）
      const [kgJoin, setKgJoin] = useState(null);
      const kgJoinRef = useRef(null);
      useEffect(() => {
        if (kgJoin === null) return;
        const onDown = (e) => { if (kgJoinRef.current !== null && !kgJoinRef.current.contains(e.target)) setKgJoin(null); };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
      }, [kgJoin]);
      // 点击搜索框外关闭历史下拉
      useEffect(() => {
        const onDocClick = (e) => {
          if (histRef.current !== null && histRef.current.contains(e.target)) return;
          if (histPopRef.current !== null && histPopRef.current.contains(e.target)) return;
          setHistOpen(false);
        };
        document.addEventListener('mousedown', onDocClick);
        return () => { stopPoll(); document.removeEventListener('mousedown', onDocClick); };
      }, []);

      // 登录态变为已登录时：默认切到「我的歌单」并加载（QQ 面板同款行为）。
      // 放在副作用里而非登录成功回调，避免用旧的 loggedIn 闭包值导致 refreshMine
      // 里的「未登录直接返回」判断误触发、歌单永远停在「加载中」（切 tab 才恢复）。
      useEffect(() => {
        if (!loggedIn) return;
        setBrowseTab('mine');
        refreshMine();
        // 登录后拉取「我喜欢」歌曲集合（点亮播放条爱心）。
        refreshKGFavIds();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [loggedIn]);
      // 酷狗「我喜欢」收藏/取消后刷新「我的歌单」，让「我喜欢」歌单数目随之更新。
      useEffect(() => {
        if (s.kgFavRev > 0 && loggedIn) refreshMine();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [s.kgFavRev]);

      // 搜索历史
      const KG_HIST_MAX = 10;
      const loadHist = () => { try { const a = JSON.parse(loadPref(PREF_KG_HISTORY)); return Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.trim()) : []; } catch { return []; } };
      const saveHist = (kw) => {
        kw = (kw || '').trim();
        if (!kw) return;
        const next = [kw, ...loadHist().filter((x) => x !== kw)].slice(0, KG_HIST_MAX);
        savePref(PREF_KG_HISTORY, JSON.stringify(next));
        setHist(next);
      };
      const clearHist = () => { clearPref(PREF_KG_HISTORY); setHist([]); };
      useEffect(() => { setHist(loadHist()); }, []);
      // Host 预置快照异步到达：一旦就绪，重读搜索历史。酷狗面板与 QQ 面板一样常驻
      // 挂载（未激活时仅 display:none 隐藏），刷新时可能先于 /dsh-music/prefs 快照
      // 就绪——挂载时 loadPref 回退 localStorage（新版本不再写它，恒空），读到的历史
      // 是空的；若没有这里的 prefsReady 重读，刷新后酷狗搜索历史就永远显示不出来。
      // （QQ 面板同款处理，见 QQOnlinePanel 的 [s.prefsReady] effect。）
      useEffect(() => {
        if (!s.prefsReady) return;
        setHist(loadHist());
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [s.prefsReady]);

      function refreshMine() {
        setMineErr('');
        if (!loggedIn) return;
        json('/dsh-music/kg/my-playlists').then((d) => {
          if (d && d.ok) {
            setMinePlays(d.playlists || []);
            kgPlCountsInit(d.playlists); // 只填充本地还没有的键，不覆盖乐观计数
          }
          else setMineErr((d && d.error) || '加载失败');
          setMineLoaded(true);
        }).catch(() => { setMineErr('网络错误'); setMineLoaded(true); });
      }
      async function loadRecommended() {
        setRecLoading(true); setBrowseErr('');
        const d = await json('/dsh-music/kg/playlists');
        if (d && d.ok) setRecs(d.playlists || []); else setBrowseErr((d && d.error) || '加载失败');
        setRecLoading(false);
      }
      async function loadMoreRecommended() {
        if (recLoadingMore || !recHasMore) return;
        setRecLoadingMore(true); setBrowseErr('');
        const nextPage = recPage + 1;
        const d = await json('/dsh-music/kg/playlists?page=' + nextPage);
        if (d && d.ok && Array.isArray(d.playlists)) {
          const existing = new Set(recs.map((p) => String(p.id)));
          const fresh = d.playlists.filter((p) => !existing.has(String(p.id)));
          setRecs((prev) => [...prev, ...fresh]);
          setRecPage(nextPage);
          if (fresh.length === 0 || d.playlists.length < 20) setRecHasMore(false);
        } else { setBrowseErr((d && d.error) || '加载更多失败'); setRecHasMore(false); }
        setRecLoadingMore(false);
      }
      async function loadCategories() {
        setBrowseLoading(true);
        const d = await json('/dsh-music/kg/playlist-categories');
        if (d && d.ok) setCats(d.categories || []);
        setBrowseLoading(false);
      }
      async function loadCategory(cat) {
        setCurCategory(cat); setCatPlays([]); setCatPage(1); setCatHasMore(true); setBrowseErr(''); setBrowseLoading(true);
        const d = await json('/dsh-music/kg/playlists?category=' + encodeURIComponent(cat.id) + '&page=1');
        if (d && d.ok) { setCatPlays(d.playlists || []); setCatHasMore((d.playlists || []).length >= 20); }
        else setBrowseErr((d && d.error) || '加载失败');
        setBrowseLoading(false);
      }
      async function loadMoreCategory() {
        if (!curCategory || catLoadingMore || !catHasMore) return;
        setCatLoadingMore(true); setBrowseErr('');
        const nextPage = catPage + 1;
        const d = await json('/dsh-music/kg/playlists?category=' + encodeURIComponent(curCategory.id) + '&page=' + nextPage);
        if (d && d.ok && Array.isArray(d.playlists)) {
          const existing = new Set(catPlays.map((p) => String(p.id)));
          const fresh = d.playlists.filter((p) => !existing.has(String(p.id)));
          setCatPlays((prev) => [...prev, ...fresh]);
          setCatPage(nextPage);
          if (fresh.length === 0 || d.playlists.length < 20) setCatHasMore(false);
        } else { setBrowseErr((d && d.error) || '加载更多失败'); setCatHasMore(false); }
        setCatLoadingMore(false);
      }
      async function loadTopLists() {
        if (topLoaded) return;
        setTopLoading(true); setBrowseErr('');
        const d = await json('/dsh-music/kg/top-lists');
        if (d && d.ok) setTopGroups(d.groups || []); else setBrowseErr((d && d.error) || '加载排行榜失败');
        setTopLoaded(true);
        setTopLoading(false);
      }
      const KG_TOP_PAGE = 600; // 榜单一次全量加载（host 端自动翻页合并，如 网络红歌榜 571 首）
      async function loadTopSongs(top) {
        setTopDetail(null); setTopLoading(true); setBrowseErr('');
        setTopOffset(0); setTopTotal(0); setTopHasMore(false);
        const d = await json('/dsh-music/kg/top-songs?rankId=' + encodeURIComponent(top.id) + '&offset=0&num=' + KG_TOP_PAGE);
        if (d && d.ok) {
          const t = d.toplist || {};
          setTopDetail({ id: top.id, name: t.name || top.name, cover: t.cover || top.cover || '', updateTime: t.updateTime || '', songs: t.songs || [] });
          setTopOffset((t.songs || []).length);
          setTopTotal(Number(t.total) || (t.songs || []).length);
          setTopHasMore((t.songs || []).length < (Number(t.total) || 0));
        } else setBrowseErr((d && d.error) || '加载榜单失败');
        setTopLoading(false);
      }
      async function loadMoreTopSongs() {
        if (!topDetail || topLoadingMore) return;
        setTopLoadingMore(true); setBrowseErr('');
        const d = await json('/dsh-music/kg/top-songs?rankId=' + encodeURIComponent(topDetail.id) + '&offset=' + topOffset + '&num=' + KG_TOP_PAGE);
        if (d && d.ok) {
          const arr = (d.toplist && d.toplist.songs) || [];
          setTopDetail((cur) => (cur ? { ...cur, songs: (cur.songs || []).concat(arr) } : cur));
          setTopOffset((o) => o + arr.length);
          setTopHasMore(topOffset + arr.length < topTotal);
        } else setBrowseErr((d && d.error) || '加载更多失败');
        setTopLoadingMore(false);
      }
      function backToTops() { setTopDetail(null); setTopOffset(0); setTopTotal(0); setTopHasMore(false); }
      // 「播放全部」：把歌单/榜单整列表作为播放队列，从第一首开始播。
      function playAllKGSongs() {
        const pl = activePl;
        if (!pl || !Array.isArray(pl.songs) || pl.songs.length === 0) return;
        // 与歌曲行一致的队列来源：我的歌单详情记该歌单，公开/其它为快照（不跟随）。
        const from = (pl.listId) ? { kind: 'my', listId: pl.listId } : null;
        startKGPlayback(pl.songs[0], pl.songs, pl.name || '酷狗歌单', from);
      }
      function playAllKGTops() {
        const t = topDetail;
        if (!t || !Array.isArray(t.songs) || t.songs.length === 0) return;
        startKGPlayback(t.songs[0], t.songs, t.name || '排行榜', null);
      }
      async function doSearch(kwOverride) {
        const kw = (kwOverride !== undefined ? String(kwOverride) : q).trim();
        if (kw === '') { setSearched(false); setQError(''); return; }
        setHistOpen(false);
        saveHist(kw);
        setSearching(true); setQError(''); setResults([]); setPlResults([]); setSearched(true);
        setSearchPage(1); setSearchLastLen(0); setSearchTotal(0); setPlSearchPage(1); setPlSearchLastLen(0); setPlSearchTotal(0);
        const [sg, pg] = await Promise.all([
          json('/dsh-music/kg/search?w=' + encodeURIComponent(kw) + '&page=1'),
          json('/dsh-music/kg/playlist-search?w=' + encodeURIComponent(kw) + '&page=1'),
        ]);
        if (sg && sg.ok) { setResults(sg.results || []); setSearchLastLen((sg.results || []).length); setSearchTotal(Number(sg.total) || (sg.results || []).length); setSearchPage(sg.page || 1); }
        else setQError((sg && sg.error) || '歌曲搜索失败');
        if (pg && pg.ok) { setPlResults(pg.playlists || []); setPlSearchLastLen((pg.playlists || []).length); setPlSearchTotal(Number(pg.total) || (pg.playlists || []).length); setPlSearchPage(pg.page || 1); }
        const sLen = (sg && sg.ok && (sg.results || []).length) || 0;
        const pLen = (pg && pg.ok && (pg.playlists || []).length) || 0;
        if (sLen > 0) setResultTab('songs');
        else if (pLen > 0) setResultTab('playlists');
        setSearching(false);
      }
      async function loadMoreSongs() {
        const kw = q.trim();
        if (kw === '' || searchingMore) return;
        const next = searchPage + 1;
        setSearchingMore(true);
        try {
          const d = await json('/dsh-music/kg/search?w=' + encodeURIComponent(kw) + '&page=' + next);
          if (d && d.ok) {
            setResults((cur) => cur.concat(d.results || []));
            setSearchLastLen((d.results || []).length);
            setSearchTotal(Number(d.total) || (d.results || []).length);
            setSearchPage(d.page || next);
          }
        } catch {}
        setSearchingMore(false);
      }
      async function loadMorePls() {
        const kw = q.trim();
        if (kw === '' || plSearchingMore) return;
        const next = plSearchPage + 1;
        setPlSearchingMore(true);
        try {
          const d = await json('/dsh-music/kg/playlist-search?w=' + encodeURIComponent(kw) + '&page=' + next);
          if (d && d.ok) {
            setPlResults((cur) => cur.concat(d.playlists || []));
            setPlSearchLastLen((d.playlists || []).length);
            setPlSearchTotal(Number(d.total) || (d.playlists || []).length);
            setPlSearchPage(d.page || next);
          }
        } catch {}
        setPlSearchingMore(false);
      }
      async function openPublicPlaylist(pl) {
        setActivePl(null); setLayer('playlist'); setPlLoading(true);
        const d = await json('/dsh-music/kg/playlist/' + encodeURIComponent(pl.id));
        if (d && d.ok) setActivePl({ id: pl.id, creatorId: pl.creatorId || d.playlist.creatorId || '', gid: pl.gid || d.playlist.gid || '', slid: pl.slid || d.playlist.slid || '', name: pl.name, creator: pl.creator, description: pl.description || d.playlist.description || '', songs: d.playlist.songs || [], source: pl.name || '酷狗歌单', public: true });
        else { setBrowseErr((d && d.error) || '歌单详情加载失败'); setLayer('main'); }
        setPlLoading(false);
      }
      async function openMyPlaylist(pl) {
        setActivePl(null); setLayer('playlist'); setPlLoading(true);
        const d = await json('/dsh-music/kg/my-playlist/' + encodeURIComponent(pl.id));
        if (d && d.ok) setActivePl({ name: pl.name, creator: pl.creator, description: pl.description || '', songs: d.playlist.songs || [], source: pl.name || '我的歌单', listId: pl.id, mine: pl.kind !== 'collect' });
        else { setBrowseErr((d && d.error) || '歌单内容加载失败'); setLayer('main'); }
        setPlLoading(false);
      }
      // 按队列来源（我的歌单）拉最新内容，替换播放队列；返回新队列（或 null 未刷新）。
      // 保留当前播放曲目：若它已被移出歌单，插到队首继续播，播完「下一首」接新歌单第一首。
      // from 可显式传入（openQueue 从持久化恢复时，闭包里的 s.kgQueueFrom 可能还是旧的）。
      async function refreshKgQueueFromSource(from) {
        from = from || s.kgQueueFrom;
        if (!from || from.kind !== 'my' || !from.listId) return null;
        const d = await json('/dsh-music/kg/my-playlist/' + encodeURIComponent(from.listId));
        if (!d || !d.ok || !Array.isArray(d.playlist.songs)) return null;
        const fresh = d.playlist.songs;
        const curHash = String(store.currentId || '').startsWith('kg:') ? String(store.currentId).slice(3) : null;
        let newQueue = fresh;
        if (curHash && !fresh.some((t) => String(t.hash || t.id) === curHash)) {
          const cur = (s.kgQueue || []).find((t) => String(t.hash || t.id) === curHash) || null;
          if (cur) newQueue = [cur, ...fresh];
        }
        set({ kgQueue: newQueue });
        return newQueue;
      }
      async function openQueue() {
        let songs = s.kgQueue || [];
        let src = s.kgSource;
        let from = s.kgQueueFrom;
        if (songs.length === 0) {
          const saved = loadKGPlayback();
          if (saved && Array.isArray(saved.queue) && saved.queue.length > 0) {
            songs = saved.queue;
            src = saved.source || src;
            if (saved.queueFrom && typeof saved.queueFrom === 'object') from = saved.queueFrom;
            // 恢复来源歌单信息，打开播放列表时据此跟随最新内容。
            set({ kgQueue: songs, kgSource: src || '', kgQueueFrom: from });
          }
        }
        // 队列来自「我的歌单」→ 拉最新内容（跟随外部/跨会话增删）。
        const fresh = await refreshKgQueueFromSource(from);
        if (fresh) songs = fresh;
        setActivePl({ name: src || '在线播放列表', songs, source: src || '播放中' });
        setLayer('playlist'); setPlLoading(false);
      }
      // 实时跟随：来源是「我的歌单」且其内容发生过增删（收藏/加歌/移除）→ 重拉队列；
      // 若正展示播放列表视图则同步可见列表。恢复带来源的队列时也会触发一次（rev 被 +1）。
      useEffect(() => {
        const from = s.kgQueueFrom;
        if (!from || from.kind !== 'my' || (s.kgQueueRev || 0) === 0) return;
        let cancelled = false;
        refreshKgQueueFromSource().then((newQueue) => {
          if (cancelled || !newQueue) return;
          // 当前展示的是播放列表视图（activePl 无 listId 无 id）→ 同步可见列表。
          if (layer === 'playlist' && activePl && activePl.listId === undefined && activePl.id === undefined) {
            setActivePl((cur) => (cur ? { ...cur, songs: newQueue } : cur));
          }
        });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [s.kgQueueRev, s.kgQueueFrom]);
      function backToMain() { setLayer('main'); setActivePl(null); setPlLoading(false); }
      async function removeFromActivePlaylist(song) {
        if (!activePl || !activePl.listId) return;
        kgPost('/dsh-music/kg/playlist-remove', { listId: activePl.listId, fileId: song.fileId || song.mixSongId || song.hash }).then((d) => {
          if (d && d.ok) {
            const id = String(song.hash || song.id);
            setActivePl((cur) => (cur ? { ...cur, songs: (cur.songs || []).filter((x) => String(x.hash || x.id) !== id) } : cur));
            showToast('已从歌单移除', true);
            // 我的歌单内容变了 → 播放列表跟随刷新。
            set({ kgQueueRev: (store.kgQueueRev || 0) + 1 });
            // 从「我喜欢」移除 → 同步本地收藏集合（卡片数目实时更新）。
            if (String(activePl.listId) === String(store.kgFavListId || '')) {
              const hashes = new Set(store.kgFavHashes || []);
              hashes.delete(id);
              set({ kgFavHashes: [...hashes], kgFavRev: (store.kgFavRev || 0) + 1 });
            } else {
              // 自建/收藏歌单卡片数目乐观 -1（本地计数表，实时更新）。
              const plk = String(activePl.listId);
              setKgPlCounts((m) => {
                if (m === null) return m;
                const cur = (m[plk] !== undefined ? m[plk] : 0);
                return { ...m, [plk]: Math.max(0, cur - 1) };
              });
            }
          } else showToast((d && d.error) || '移除失败', false);
        }).catch(() => showToast('网络错误', false));
      }
      // 加入歌单
      function openKgJoin(song, e) {
        const r = e.currentTarget.getBoundingClientRect();
        if (minePlays.length === 0 && !mineLoaded) refreshMine();
        setKgJoin({ song, x: r.right, y: r.top });
      }
      async function kgJoinAddTo(pl) {
        const song = kgJoin && kgJoin.song;
        if (!song) return;
        const name = (pl && pl.name) || '歌单';
        try {
          const d = await kgPost('/dsh-music/kg/playlist-add', { listId: (pl && pl.id) || 0, song });
          if (!d || !d.ok) throw new Error((d && d.error) || '加入歌单失败');
          if (pl) {
            const pid = String(pl.id);
            // 自建/收藏歌单卡片数目乐观 +1（refreshMine 不会覆盖本地乐观值）。
            setKgPlCounts((m) => ({ ...(m || {}), [pid]: ((m && m[pid] !== undefined) ? m[pid] : (Number(pl.trackCount) || 0)) + 1 }));
            refreshMine();
          }
          setKgJoin(null);
          showToast('添加到' + name + '成功', true);
          // 我的歌单内容变了 → 播放列表跟随刷新。
          set({ kgQueueRev: (store.kgQueueRev || 0) + 1 });
          // 加入的是「我喜欢」→ 同步本地收藏集合（卡片数目实时更新）。
          if (pl && String(pl.id) === String(store.kgFavListId || '')) {
            const hashes = new Set(store.kgFavHashes || []);
            hashes.add(String(song.hash || song.id));
            set({ kgFavHashes: [...hashes], kgFavRev: (store.kgFavRev || 0) + 1 });
          }
        } catch (err) { showToast('添加到' + name + '失败', false); }
      }
      async function kgJoinCreate() {
        const song = kgJoin && kgJoin.song;
        openPrompt('新建歌单名称', '', async (trimmed) => {
          if (!trimmed) return;
          try {
            const d = await kgPost('/dsh-music/kg/playlist-create', { name: trimmed });
            if (!d || !d.ok || !d.playlist) throw new Error((d && d.error) || '创建歌单失败');
            const created = d.playlist;
            if (song) {
              const add = await kgPost('/dsh-music/kg/playlist-add', { listId: Number(created.id) || 0, song });
              if (!add || !add.ok) throw new Error((add && add.error) || '加入新歌单失败');
            }
            refreshMine();
            setKgJoin(null);
            showToast('添加到' + ((created && created.name) || trimmed) + '成功', true);
          } catch (err) { showToast('添加到' + trimmed + '失败', false); }
        });
      }
      const kgJoinMenu = kgJoin ? portalToBody((() => {
        const openUp = (kgJoin.y || 0) > ((window.innerHeight || 0) - 240);
        const style = {
          left: Math.max(8, (kgJoin.x || 0) - 150),
          top: openUp ? (kgJoin.y || 0) - 6 : (kgJoin.y || 0) + 18,
          transform: openUp ? 'translateY(-100%)' : 'none',
        };
        return React.createElement('div', { className: 'dsh-music-add-pop', ref: kgJoinRef, style },
          (() => {
            // 收藏的歌单是别人的，不可加入歌曲；只有自建歌单可作加入目标。
            const ownPlays = minePlays.filter((p) => p.kind !== 'collect');
            return ownPlays.length > 0 ? ownPlays.map((p) => React.createElement('button', {
              key: p.id, className: 'dsh-music-add-pop-item',
              title: '加入「' + p.name + '」',
              onClick: () => kgJoinAddTo(p),
            }, p.name + (p.trackCount ? '（' + p.trackCount + '）' : ''))) : React.createElement('div', { className: 'dsh-music-hint', style: { padding: '2px 8px' } }, '暂无自建歌单，请先创建。');
          })(),
          React.createElement('button', { className: 'dsh-music-add-pop-item new', onClick: kgJoinCreate }, '＋ 新建歌单'),
        );
      })()) : null;

      // ---- 渲染辅助 ----
      const fmtCount = (n) => { const v = Number(n) || 0; if (v >= 1e8) return (v / 1e8).toFixed(1).replace(/\.0$/, '') + '亿'; if (v >= 1e4) return (v / 1e4).toFixed(1).replace(/\.0$/, '') + '万'; return String(v); };
      const kgSongRow = (song, queue, sourceLabel, opts = {}) => {
        const id = String(song.hash || song.id);
        const active = s.currentId === 'kg:' + id;
        const playing = active && s.playing;
        // 酷狗付费/VIP 判定：pay_type/privilege 为 0 = 免费，非 0（1/2/3 与 8/10）
        // 即需 VIP/付费。真实接口里付费歌几乎都是 pay_type=3、privilege=10，
        // 旧条件写成 ===1 几乎永远不成立 → 歌单/搜索里一律不显示 VIP 标。
        const vip = Number(song.payType) > 0 || Number(song.privilege) > 0;
        const artists = (song.artists || []).join('/');
        // 播放队列来源（供「播放列表跟随歌单更新」）：
        //  - 「我的歌单」详情（activePl 带 listId，含我喜欢/自建/收藏）→ 记该歌单；
        //  - 播放列表视图（activePl 无 id 也无 listId）→ 沿用现有来源（同一队列内点歌）；
        //  - 公开歌单/搜索/榜单等 → null（快照，不跟随）。
        const queueFrom = (activePl && activePl.listId)
          ? { kind: 'my', listId: activePl.listId }
          : (activePl && activePl.id === undefined ? (s.kgQueueFrom || null) : null);
        return React.createElement('div', { key: id, className: 'dsh-music-track-row' + (active ? ' active' : '') },
          React.createElement('button', {
            className: 'dsh-music-track' + (active ? ' active' : ''),
            title: song.title + ' - ' + artists,
            onClick: () => { if (active) togglePlay(); else startKGPlayback(song, queue, sourceLabel, queueFrom); },
          },
            React.createElement('span', { className: 'dsh-music-track-name qq' },
              React.createElement('span', { className: 'dsh-music-track-title' }, (playing ? '▶ ' : '') + (song.title || '(未知曲名)')),
              vip ? React.createElement('span', { className: 'dsh-music-online-tag vip' }, 'VIP') : null),
            React.createElement('span', { className: 'dsh-music-online-tag' }, artists || (song.album || '酷狗'))),
          opts.mine
            ? React.createElement('button', {
              className: 'dsh-music-playlist-mini remove',
              title: '从「' + ((activePl && activePl.name) || '当前歌单') + '」移除',
              onClick: (e) => { e.stopPropagation(); removeFromActivePlaylist(song); },
            }, '−')
            : React.createElement('button', {
              className: 'dsh-music-playlist-mini add',
              title: '加入我的歌单',
              onClick: (e) => { e.stopPropagation(); openKgJoin(song, e); },
            }, '＋'));
      };
      const plCard = (pl, mine) => {
        const isMine = mine === true;
        const isCollect = pl.kind === 'collect';
        // 卡片数目：我喜欢 → 本地集合长度（实时）；自建/收藏 → 本地计数表（乐观 ±1，
        // 不被服务端滞后覆盖）；均未就绪才回退服务端 trackCount。
        const k = String(pl.id);
        let liveCount = Number(pl.trackCount) || 0;
        if (pl.isLike && s.kgFavLoaded) liveCount = (s.kgFavHashes || []).length;
        else if (kgPlCounts !== null && kgPlCounts[k] !== undefined) liveCount = kgPlCounts[k];
        const meta = (liveCount > 0 ? (liveCount + ' 首') : '')
          + (pl.playCount ? ' · 播放 ' + fmtCount(pl.playCount) : '');
        // 「我的歌单」卡片：收藏的歌单标「收藏」角标、展示原作者；系统默认歌单标
        // 「默认」（主题色，与 QQ 一致）、自建歌单标「自建」。
        const kindTag = isMine ? React.createElement('span', {
          className: 'dsh-music-online-tag'
            + (isCollect ? ' collect' : (pl.isDefault ? ' default' : '')),
          title: isCollect ? '收藏的歌单' : (pl.isDefault ? '系统默认歌单' : '自己创建的歌单'),
        }, isCollect ? '收藏' : (pl.isDefault ? '默认' : '自建')) : null;
        const card = React.createElement('button', {
          key: String(pl.id), className: 'dsh-music-playlist-card',
          title: (pl.description || pl.name || '') + ' - ' + (pl.creator || ''),
          onClick: () => (isMine ? openMyPlaylist(pl) : openPublicPlaylist(pl)),
        },
          plCoverEl(pl),
          React.createElement('span', { className: 'dsh-music-playlist-info' },
            React.createElement('span', { className: 'dsh-music-playlist-name-row' },
              React.createElement('span', { className: 'dsh-music-playlist-name' }, pl.name || '(未命名歌单)'),
              kindTag),
            React.createElement('span', { className: 'dsh-music-playlist-meta' },
              (isCollect && pl.creator ? pl.creator + ' · ' : '') + meta)));
        if (!isMine) return card;
        // 系统默认歌单（默认收藏/我喜欢）不可删；收藏歌单（kind=collect）允许「取消收藏」。
        if (pl.isDefault) return card;
        const uncollect = isCollect;
        return React.createElement('div', { key: String(pl.id), className: 'dsh-music-qq-mine-card' },
          card,
          React.createElement('button', {
            className: 'dsh-music-qq-mine-del' + (uncollect ? ' uncollect' : ''),
            title: (uncollect ? '取消收藏歌单「' : '删除歌单「') + (pl.name || '') + '」',
            onClick: (e) => { e.stopPropagation(); deleteMinePlaylist(pl, uncollect); },
          }, uncollect ? '☆' : '✕'));
      };
      async function deleteMinePlaylist(pl, uncollect = false) {
        const listId = Number(pl && pl.id) || 0;
        if (!listId) { setBrowseErr('缺少歌单 id，无法删除'); return; }
        openConfirm(uncollect ? '取消收藏' : '删除歌单',
          uncollect
            ? '确定取消收藏歌单「' + (pl.name || '') + '」？取消后不影响原歌单及其创作者，之后仍可在酷狗重新收藏。'
            : '确定删除酷狗歌单「' + (pl.name || '') + '」？删除后不可恢复。',
          async () => {
            try {
              const d = await kgPost('/dsh-music/kg/playlist-delete', { listId });
              if (!d || !d.ok) throw new Error((d && d.error) || (uncollect ? '取消收藏失败' : '删除歌单失败'));
              setMinePlays((prev) => prev.filter((p) => String(p.id) !== String(pl.id)));
              // 删除/取消收藏 → 从本地计数表移除该歌单。
              const dlk = String(pl.id);
              setKgPlCounts((m) => {
                if (m === null || m[dlk] === undefined) return m;
                const { [dlk]: _drop, ...rest } = m;
                return rest;
              });
            } catch (err) { setBrowseErr(String((err && err.message) || err)); }
          }, uncollect ? '取消收藏' : '删除', true);
      }
      // 收藏公开歌单（v5/add_list type=1）：按钮在公开歌单详情页头。
      const [kgCollecting, setKgCollecting] = useState(false);
      async function collectActivePlaylist() {
        const pl = activePl;
        if (!pl || kgCollecting) return;
        // 收藏需要 gid（创建者内部歌单 gid，special/info 的 global_specialid）+
        // creatorId（suid）。缺 gid 时后端会报 30203。
        if (!pl.gid || !pl.creatorId) { showToast('缺少歌单信息，无法收藏', false); return; }
        setKgCollecting(true);
        try {
          const d = await kgPost('/dsh-music/kg/playlist-collect', { playlist: { specialId: String(pl.id), creatorId: String(pl.creatorId), creatorGid: String(pl.gid), name: pl.name } });
          if (!d || !d.ok) throw new Error((d && d.error) || '收藏失败');
          showToast('已收藏「' + (pl.name || '') + '」', true);
          refreshMine(); // 刷新「我的歌单」，让新收藏的歌单出现在列表并标「收藏」
        } catch (err) { showToast(String((err && err.message) || err) || '收藏失败', false); }
        setKgCollecting(false);
      }
      const catTab = (cat) => React.createElement('button', {
        key: cat.id, className: 'dsh-music-qq-cat' + (curGroup && curGroup.id === cat.id ? ' active' : ''),
        onClick: () => { setCurGroup(cat); setCurCategory(null); setCatPlays([]); },
      }, cat.name);
      const subCatTab = (cat) => React.createElement('button', {
        key: cat.id, className: 'dsh-music-qq-cat' + (curCategory && curCategory.id === cat.id ? ' active' : ''),
        onClick: () => loadCategory(cat),
      }, cat.name);
      const browseTabBtn = (key, label) => React.createElement('button', {
        className: 'dsh-music-qq-viewtab' + (browseTab === key ? ' active' : ''),
        onClick: () => {
          setBrowseTab(key);
          if (key === 'recommend' && recs.length === 0) loadRecommended();
          else if (key === 'category' && cats.length === 0) loadCategories();
          else if (key === 'tops' && !topLoaded) loadTopLists();
          else if (key === 'mine' && minePlays.length === 0) refreshMine();
        },
      }, label);
      const resultTabBtn = (key, label) => React.createElement('button', {
        className: 'dsh-music-qq-resulttab' + (resultTab === key ? ' active' : ''),
        onClick: () => setResultTab(key),
      }, label);
      const searchBox = React.createElement('div', { className: 'dsh-music-qq-search', ref: histRef },
        React.createElement('div', { className: 'dsh-music-qq-inputwrap' },
          React.createElement('input', {
            className: 'dsh-music-qq-input', type: 'text', placeholder: '搜索酷狗音乐（歌曲 / 歌单）',
            value: q,
            onChange: (e) => { setQ(e.target.value); if (e.target.value === '') setSearched(false); },
            onKeyDown: (e) => { if (e.key === 'Enter') doSearch(); },
            onFocus: () => { if (hist.length > 0) setHistOpen(true); },
          }),
          // 清除钮始终渲染、用 visibility 控制显隐，避免「有无 ×」导致输入框/UI 宽度抖动。
          React.createElement('button', {
            className: 'dsh-music-qq-clear' + (q === '' ? ' hidden' : ''),
            type: 'button', title: '清空输入',
            onClick: () => { setQ(''); setSearched(false); },
          }, '✕')),
        React.createElement('button', { className: 'dsh-music-settings-btn', onClick: () => doSearch() }, searching ? '搜索中…' : '搜索'));
      const histPop = (histOpen && hist.length > 0)
        ? portalToBody(React.createElement('div', { className: 'dsh-music-qq-hist', style: anchorBelow(histRef.current, 420), ref: histPopRef },
          React.createElement('div', { className: 'dsh-music-qq-hist-head' },
            React.createElement('span', { className: 'dsh-music-hint' }, '搜索历史'),
            React.createElement('button', { className: 'dsh-music-qq-hist-clear', title: '清空历史', onClick: clearHist }, '清空')),
          hist.map((kw, idx) => React.createElement('button', {
            key: idx, className: 'dsh-music-qq-hist-item',
            onClick: () => { setQ(kw); doSearch(kw); },
          }, kw))))
        : null;

      // 扫码框以面板中心为基准居中（面板可拖拽），贴边时 clamp 不被裁掉。
      const kgLoginStyle = panelCenterStyle(panelRef, loginOpen, 170, 460);
      const loginModal = loginOpen ? portalToBody(React.createElement('div', { className: 'dsh-music-picker-overlay' },
        React.createElement('div', { className: 'dsh-music-picker qq-login', style: kgLoginStyle },
          React.createElement('div', { className: 'dsh-music-picker-head' },
            React.createElement('span', { className: 'dsh-music-picker-title' }, '酷狗音乐登录'),
            React.createElement('button', { className: 'dsh-music-icon-btn', title: '关闭', onClick: () => setLoginOpen(false) }, '✕')),
          React.createElement('div', { className: 'dsh-music-qq-login-body' },
            loginBusy && qrImage === '' ? React.createElement('div', { className: 'dsh-music-loading' }, '生成二维码…')
              : qrImage ? React.createElement('img', { className: 'dsh-music-qq-qr', src: qrImage, alt: '酷狗登录二维码' }) : null,
            React.createElement('div', { className: 'dsh-music-qq-login-status' }, loginMsg || ''),
            loginMsg !== '登录成功' ? React.createElement('div', { className: 'dsh-music-qq-login-actions' },
              React.createElement('button', { className: 'dsh-music-settings-btn', onClick: startLogin }, '刷新二维码'),
              React.createElement('button', { className: 'dsh-music-settings-btn', onClick: () => setLoginOpen(false) }, '取消')) : null,
          )))) : null;
      // ---- 层渲染 ----
      if (loggedIn === null) {
        return React.createElement('div', { className: 'dsh-music-qq' },
          React.createElement('div', { className: 'dsh-music-empty' }, '正在检查登录态…'));
      }
      // 未登录：与 QQ 面板一致——居中扫码登录按钮 + 免责声明，登录后才展示浏览/搜索。
      if (!loggedIn) {
        return React.createElement('div', { className: 'dsh-music-qq dsh-music-qq-login' },
          React.createElement('div', { className: 'dsh-music-qq-login-center' },
            loginMsg ? React.createElement('div', { className: 'dsh-music-qq-login-dead' }, loginMsg) : null,
            React.createElement('button', { className: 'dsh-music-qq-login-btn', onClick: () => { setLoginOpen(true); startLogin(); } }, '酷狗音乐APP登录'),
            React.createElement('div', { className: 'dsh-music-qq-login-warn' },
              React.createElement('div', { className: 'dsh-music-qq-login-warn-title' }, '使用声明（重要）'),
              React.createElement('div', { className: 'dsh-music-qq-login-warn-p' },
                '在线酷狗音乐功能通过非官方接口访问酷狗音乐资源，所播放/收藏的内容版权归版权方及酷狗音乐平台所有。本功能仅供个人学习、技术研究、日常试听使用，严禁用于任何商业用途、公开传播、二次分发或盈利行为。使用本功能即表示您已知悉并同意：'),
              React.createElement('div', { className: 'dsh-music-qq-login-warn-item' },
                React.createElement('span', { className: 'dsh-music-qq-login-warn-num' }, '1'),
                React.createElement('span', null, '您应对自己的使用行为及其后果负责。')),
              React.createElement('div', { className: 'dsh-music-qq-login-warn-item' },
                React.createElement('span', { className: 'dsh-music-qq-login-warn-num' }, '2'),
                React.createElement('span', null, '因使用非官方接口登录/播放导致的账号风控、封禁、限流，以及可能引发的法律、版权纠纷，均由使用者自行承担。')),
              React.createElement('div', { className: 'dsh-music-qq-login-warn-item' },
                React.createElement('span', { className: 'dsh-music-qq-login-warn-num' }, '3'),
                React.createElement('span', null, '本项目作者不承担任何因此产生的直接或间接责任。')),
              React.createElement('div', { className: 'dsh-music-qq-login-warn-p' },
                '如您不同意以上条款，请勿使用本功能。'))),
          loginModal);
      }
      // 已登录后主 UI：可浏览榜单/歌单/搜索（酷狗匿名元数据可用，登录后取链播放）。
      // playlist 层
      if (layer === 'playlist' && activePl) {
        const pl = activePl;
        // 公开歌单是否已被收藏：在我的歌单里找 kind=collect 且 originalId（= 创建者内部
        // listid）匹配的项。收藏后我的歌单条目 originalId 取 gid 内部 listid（special/info
        // 的 slid），与公开 specialid 不同号，故要用 slid 匹配而非 id。
        const isCollected = !!pl.public && minePlays.some((p) => p.kind === 'collect' && String(p.originalId || '') === String(pl.slid || ''));
        const collectBtn = (pl.public && pl.id)
          ? React.createElement('button', {
            className: 'dsh-music-qq-collect-pl' + (isCollected ? ' collected' : ''),
            title: isCollected ? '已收藏到我的歌单' : '收藏这个歌单到我的歌单',
            onClick: (e) => { e.stopPropagation(); collectActivePlaylist(); },
            disabled: isCollected || kgCollecting,
          }, isCollected ? '★ 已收藏' : (kgCollecting ? '收藏中…' : '☆ 收藏'))
          : null;
        return React.createElement('div', { className: 'dsh-music-qq' },
          React.createElement('div', { className: 'dsh-music-qq-head' },
            React.createElement('div', { className: 'dsh-music-qq-detail-head' },
              React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: backToMain }, '← 返回'),
              React.createElement('span', { className: 'dsh-music-settings-cur', title: pl.name }, pl.name),
              React.createElement('span', { className: 'dsh-music-hint' }, (pl.creator ? (pl.creator + ' · ') : '') + ((pl.songs || []).length + ' 首'))),
            pl.description ? React.createElement('p', { className: 'dsh-music-hint' }, pl.description) : null,
            ((pl.songs && pl.songs.length) || collectBtn)
              ? React.createElement('div', { className: 'dsh-music-qq-pl-actions' },
                (pl.songs && pl.songs.length)
                  ? React.createElement('button', { className: 'dsh-music-qq-playall', onClick: playAllKGSongs }, '▶ 播放全部')
                  : null,
                collectBtn)
              : null),
          React.createElement('div', { className: 'dsh-music-qq-body' },
            plLoading
              ? React.createElement('div', { className: 'dsh-music-hint' }, '加载中…')
              : (pl.songs && pl.songs.length
                ? React.createElement('div', null, pl.songs.map((song) => kgSongRow(song, pl.songs, pl.name, { mine: !!pl.mine })))
                : React.createElement('div', { className: 'dsh-music-empty' }, '暂无歌曲。'))),
          loginModal,
          kgJoinMenu);
      }
      // main 层
      let body;
      // 搜索 tab 的固定行（在滚动容器 .dsh-music-qq-body 之外）：搜索框行 + 「歌曲/
      // 相关歌单」子tab 行。它们与 head 一样固定，滚动条只作用于其下方的结果内容，
      // 避免搜索结果出现竖向滚动条时整行（含输入框）左右偏移。
      let searchRow = null;
      let resultTabsRow = null;
      if (browseTab === 'search') {
        const hasSongs = results.length > 0;
        const hasPls = plResults.length > 0;
        let resultContent = null;
        const songMoreBtn = (searchTotal > results.length)
          ? React.createElement('div', { className: 'dsh-music-qq-loadmore' },
            React.createElement('button', { className: 'dsh-music-qq-loadmore-btn', onClick: loadMoreSongs },
              searchingMore ? '加载中…' : '加载更多'))
          : null;
        const plMoreBtn = (plSearchTotal > plResults.length)
          ? React.createElement('div', { className: 'dsh-music-qq-loadmore' },
            React.createElement('button', { className: 'dsh-music-qq-loadmore-btn', onClick: loadMorePls },
              plSearchingMore ? '加载中…' : '加载更多'))
          : null;
        // 「歌曲 / 相关歌单」子tab 行固定在搜索框下方，不随结果滚动。
        if (hasSongs && hasPls) {
          resultTabsRow = React.createElement('div', { className: 'dsh-music-qq-resulttabs fixed' },
            resultTabBtn('songs', '歌曲'),
            resultTabBtn('playlists', '相关歌单'));
        }
        if (searching) {
          resultContent = React.createElement('div', { className: 'dsh-music-hint' }, '搜索中…');
        } else if (qError || !(hasSongs || hasPls)) {
          resultContent = React.createElement('div', { className: 'dsh-music-error' }, qError || '未找到相关结果。');
        } else if (resultTab === 'playlists' && hasPls) {
          resultContent = React.createElement('div', null, plResults.map((p) => plCard(p)), plMoreBtn);
        } else {
          resultContent = React.createElement('div', null, results.map((song) => kgSongRow(song, results, '搜索结果')), songMoreBtn);
        }
        searchRow = React.createElement('div', { className: 'dsh-music-qq-searchrow' }, searchBox, histPop);
        // body 只放结果内容（在 .dsh-music-qq-body 滚动容器内）。
        body = searched ? React.createElement('div', null, resultContent) : null;
      } else if (browseTab === 'mine') {
        let content;
        if (!loggedIn) {
          content = React.createElement('div', { className: 'dsh-music-hint' }, '登录后可查看我的歌单。');
        } else if (!mineLoaded) {
          content = React.createElement('div', { className: 'dsh-music-hint' }, '加载我的歌单…');
        } else if (minePlays.length === 0) {
          content = React.createElement('div', { className: 'dsh-music-hint' }, '暂无歌单。可到酷狗音乐 App 创建或收藏歌单后再来查看。');
        } else {
          content = React.createElement('div', null, minePlays.map((p) => plCard(p, true)));
        }
        body = React.createElement('div', null, content,
          mineErr ? React.createElement('div', { className: 'dsh-music-error' }, mineErr) : null,
          browseLoading ? React.createElement('div', { className: 'dsh-music-loading' }, '加载中…') : null);
      } else if (browseTab === 'category') {
        const catMoreBtn = curCategory && catPlays.length > 0 && catHasMore
          ? React.createElement('div', { className: 'dsh-music-qq-loadmore' },
            React.createElement('button', { className: 'dsh-music-qq-loadmore-btn', onClick: loadMoreCategory },
              catLoadingMore ? '加载中…' : '加载更多'))
          : null;
        const content = React.createElement('div', null,
          // 一级分类（场景/主题/语种/风格/心情/年代）
          React.createElement('div', { className: 'dsh-music-qq-cats' },
            cats.length ? cats.map(catTab) : React.createElement('span', { className: 'dsh-music-hint' }, '加载分类中…')),
          // 选中一级后：在二级分类上方加一条分隔线，再显示其二级子分类 chips
          curGroup && curGroup.children && curGroup.children.length
            ? React.createElement('div', null,
              React.createElement('div', { className: 'dsh-music-cat-divider' }),
              React.createElement('div', { className: 'dsh-music-qq-cats', style: { marginTop: 8 } }, curGroup.children.map(subCatTab)))
            : null,
          // 选中二级分类后：显示该分类下的歌单
          curCategory ? React.createElement('div', null,
            (catPlays.length ? catPlays.map((p) => plCard(p)) : React.createElement('div', { className: 'dsh-music-hint' }, '该分类暂无歌单。')),
            catMoreBtn) : null);
        body = React.createElement('div', null, content,
          browseErr ? React.createElement('div', { className: 'dsh-music-error' }, browseErr) : null,
          browseLoading ? React.createElement('div', { className: 'dsh-music-loading' }, '加载中…') : null);
      } else if (browseTab === 'tops') {
        let content;
        if (topDetail) {
          const rows = topDetail.songs && topDetail.songs.length
            ? topDetail.songs.map((song) => kgSongRow(song, topDetail.songs, topDetail.name))
            : React.createElement('div', { className: 'dsh-music-hint' }, '该榜单暂无歌曲。');
          const moreBtn = topHasMore
            ? React.createElement('div', { className: 'dsh-music-qq-loadmore' },
              React.createElement('button', { className: 'dsh-music-qq-loadmore-btn', onClick: loadMoreTopSongs },
                topLoadingMore ? '加载中…' : '加载更多'))
            : null;
          content = React.createElement('div', null,
            rows,
            moreBtn);
        } else if (topLoading) {
          content = React.createElement('div', { className: 'dsh-music-loading' }, '加载榜单中…');
        } else if (topGroups.length === 0) {
          content = React.createElement('div', { className: 'dsh-music-empty' }, browseErr || '暂无榜单');
        } else {
          const topCards = (tl) => tl.map((t) => {
            const meta = t.playCount ? '播放 ' + fmtCount(t.playCount) : (t.trackCount ? t.trackCount + ' 首' : '');
            return React.createElement('button', {
              key: t.id, className: 'dsh-music-playlist-card',
              onClick: () => loadTopSongs(t),
              title: (t.name || '') + ' - ' + (t.updateTime || ''),
            },
              plCoverEl(t),
              React.createElement('span', { className: 'dsh-music-playlist-info' },
                React.createElement('span', { className: 'dsh-music-playlist-name' }, t.name),
                React.createElement('span', { className: 'dsh-music-playlist-meta' }, meta)));
          });
          const rows = topGroups.map((g) =>
            React.createElement('div', { key: g.id || g.name, className: 'dsh-music-qq-topgroup' },
              React.createElement('div', { className: 'dsh-music-hint' }, g.name),
              React.createElement('div', null, topCards(g.toplists))));
          content = React.createElement('div', null, rows);
        }
        body = React.createElement('div', null, content,
          browseErr ? React.createElement('div', { className: 'dsh-music-error' }, browseErr) : null,
          browseLoading ? React.createElement('div', { className: 'dsh-music-loading' }, '加载中…') : null);
      } else {
        const recCards = recs.length > 0 ? recs.map((p) => plCard(p)) : React.createElement('div', { className: 'dsh-music-hint' }, (recLoading ? '加载推荐歌单…' : (browseErr || '暂无推荐歌单')));
        const moreBtn = recs.length > 0 && recHasMore
          ? React.createElement('div', { className: 'dsh-music-qq-loadmore' },
            React.createElement('button', { className: 'dsh-music-qq-loadmore-btn', onClick: loadMoreRecommended },
              recLoadingMore ? '加载中…' : '加载更多'))
          : null;
        const content = React.createElement('div', null, recCards, moreBtn);
        body = React.createElement('div', null, content,
          browseErr ? React.createElement('div', { className: 'dsh-music-error' }, browseErr) : null,
          browseLoading ? React.createElement('div', { className: 'dsh-music-loading' }, '加载中…') : null);
      }

      // 榜单详情头（返回 + 榜名/封面）放在滚动容器 .dsh-music-qq-body 之外：
      // 头部不会被滚走，滚动条从头部下方开始、高度与歌曲列表对齐（不被头遮挡）。
      const topHeadRow = (browseTab === 'tops' && topDetail)
        ? React.createElement('div', { className: 'dsh-music-qq-tophead-fixed' },
            React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: backToTops }, '← 返回'),
            React.createElement('div', { className: 'dsh-music-qq-topdetail-head' },
              topDetail.cover ? React.createElement('img', {
                className: 'dsh-music-playlist-cover', src: topDetail.cover, alt: '', loading: 'lazy',
                onError: (e) => { e.currentTarget.style.display = 'none'; },
              }) : null,
              React.createElement('div', null,
                React.createElement('div', { className: 'dsh-music-playlist-name' }, topDetail.name),
                React.createElement('div', { className: 'dsh-music-hint' },
                  (topDetail.updateTime ? '更新于 ' + topDetail.updateTime + ' · ' : '')
                  + (topTotal ? (topDetail.songs || []).length + ' / ' + topTotal + ' 首' : '')))),
            (topDetail.songs && topDetail.songs.length)
              ? React.createElement('button', { className: 'dsh-music-qq-playall', onClick: playAllKGTops }, '▶ 播放全部')
              : null)
        : null;
      const head = React.createElement('div', { className: 'dsh-music-qq-head' },
        React.createElement('div', { className: 'dsh-music-qq-toolbar' },
          React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: openQueue }, '播放列表'),
          React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: doLogout }, '退出登录')),
        React.createElement('div', { className: 'dsh-music-qq-viewtabs' },
          browseTabBtn('mine', '我的歌单'),
          browseTabBtn('recommend', '推荐歌单'),
          browseTabBtn('category', '分类歌单'),
          browseTabBtn('tops', '排行榜'),
          browseTabBtn('search', '搜索')));
      return React.createElement('div', { className: 'dsh-music-qq' },
        head,
        searchRow,
        resultTabsRow,
        topHeadRow,
        React.createElement('div', { className: 'dsh-music-qq-body' }, body),
        loginModal,
        kgJoinMenu);
    }

    // 在线 QQ 面板的「上次所在层」只在本次会话首次恢复一次，避免切 tab
    // （QQ 音乐 ↔ 本地音乐/AI讲书）重新挂载时又被持久化的旧层拉回播放列表页。
    let qqUiRestored = false;
    function QQOnlinePanel({ panelRef }) {
      const s = useStore();
      const [loggedIn, setLoggedIn] = useState(s.qqLoggedIn || false);
      const [uin, setUin] = useState(s.qqUin || '');
      const [nickname, setNickname] = useState(s.qqNickname || '');
      // 两层 UI：layer='main' 主UI（登录/搜索/推荐/分类）；layer='playlist' 播放列表UI（当前队列或某歌单）。
      const [layer, setLayer] = useState('main');
      const [activePl, setActivePl] = useState(null); // { id?, name, creator?, songs, source }
      const [plLoading, setPlLoading] = useState(false); // 播放列表歌曲加载中
      const [browseTab, setBrowseTab] = useState('mine'); // mine | recommend | category | tops | new | search
      // 搜索（统一：歌曲 + 歌单）。
      const [q, setQ] = useState('');
      const [searched, setSearched] = useState(false);
      const [searching, setSearching] = useState(false);
      const [results, setResults] = useState([]);
      const [plResults, setPlResults] = useState([]);
      const [qError, setQError] = useState('');
      const [resultTab, setResultTab] = useState('songs'); // 搜索结果内：songs | playlists
      // 搜索分页：每页即接口单请求上限（歌曲 60、歌单 50）。「是否还有下一页」：
      // 歌曲搜索用接口 total（totalnum 可靠，实测热门词 600+）；歌单搜索既无 totalnum
      // 也没有可用 total（sum 是虚高展示数），且每页返回数不固定（49/46/44/35），只能
      // 用「最近一页返回较满(≥20)」判定还有更多。
      const QQ_PL_PAGE = 20;
      const [searchPage, setSearchPage] = useState(1);
      const [searchLastLen, setSearchLastLen] = useState(0);
      const [searchTotal, setSearchTotal] = useState(0);
      const [searchingMore, setSearchingMore] = useState(false);
      const [plSearchPage, setPlSearchPage] = useState(1);
      const [plSearchLastLen, setPlSearchLastLen] = useState(0);
      const [plSearchTotal, setPlSearchTotal] = useState(0);
      const [plSearchingMore, setPlSearchingMore] = useState(false);
      // 搜索历史（Host 持久化，最近在前）。
      const [hist, setHist] = useState([]);
      const [histOpen, setHistOpen] = useState(false);
      const histRef = useRef(null);
      const histPopRef = useRef(null); // portal 到 body 的历史下拉（点击内部不关闭）
      // 恢复「在线播放列表」层：prefsReady 早于 restorePlayback 灌 qqQueue，队列就绪前
      // 先标记待恢复，等 qqQueue 非空后由下方 effect 补上（避免刷新后直接显示「暂无歌曲」）。
      const queueRestorePending = useRef(false);
      // 浏览。
      const [minePlays, setMinePlays] = useState([]);
      const [mineLoaded, setMineLoaded] = useState(false);
      const [recommended, setRecommended] = useState([]);
      const [categories, setCategories] = useState([]);
      const [catPlays, setCatPlays] = useState([]);
      const [curCategory, setCurCategory] = useState(null);
      const [browseErr, setBrowseErr] = useState('');
      const [browseLoading, setBrowseLoading] = useState(false);
      // 「加入歌单」弹窗：{ song, x, y }（锚点=「＋」按钮的视口坐标），点击弹出我的歌单列表。
      const [qqJoin, setQqJoin] = useState(null);
      const qqJoinRef = useRef(null);
      // 点击弹窗外关闭「加入歌单」弹窗。
      useEffect(() => {
        if (qqJoin === null) return;
        const onDown = (e) => { if (qqJoinRef.current !== null && !qqJoinRef.current.contains(e.target)) setQqJoin(null); };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
      }, [qqJoin]);
      // QQ 播放列表层：进入或切换播放曲目时，把正在播放的那一行滚动到可见位置。
      useEffect(() => {
        const list = qqPlRef.current;
        if (list === null) return;
        const active = list.querySelector('.dsh-music-track-row.active');
        if (active !== null && typeof active.scrollIntoView === 'function') {
          active.scrollIntoView({ block: 'nearest' });
        }
      }, [layer, s.currentId, activePl]);
      // 推荐歌单加载更多：热门推荐 12 条后用「全部分类」分页续载。
      const [recPage, setRecPage] = useState(1);
      const [recLoadingMore, setRecLoadingMore] = useState(false);
      const [recHasMore, setRecHasMore] = useState(true);
      // 分类歌单加载更多：每页 20 条，可翻页续载。
      const [catPage, setCatPage] = useState(1);
      const [catLoadingMore, setCatLoadingMore] = useState(false);
      const [catHasMore, setCatHasMore] = useState(true);
      // 分类 chips 折叠/展开：默认折叠只显示少量，展开显示全部。
      const [catExpanded, setCatExpanded] = useState(false);
      // 排行榜 + 新歌（发现页签）。
      const [topGroups, setTopGroups] = useState([]);
      const [topLoaded, setTopLoaded] = useState(false);
      const [topDetail, setTopDetail] = useState(null); // { id, name, songs }
      const [topLoading, setTopLoading] = useState(false);
      // 榜单详情分页：已加载歌曲总数 / 是否还有下一页 / 加载更多进行中。
      const [topTotal, setTopTotal] = useState(0);
      const [topHasMore, setTopHasMore] = useState(false);
      const [topLoadingMore, setTopLoadingMore] = useState(false);
      const [newSongs, setNewSongs] = useState([]);
      const [newLoaded, setNewLoaded] = useState(false);
      // 登录。
      const [loginMode, setLoginMode] = useState(null);
      const [qrImage, setQrImage] = useState('');
      const [loginStatus, setLoginStatus] = useState('');
      const [loginBusy, setLoginBusy] = useState(false);
      const [playingId, setPlayingId] = useState('');
      const pollRef = useRef(null);
      const qrKeyRef = useRef('');
      const loginModeRef = useRef(null);
      // QQ 播放列表层（layer='playlist'）的滚动容器（.dsh-music-qq-body）引用，
      // 用于进入/切歌时把正在播放的曲目滚动到可见位置。
      const qqPlRef = useRef(null);

      const json = (url) => jsonGet(url).catch(() => ({ ok: false, error: '网络错误' }));
      // 搜索历史（Host 持久化，最近在前，最多 10 条）。
      const loadHist = () => { try { const a = JSON.parse(loadPref(PREF_QQ_HISTORY)); return Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.trim()) : []; } catch { return []; } };
      const saveHist = (kw) => {
        kw = (kw || '').trim();
        if (!kw) return;
        const next = [kw, ...loadHist().filter((x) => x !== kw)].slice(0, 10);
        savePref(PREF_QQ_HISTORY, JSON.stringify(next));
        setHist(next);
      };
      const clearHist = () => { clearPref(PREF_QQ_HISTORY); setHist([]); };
      const clearPoll = () => { if (pollRef.current !== null) { try { clearInterval(pollRef.current); } catch {} try { clearTimeout(pollRef.current); } catch {} pollRef.current = null; } };
      // 记住当前操作所在层（主UI / 播放列表UI），下次弹窗恢复。
      const saveUi = (layer2, plId, plName) => { savePref(PREF_QQ_UI, JSON.stringify({ layer: layer2, plId: plId || '', plName: plName || '' })); };
      const loadUi = () => { try { return JSON.parse(loadPref(PREF_QQ_UI)); } catch { return null } };
      const restoreUi = (ui) => {
        if (!ui || ui.layer !== 'playlist') return;
        setLayer('playlist');
        if (ui.plId) {
          // 与 openPlaylist 同款加载态：先显示「加载中…」而不是空列表。QQ 歌单详情
          // 接口（fcg_ucc_getcdinfo_byids）在页面刚加载时首次请求常返回空 songlist
          // （冷缓存/会话未就绪），单次请求就会停在「暂无歌曲」——这正是「刷新后
          // 播放列表为空、返回重进才出来」的原因。这里对空结果/失败自动重试几次。
          setPlLoading(true);
          void loadPlaylistForRestore(ui.plId, ui.plName);
        } else {
          // 「在线播放列表」（openQueue 保存的 plId=''）：prefsReady 置位早于
          // restorePlayback 把 qqQueue 灌好，直接快照 s.qqQueue 会拿到空数组导致
          // 「暂无歌曲」。这里标记待恢复，由下方 [s.qqQueue] effect 在队列就绪后补上。
          queueRestorePending.current = true;
          setActivePl({ name: store.qqSource || '在线播放列表', songs: store.qqQueue || [], source: store.qqSource || '在线' });
        }
      };
      // 恢复的「在线播放列表」：等 restorePlayback 把 qqQueue 灌好后应用（修复刷新后
      // 该层显示为空的问题）；用户手动离开该层（返回/进入歌单）时取消待恢复。
      useEffect(() => {
        if (queueRestorePending.current && store.qqQueue && store.qqQueue.length > 0) {
          queueRestorePending.current = false;
          setActivePl({ name: store.qqSource || '在线播放列表', songs: store.qqQueue, source: store.qqSource || '在线' });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [s.qqQueue]);
      // 恢复歌单层：拉取歌单详情，空结果/失败自动重试（退避递增），成功后置入 activePl。
      const loadPlaylistForRestore = async (plId, plName, attempts = 3) => {
        let d = null;
        for (let i = 0; i < attempts; i++) {
          d = await json('/dsh-music/qq/playlist/' + encodeURIComponent(plId));
          if (d && d.ok && d.playlist && Array.isArray(d.playlist.songs) && d.playlist.songs.length > 0) break;
          if (i + 1 < attempts) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
        }
        if (d && d.ok && d.playlist) setActivePl({ ...d.playlist, source: plName || '歌单' });
        setPlLoading(false);
      };
      // ① 挂载时只做本地初始化：读搜索历史（Host 持久化）+ 查登录态（status 由
      // host 读本地 cookie 文件，不发任何外部网络请求）。外部数据（分类/推荐/我的
      // 歌单）一律延后到登录后（见下方 [loggedIn] effect），未登录零外部请求——
      // 本插件 QQ 在线功能以「登录」为门槛。
      useEffect(() => {
        setHist(loadHist());
        jsonGet('/dsh-music/qq/status').then((d) => { if (d) { setLoggedIn(!!d.loggedIn); setUin(d.uin || ''); setNickname(d.nickname || ''); } }).catch(() => {});
        // 点击搜索框外时关闭历史下拉（含 portal 到 body 的下拉本身）。
        const onDocClick = (e) => {
          if (histRef.current !== null && histRef.current.contains(e.target)) return;
          if (histPopRef.current !== null && histPopRef.current.contains(e.target)) return;
          setHistOpen(false);
        };
        document.addEventListener('mousedown', onDocClick);
        return () => { clearPoll(); document.removeEventListener('mousedown', onDocClick); };
      }, []);
      // Host 预置快照异步到达：一旦就绪，重读搜索历史并恢复上次所在层（面板可能
      // 先于 Host 快照挂载，挂载时读到的历史/层可能还是空的）。
      useEffect(() => {
        if (!s.prefsReady) return;
        setHist(loadHist());
        if (!qqUiRestored && loggedIn) { qqUiRestored = true; restoreUi(loadUi()); }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [s.prefsReady, loggedIn]);
      // ② 登录态变化时才加载在线数据：未登录（loggedIn=false）一个外部请求都不发；
      // 登录成功（setLoggedIn(true)）或已登录刷新页面（status 返回 true）时自动加载
      // 分类 / 我的歌单 / 推荐，并恢复上次所在层。登出后不再加载。
      useEffect(() => {
        if (!loggedIn) return;
        json('/dsh-music/qq/playlist-categories').then((d) => { if (d && d.ok) setCategories(d.categories || []); });
        // 默认落在「我的歌单」tab：登录态下加载我的歌单；未登录时主 UI 不显示。
        loadMine();
        loadRecommended();
        // 仅当 Host 预置就绪且本会话尚未恢复时，恢复上次所在层；之后切 tab 重挂
        // 不再拉回旧层。若此刻预置还没到（面板先挂载），留给上方 [prefsReady]
        // effect 在快照到达后恢复。
        if (!qqUiRestored && s.prefsReady) { qqUiRestored = true; restoreUi(loadUi()); }
      }, [loggedIn]);
      // ③ 收藏/取消收藏「我喜欢」后刷新「我的歌单」，让「我喜欢」歌单数目随之更新。
      useEffect(() => {
        if (s.qqFavRev > 0 && loggedIn) loadMine();
      }, [s.qqFavRev]);

      async function loadRecommended() {
        setBrowseLoading(true); setBrowseErr('');
        const d = await json('/dsh-music/qq/playlists');
        if (d && d.ok) setRecommended(d.playlists || []); else setBrowseErr((d && d.error) || '加载失败');
        setBrowseLoading(false);
      }
      // 加载更多推荐歌单：热门推荐固定 12 条，续载「全部分类」的分页歌单并去重。
      async function loadMoreRecommended() {
        if (recLoadingMore || !recHasMore) return;
        setRecLoadingMore(true); setBrowseErr('');
        const nextPage = recPage + 1;
        const d = await json('/dsh-music/qq/playlists?category=10000000&page=' + nextPage);
        if (d && d.ok && Array.isArray(d.playlists)) {
          const existing = new Set(recommended.map((p) => String(p.id)));
          const fresh = d.playlists.filter((p) => !existing.has(String(p.id)));
          setRecommended((prev) => [...prev, ...fresh]);
          setRecPage(nextPage);
          if (fresh.length === 0 || d.playlists.length < 20) setRecHasMore(false);
        } else {
          setBrowseErr((d && d.error) || '加载更多失败');
          setRecHasMore(false);
        }
        setRecLoadingMore(false);
      }
      async function loadMine() {
        setBrowseLoading(true); setBrowseErr('');
        const d = await json('/dsh-music/qq/my-playlists');
        if (d && d.ok) setMinePlays(d.playlists || []); else setBrowseErr((d && d.error) || '加载失败');
        setMineLoaded(true);
        setBrowseLoading(false);
      }
      // 删除自建歌单（DelPlaylist / PlaylistBaseWrite）。二次确认后调 Host，成功后本地移除。
      async function deleteMinePlaylist(pl) {
        const dirId = Number(pl && (pl.dirId || pl.tid || pl.id)) || 0;
        if (!dirId) { setBrowseErr('缺少歌单 dirId，无法删除'); return; }
        openConfirm('删除歌单', '确定删除 QQ 歌单「' + (pl.name || '') + '」？删除后不可恢复。', async () => {
          setBrowseLoading(true); setBrowseErr('');
          try {
            const d = await jsonPost('/dsh-music/qq/playlist-delete', { dirId });
            if (!d || !d.ok) throw new Error((d && d.error) || '删除歌单失败');
            setMinePlays((prev) => prev.filter((p) => String(p.id) !== String(pl.id)));
          } catch (err) {
            setBrowseErr(String((err && err.message) || err));
          }
          setBrowseLoading(false);
        }, '删除', true);
      }
      async function loadCategory(cat) {
        setCurCategory(cat); setCatPlays([]); setBrowseLoading(true); setBrowseErr('');
        setCatPage(1); setCatHasMore(true);
        const d = await json('/dsh-music/qq/playlists?category=' + encodeURIComponent(cat.id) + '&page=1');
        if (d && d.ok) setCatPlays(d.playlists || []); else setBrowseErr((d && d.error) || '加载失败');
        setBrowseLoading(false);
      }
      // 分类歌单加载更多：同分类翻页续载并去重。
      async function loadMoreCategory() {
        if (!curCategory || catLoadingMore || !catHasMore) return;
        setCatLoadingMore(true); setBrowseErr('');
        const nextPage = catPage + 1;
        const d = await json('/dsh-music/qq/playlists?category=' + encodeURIComponent(curCategory.id) + '&page=' + nextPage);
        if (d && d.ok && Array.isArray(d.playlists)) {
          const existing = new Set(catPlays.map((p) => String(p.id)));
          const fresh = d.playlists.filter((p) => !existing.has(String(p.id)));
          setCatPlays((prev) => [...prev, ...fresh]);
          setCatPage(nextPage);
          if (fresh.length === 0 || d.playlists.length < 20) setCatHasMore(false);
        } else {
          setBrowseErr((d && d.error) || '加载更多失败');
          setCatHasMore(false);
        }
        setCatLoadingMore(false);
      }
      async function loadTopLists() {
        if (topLoaded) return;
        setBrowseLoading(true); setBrowseErr('');
        const d = await json('/dsh-music/qq/top-lists');
        if (d && d.ok) setTopGroups(d.groups || []); else setBrowseErr((d && d.error) || '加载排行榜失败');
        setTopLoaded(true);
        setBrowseLoading(false);
      }
      const TOP_PAGE = 300;
      async function loadTopSongs(top) {
        setTopDetail(null); setTopLoading(true); setBrowseErr('');
        setTopTotal(0); setTopHasMore(false);
        const d = await json('/dsh-music/qq/top-songs?topId=' + encodeURIComponent(top.id) + '&offset=0&num=' + TOP_PAGE);
        if (d && d.ok) {
          const t = d.toplist || {};
          setTopDetail({ ...t, id: top.id, name: t.name || top.name, cover: t.cover || top.cover || '' });
          setTopTotal(Number(t.total) || (t.songs || []).length);
          setTopHasMore(!!t.hasMore);
        } else setBrowseErr((d && d.error) || '加载榜单失败');
        setTopLoading(false);
      }
      // 榜单「加载更多」：从当前已加载数量继续取下一页并追加，更新 total/hasMore。
      async function loadMoreTopSongs() {
        if (topLoadingMore || !topDetail) return;
        setTopLoadingMore(true); setBrowseErr('');
        const offset = (topDetail.songs || []).length;
        const d = await json('/dsh-music/qq/top-songs?topId=' + encodeURIComponent(topDetail.id || topDetail.topId) + '&offset=' + offset + '&num=' + TOP_PAGE);
        if (d && d.ok) {
          const t = d.toplist || {};
          setTopDetail((cur) => (cur ? { ...cur, songs: [...(cur.songs || []), ...((t.songs || []))] } : cur));
          setTopTotal(Number(t.total) || offset + (t.songs || []).length);
          setTopHasMore(!!t.hasMore);
        } else setBrowseErr((d && d.error) || '加载更多失败');
        setTopLoadingMore(false);
      }
      async function loadNewSongs() {
        if (newLoaded) return;
        setBrowseLoading(true); setBrowseErr('');
        const d = await json('/dsh-music/qq/new-songs?type=5');
        if (d && d.ok) setNewSongs((d.result && d.result.songs) || []); else setBrowseErr((d && d.error) || '加载新歌失败');
        setNewLoaded(true);
        setBrowseLoading(false);
      }
      function backToTops() { setTopDetail(null); setTopTotal(0); setTopHasMore(false); }
      // 「播放全部」：把歌单/榜单整列表作为播放队列，从第一首开始播。
      function playAllQQSongs() {
        const pl = activePl;
        if (!pl || !Array.isArray(pl.songs) || pl.songs.length === 0) return;
        // 与歌曲行一致的队列来源：我的歌单详情记该歌单，公开/其它为快照（不跟随）。
        const from = (pl.mine && pl.id) ? { kind: 'mine', id: String(pl.id), dirId: Number(pl._dirId) || 0 } : null;
        playSong(pl.songs[0], pl.songs, pl.name || 'QQ歌单', from);
      }
      function playAllQQTops() {
        const t = topDetail;
        if (!t || !Array.isArray(t.songs) || t.songs.length === 0) return;
        playSong(t.songs[0], t.songs, t.name || '排行榜', null);
      }
      function playAllQQNewSongs() {
        if (!Array.isArray(newSongs) || newSongs.length === 0) return;
        playSong(newSongs[0], newSongs, '新歌速递', null);
      }
      async function openPlaylist(pl, mine) {
        queueRestorePending.current = false; // 手动进入歌单，取消「在线播放列表」待恢复
        setActivePl(null); setLayer('playlist'); setPlLoading(true); saveUi('playlist', pl.id, pl.name);
        // _dirId：从歌单移除歌曲需要 QQ 歌单的目录 id（「我的歌单」卡片带 dirId）；
        // mine 标记这是「我自己的歌单」（含「我喜欢」），详情里才允许用「−」从该歌单移除。
        const _dirId = Number((pl && (pl.dirId || pl.tid || pl.id))) || 0;
        const d = await json('/dsh-music/qq/playlist/' + encodeURIComponent(pl.id));
        if (d && d.ok) setActivePl({ ...d.playlist, source: pl.name || '歌单', mine: !!mine, _dirId });
        else setBrowseErr((d && d.error) || '加载失败');
        setPlLoading(false);
      }
      // 按队列来源（我的歌单）拉最新内容，替换播放队列；返回新队列（或 null 未刷新）。
      // 保留当前播放曲目：若它已被移出歌单，插到队首继续播，播完「下一首」接新歌单第一首。
      // from 可显式传入（openQueue 从持久化恢复时，闭包里的 s.qqQueueFrom 可能还是旧的）。
      async function refreshQqQueueFromSource(from) {
        from = from || s.qqQueueFrom;
        if (!from || from.kind !== 'mine' || !from.id) return null;
        const d = await json('/dsh-music/qq/playlist/' + encodeURIComponent(from.id));
        if (!d || !d.ok || !Array.isArray(d.playlist.songs)) return null;
        const fresh = d.playlist.songs;
        const curMid = String(store.currentId || '').startsWith('qq:') ? String(store.currentId).slice(3) : null;
        let newQueue = fresh;
        if (curMid && !fresh.some((t) => String(t.songmid || t.id) === curMid)) {
          const cur = (s.qqQueue || []).find((t) => String(t.songmid || t.id) === curMid) || null;
          if (cur) newQueue = [cur, ...fresh];
        }
        set({ qqQueue: newQueue });
        return newQueue;
      }
      async function openQueue() {
        let songs = s.qqQueue || [];
        let src = s.qqSource;
        let from = s.qqQueueFrom;
        // 当前内存队列为空时，回退到持久化的在线队列：例如上次播的是本地音乐、
        // 刷新后 restoreLatest 只恢复了本地，但 QQ 队列仍单独保存在 PREF_PLAYBACK_QQ，
        // 打开「在线播放列表」应仍能看到它（本地/在线互不影响）。
        if (songs.length === 0) {
          const saved = loadQQPlayback();
          if (saved && Array.isArray(saved.queue) && saved.queue.length > 0) {
            songs = saved.queue;
            src = saved.source || src;
            if (saved.queueFrom && typeof saved.queueFrom === 'object') from = saved.queueFrom;
            // 加载进内存，便于「下一首」等后续操作直接使用；恢复来源歌单信息。
            set({ qqQueue: songs, qqSource: src || '', qqQueueFrom: from });
          }
        }
        // 队列来自「我的歌单」→ 拉最新内容（跟随外部/跨会话增删）。
        const fresh = await refreshQqQueueFromSource(from);
        if (fresh) songs = fresh;
        setActivePl({ name: src || '在线播放列表', songs, source: src || '播放中' });
        setLayer('playlist'); saveUi('playlist', '', '');
      }
      // 实时跟随：来源是「我的歌单」且其内容发生过增删（收藏/加歌/移除）→ 重拉队列；
      // 若正展示播放列表视图则同步可见列表。恢复带来源的队列时也会触发一次（rev 被 +1）。
      useEffect(() => {
        const from = s.qqQueueFrom;
        if (!from || from.kind !== 'mine' || (s.qqQueueRev || 0) === 0) return;
        let cancelled = false;
        refreshQqQueueFromSource().then((newQueue) => {
          if (cancelled || !newQueue) return;
          // 当前展示的是播放列表视图（activePl 无 id）→ 同步可见列表。
          if (layer === 'playlist' && activePl && activePl.id === undefined) {
            setActivePl((cur) => (cur ? { ...cur, songs: newQueue } : cur));
          }
        });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [s.qqQueueRev, s.qqQueueFrom]);
      function backToMain() { queueRestorePending.current = false; setLayer('main'); setActivePl(null); saveUi('main', '', ''); }
      async function doSearch(kwOverride) {
        const kw = (kwOverride !== undefined ? String(kwOverride) : q).trim();
        if (kw === '') { setSearched(false); setQError(''); return; }
        setHistOpen(false);
        saveHist(kw);
        setSearching(true); setQError(''); setResults([]); setPlResults([]); setSearched(true); setCurCategory(null);
        setSearchPage(1); setSearchLastLen(0); setSearchTotal(0); setPlSearchPage(1); setPlSearchLastLen(0); setPlSearchTotal(0);
        const [songs, pls] = await Promise.all([
          json('/dsh-music/qq/search?w=' + encodeURIComponent(kw) + '&page=1'),
          json('/dsh-music/qq/playlist-search?w=' + encodeURIComponent(kw) + '&page=1'),
        ]);
        if (songs && songs.ok) { setResults(songs.results || []); setSearchLastLen((songs.results || []).length); setSearchTotal(Number(songs.total) || (songs.results || []).length); setSearchPage(songs.page || 1); }
        else setQError((songs && songs.error) || '歌曲搜索失败');
        if (pls && pls.ok) { setPlResults(pls.playlists || []); setPlSearchLastLen((pls.playlists || []).length); setPlSearchTotal(Number(pls.total) || (pls.playlists || []).length); setPlSearchPage(pls.page || 1); }
        // 默认打开「有结果」的那个 tab（歌曲优先）。
        const sLen = (songs && songs.ok && (songs.results || []).length) || 0;
        const pLen = (pls && pls.ok && (pls.playlists || []).length) || 0;
        if (sLen > 0) setResultTab('songs');
        else if (pLen > 0) setResultTab('playlists');
        setSearching(false);
      }
      // 搜索结果「加载更多」：追加下一页（共用当前关键词 q）。
      async function loadMoreSongs() {
        const kw = q.trim();
        if (kw === '' || searchingMore) return;
        const next = searchPage + 1;
        setSearchingMore(true);
        try {
          const d = await json('/dsh-music/qq/search?w=' + encodeURIComponent(kw) + '&page=' + next);
          if (d && d.ok) {
            setResults((cur) => cur.concat(d.results || []));
            setSearchLastLen((d.results || []).length);
            setSearchTotal(Number(d.total) || (d.results || []).length);
            setSearchPage(d.page || next);
          }
        } catch {}
        setSearchingMore(false);
      }
      async function loadMorePls() {
        const kw = q.trim();
        if (kw === '' || plSearchingMore) return;
        const next = plSearchPage + 1;
        setPlSearchingMore(true);
        try {
          const d = await json('/dsh-music/qq/playlist-search?w=' + encodeURIComponent(kw) + '&page=' + next);
          if (d && d.ok) {
            setPlResults((cur) => cur.concat(d.playlists || []));
            setPlSearchLastLen((d.playlists || []).length);
            setPlSearchTotal(Number(d.total) || (d.playlists || []).length);
            setPlSearchPage(d.page || next);
          }
        } catch {}
        setPlSearchingMore(false);
      }
      function playSong(song, queue, sourceLabel, from) {
        // 未登录时点击 VIP 歌曲：不要启动注定失败的播放（否则播放条会误报
        // 「频谱不可用/音频加载失败」，重试也无济于事），改为提示并弹出登录。
        const isVip = song.payplay === 1 || (song.pay && song.pay.payplay === 1);
        if (isVip && !loggedIn) {
          setQError('VIP 歌曲需先登录才能播放，请扫码登录');
          startLogin('wx');
          return;
        }
        setPlayingId(String(song.songmid || song.id)); startQQPlayback(song, queue, sourceLabel, from);
      }

      // ---- 登录（扫码/轮询/退出）----
      async function startLogin(mode) {
        clearPoll();
        loginModeRef.current = mode; qrKeyRef.current = '';
        setLoginMode(mode); setLoginStatus('正在生成二维码…'); setLoginBusy(true); setQrImage('');
        try {
          const d = await jsonPost('/dsh-music/qq/login/start', { mode });
          if (!d || !d.ok) throw new Error((d && d.error) || '二维码创建失败');
          qrKeyRef.current = d.key || '';
          setQrImage(d.image || '');
          setLoginStatus(mode === 'qq' ? '请用 QQ App 扫码' : '请用微信 App 扫码');
          setLoginBusy(false);
          schedulePoll();
        } catch (e) { setLoginStatus(String((e && e.message) || e)); setLoginBusy(false); }
      }
      function schedulePoll() { if (loginModeRef.current === null || qrKeyRef.current === '') return; clearPoll(); pollRef.current = setTimeout(pollLogin, 1500); }
      async function pollLogin() {
        const key = qrKeyRef.current;
        if (!key) return;
        try {
          const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
          const timer = ctrl ? setTimeout(() => ctrl.abort(), 30000) : null;
          let d;
          try {
            d = await fetch('/dsh-music/qq/login/check?key=' + encodeURIComponent(key), { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined }).then((r) => r.json());
          } finally { if (timer) clearTimeout(timer); }
          if (!d || !d.ok) { setLoginStatus((d && d.error) || '查询失败，正在重试…'); schedulePoll(); return; }
          if (d.status === 'success') { clearPoll(); setLoggedIn(true); setUin(d.uin || ''); setNickname(d.nickname || ''); setLayer('main'); setActivePl(null); saveUi('main', '', ''); closeLogin(); refreshQQFavIds(); set({ qqLoggedIn: true, qqLoginFrom: d.loginFrom || '' }); }
          else if (d.status === 'scanned') { setLoginStatus('已扫码，请在手机上确认'); schedulePoll(); }
          else if (d.status === 'expired') { clearPoll(); setLoginStatus('二维码已过期'); }
          else if (d.status === 'failed') { clearPoll(); setLoginStatus(d.message || '登录失败'); }
          else if (d.status === 'waiting') { schedulePoll(); }
          else { schedulePoll(); }
        } catch (e) { setLoginStatus('获取登录状态超时，正在自动重试…'); schedulePoll(); }
      }
      function closeLogin() { clearPoll(); loginModeRef.current = null; qrKeyRef.current = ''; setLoginMode(null); setLoginStatus(''); setQrImage(''); }
      async function logout() {
        try { await jsonPost('/dsh-music/qq/login/logout', {}); } catch {}
        setLoggedIn(false); setUin(''); setNickname('');
        set({ qqLoggedIn: false, qqLoginFrom: '' });
        // 彻底清空所有 QQ 音乐浏览数据，避免换账号登录后看到上一个账号的歌单/搜索/浏览数据。
        setLayer('main'); setActivePl(null); setPlLoading(false); setBrowseTab('mine');
        setQ(''); setSearched(false); setSearching(false); setResults([]); setPlResults([]);
        setQError(''); setResultTab('songs'); setSearchPage(1); setSearchLastLen(0);
        setSearchingMore(false); setPlSearchPage(1); setPlSearchLastLen(0); setPlSearchingMore(false);
        setHist([]); setHistOpen(false);
        setMinePlays([]); setMineLoaded(false); setRecommended([]);
        setCategories([]); setCatPlays([]); setCurCategory(null); setBrowseErr(''); setBrowseLoading(false);
        setRecPage(1); setRecLoadingMore(false); setRecHasMore(true);
        setCatPage(1); setCatLoadingMore(false); setCatHasMore(true); setCatExpanded(false);
        setTopGroups([]); setTopLoaded(false); setTopDetail(null); setTopLoading(false);
        setTopTotal(0); setTopHasMore(false); setTopLoadingMore(false);
        setNewSongs([]); setNewLoaded(false);
        saveUi('main', '', '');
        // 清空在线播放队列与当前曲目（否则退出后播放条仍可「下一首」见上一账号的歌）。
        const isQQPlaying = String(store.currentId || '').startsWith('qq:') || store.scope?.kind === 'qq';
        if (isQQPlaying) {
          // 当前播的是 QQ 在线曲目 → 真正停止播放（pause + 清 src）并清空在线队列。
          // 用 stop() 而不是只 set state，否则音频仍在播，播放条仍显示/残留上一账号的曲目。
          stop();
          // 退出登录必须彻底清掉上一账号的在线队列持久化，否则刷新后仍会恢复出来。
          clearPref(PREF_PLAYBACK_QQ);
          set({ qqQueue: [], qqSource: '', qqQueueFrom: null, qqQueueRev: 0, qqFaved: false });
        } else {
          // 当前播的是本地/讲书 → 只清空在线队列（含持久化记录），保留当前播放。
          clearPref(PREF_PLAYBACK_QQ);
          set({ qqQueue: [], qqSource: '', qqQueueFrom: null, qqQueueRev: 0, qqFaved: false });
        }
      }

      // ---- 渲染辅助 ----
      const fmtCount = (n) => { const v = Number(n) || 0; if (v >= 1e8) return (v / 1e8).toFixed(1).replace(/\.0$/, '') + '亿'; if (v >= 1e4) return (v / 1e4).toFixed(1).replace(/\.0$/, '') + '万'; return String(v); };
      const songRow = (song, queue, sourceLabel, inMine) => {
        const id = String(song.songmid || song.id);
        const active = s.currentId === 'qq:' + id;
        const playing = active && s.playing;
        const vip = song.payplay === 1;
        const artists = (song.artists || []).join('/');
        // 播放队列来源（供「播放列表跟随歌单更新」）：
        //  - 我的歌单详情（activePl.mine，含我喜欢 dirId=201/自建）→ 记该歌单；
        //  - 播放列表视图（activePl 无 id）→ 沿用现有来源（同一队列内点歌）；
        //  - 公开歌单/搜索/榜单等 → null（快照，不跟随）。
        const queueFrom = (activePl && activePl.mine && activePl.id)
          ? { kind: 'mine', id: String(activePl.id), dirId: Number(activePl._dirId) || 0 }
          : (activePl && activePl.id === undefined ? (s.qqQueueFrom || null) : null);
        return React.createElement('div', { key: id, className: 'dsh-music-track-row' + (active ? ' active' : '') },
          React.createElement('button', {
            className: 'dsh-music-track' + (active ? ' active' : ''), title: song.title + ' - ' + artists,
            onClick: () => { if (active) togglePlay(); else playSong(song, queue, sourceLabel, queueFrom); },
          },
            React.createElement('span', { className: 'dsh-music-track-name qq' },
              React.createElement('span', { className: 'dsh-music-track-title' }, (playing ? '▶ ' : '') + song.title),
              vip ? React.createElement('span', { className: 'dsh-music-online-tag vip' }, 'VIP') : null),
            React.createElement('span', { className: 'dsh-music-online-tag' }, artists || 'QQ')),
          // 我的歌单详情：歌曲已在该歌单 → 显示「−」从该歌单移除；其它场景显示「＋」加入歌单。
          inMine
            ? React.createElement('button', {
              className: 'dsh-music-playlist-mini remove',
              title: '从「' + ((activePl && activePl.name) || '当前歌单') + '」移除',
              onClick: (e) => { e.stopPropagation(); removeFromActivePlaylist(song); },
            }, '−')
            : React.createElement('button', {
              className: 'dsh-music-playlist-mini add',
              title: '加入我的歌单',
              onClick: (e) => { e.stopPropagation(); openQqJoin(song, e); },
            }, '＋'));
      };
      // 从「我的歌单」当前歌单移除歌曲（DelSonglist）；「我喜欢」(dirId=201) 等同取消收藏。
      async function removeFromActivePlaylist(song) {
        const pl = activePl;
        if (!pl) return;
        const id = String(song.songmid || song.id);
        const dirId = Number(pl._dirId || pl.dirId || pl.id) || 0;
        try {
          const d = await jsonPost('/dsh-music/qq/playlist-remove', { song, dirId, tid: 0 });
          if (!d || !d.ok) throw new Error((d && d.error) || '从歌单移除失败');
          // 就地移除该行，并刷新「我的歌单」数目。
          setActivePl((cur) => (cur ? { ...cur, songs: (cur.songs || []).filter((t) => String(t.songmid || t.id) !== id) } : cur));
          loadMine();
          // 我的歌单内容变了 → 播放列表跟随刷新。
          set({ qqQueueRev: (store.qqQueueRev || 0) + 1 });
          // 「我喜欢」：同步收藏集合并把当前播放的这首歌标记为未收藏。
          if (dirId === 201) {
            refreshQQFavIds();
            if (String(s.currentId) === 'qq:' + id) set({ qqFaved: false });
          }
        } catch (err) { setQError(String((err && err.message) || err)); }
      }
      // 「加入歌单」：打开弹窗（列出我的歌单），并把歌曲加入所选歌单 / 新建歌单。
      // 成功/失败统一走面板居中的 toast 提示（成功关闭弹窗；失败保留弹窗可重试）。
      function openQqJoin(song, e) {
        const r = e.currentTarget.getBoundingClientRect();
        if (minePlays.length === 0 && !mineLoaded) loadMine();
        setQqJoin({ song, x: r.right, y: r.top });
      }
      async function qqJoinAddTo(pl) {
        const song = qqJoin && qqJoin.song;
        if (!song) return;
        const name = (pl && pl.name) || '歌单';
        try {
          // dirId 用歌单的权威 dirId（dirid），tid 固定 0（「我喜欢」dirId=201,tid=0 的可用模式）。
          const d = await jsonPost('/dsh-music/qq/playlist-add', { song, dirId: (pl && (pl.dirId || pl.tid || pl.id)) || 0, tid: 0 });
          if (!d || !d.ok) throw new Error((d && d.error) || '加入歌单失败');
          // 本地乐观 +1，并异步刷新「我的歌单」，让数目与实际一致。
          if (pl) {
            const pid = String(pl.id);
            setMinePlays((cur) => cur.map((p) => (String(p.id) === pid ? { ...p, trackCount: (Number(p.trackCount) || 0) + 1 } : p)));
            loadMine();
          }
          setQqJoin(null);
          showToast('添加到' + name + '成功', true);
          // 我的歌单内容变了 → 播放列表跟随刷新。
          set({ qqQueueRev: (store.qqQueueRev || 0) + 1 });
        } catch (err) { showToast('添加到' + name + '失败', false); }
      }
      async function qqJoinCreate() {
        const song = qqJoin && qqJoin.song;
        openPrompt('新建歌单名称', '', async (trimmed) => {
          if (!trimmed) return;
          try {
            const d = await jsonPost('/dsh-music/qq/playlist-create', { name: trimmed });
            if (!d || !d.ok || !d.playlist) throw new Error((d && d.error) || '创建歌单失败');
            const created = d.playlist;
            // AddPlaylist 返回的 id 即新歌单 dirid；AddSonglist 用该 dirid + tid=0 加歌。
            if (song) {
              const add = await jsonPost('/dsh-music/qq/playlist-add', { song, dirId: Number(created.id) || 0, tid: 0 });
              if (!add || !add.ok) throw new Error((add && add.error) || '加入新歌单失败');
            }
            loadMine();
            setQqJoin(null);
            showToast('添加到' + ((created && created.name) || trimmed) + '成功', true);
          } catch (err) { showToast('添加到' + trimmed + '失败', false); }
        });
      }
      const qqJoinMenu = qqJoin ? portalToBody((() => {
        const openUp = (qqJoin.y || 0) > ((window.innerHeight || 0) - 240);
        const style = {
          left: Math.max(8, (qqJoin.x || 0) - 150),
          top: openUp ? (qqJoin.y || 0) - 6 : (qqJoin.y || 0) + 8,
          transform: openUp ? 'translateY(-100%)' : 'none',
        };
        return React.createElement('div', { className: 'dsh-music-add-pop', ref: qqJoinRef, style },
          minePlays.length > 0 ? minePlays.map((p) => React.createElement('button', {
            key: p.id, className: 'dsh-music-add-pop-item',
            title: '加入「' + p.name + '」',
            onClick: () => qqJoinAddTo(p),
          }, p.name + (p.trackCount ? '（' + p.trackCount + '）' : ''))) : React.createElement('div', { className: 'dsh-music-hint', style: { padding: '2px 8px' } }, '暂无我的歌单，请先创建。'),
          React.createElement('button', { className: 'dsh-music-add-pop-item new', onClick: qqJoinCreate }, '＋ 新建歌单'),
        );
      })()) : null;
      const playRow = (pl, mine) => {
        // 注意：map((pl) => playRow(pl)) 会把数组下标作为第二个参数传入（Array#map 传
        // (element, index, array)）。这里必须用严格 true 判断「我的歌单」，否则推荐/分类/
        // 搜索等来源里除第一项外的卡片会把下标当真值，误显示删除按钮。
        const isMine = mine === true;
        const meta = (pl.trackCount > 0 ? pl.trackCount + ' 首' : '')
          + (pl.playCount ? ' · 播放 ' + fmtCount(pl.playCount) : '');
        // 「我的歌单」卡片类别标签：QQ 的「我喜欢」（dirId=201）是系统默认歌单，
        // 其余为本账号自建歌单（酷狗同款标识）。
        const isDefault = Number(pl && (pl.dirId || pl.tid || pl.id)) === 201;
        const kindTag = isMine ? React.createElement('span', {
          className: 'dsh-music-online-tag' + (isDefault ? ' default' : ''),
          title: isDefault ? '系统默认歌单（我喜欢）' : '自己创建的歌单',
        }, isDefault ? '默认' : '自建') : null;
        const card = React.createElement('button', {
          key: pl.id, className: 'dsh-music-playlist-card', title: pl.name + ' - ' + (pl.creator || ''),
          onClick: () => openPlaylist(pl, isMine),
        },
          plCoverEl(pl),
          React.createElement('span', { className: 'dsh-music-playlist-info' },
            React.createElement('span', { className: 'dsh-music-playlist-name-row' },
              React.createElement('span', { className: 'dsh-music-playlist-name' }, pl.name),
              kindTag),
            React.createElement('span', { className: 'dsh-music-playlist-meta' },
              (pl.creator ? pl.creator + ' · ' : '') + meta)));
        // 「我的歌单」卡片：右上角提供删除按钮（仅本人创建的歌单，「我喜欢」dirId=201 除外）。
        if (!isMine) return card;
        const dirId = Number(pl && (pl.dirId || pl.tid || pl.id)) || 0;
        const deletable = dirId !== 0 && dirId !== 201;
        return React.createElement('div', { key: pl.id, className: 'dsh-music-qq-mine-card' },
          card,
          deletable ? React.createElement('button', {
            className: 'dsh-music-qq-mine-del', title: '删除歌单「' + pl.name + '」',
            onClick: (e) => { e.stopPropagation(); deleteMinePlaylist(pl); },
          }, '✕') : null);
      };
      const catTab = (cat) => React.createElement('button', {
        key: cat.id, className: 'dsh-music-qq-cat' + (curCategory && curCategory.id === cat.id ? ' active' : ''),
        onClick: () => loadCategory(cat),
      }, cat.name);
      const browseTabBtn = (key, label) => React.createElement('button', {
        className: 'dsh-music-qq-viewtab' + (browseTab === key ? ' active' : ''),
        onClick: () => {
          setBrowseTab(key);
          if (key === 'recommend' && recommended.length === 0) loadRecommended();
          else if (key === 'mine' && minePlays.length === 0) loadMine();
          else if (key === 'tops' && !topLoaded) loadTopLists();
          else if (key === 'new' && !newLoaded) loadNewSongs();
        },
      }, label);
      // 搜索结果内的「歌曲 / 相关歌单」切换 tab。
      const resultTabBtn = (key, label) => React.createElement('button', {
        className: 'dsh-music-qq-resulttab' + (resultTab === key ? ' active' : ''),
        onClick: () => setResultTab(key),
      }, label);

      // 搜索框（放在「搜索」子tab内容里）。点击聚焦显示历史下拉，可直接输入或选历史。
      const searchBox = React.createElement('div', { className: 'dsh-music-qq-search', ref: histRef },
        React.createElement('div', { className: 'dsh-music-qq-inputwrap' },
          React.createElement('input', {
            className: 'dsh-music-qq-input', type: 'text', placeholder: '搜索 QQ 音乐（歌曲 / 歌单）',
            value: q,
            onChange: (e) => { setQ(e.target.value); if (e.target.value === '') setSearched(false); },
            onKeyDown: (e) => { if (e.key === 'Enter') doSearch(); },
            onFocus: () => { if (hist.length > 0) setHistOpen(true); },
          }),
          // 清除钮始终渲染、用 visibility 控制显隐，避免「有无 ×」导致输入框/UI 宽度抖动。
          React.createElement('button', {
            className: 'dsh-music-qq-clear' + (q === '' ? ' hidden' : ''),
            type: 'button', title: '清空输入',
            onClick: () => { setQ(''); setSearched(false); },
          }, '✕')),
        React.createElement('button', { className: 'dsh-music-settings-btn', onClick: () => doSearch() }, searching ? '搜索中…' : '搜索'));
      // 历史下拉 portal 到 body：搜索框在 .dsh-music-panel(overflow:hidden)/.dsh-music-qq-body
      // (overflow-y:auto) 内，绝对定位子元素会被裁剪不可见；portaled + fixed 锚定
      // 在搜索框正下方（与音量/模式/章节目录弹层同款逃逸方案）。
      const histPop = (histOpen && hist.length > 0)
        ? portalToBody(React.createElement('div', { className: 'dsh-music-qq-hist', style: anchorBelow(histRef.current, 420), ref: histPopRef },
          React.createElement('div', { className: 'dsh-music-qq-hist-head' },
            React.createElement('span', { className: 'dsh-music-hint' }, '搜索历史'),
            React.createElement('button', { className: 'dsh-music-qq-hist-clear', title: '清空历史', onClick: clearHist }, '清空')),
          hist.map((kw, idx) => React.createElement('button', {
            key: idx, className: 'dsh-music-qq-hist-item',
            onClick: () => { setQ(kw); doSearch(kw); },
          }, kw))))
        : null;

      // 扫码框以面板中心为基准居中（面板可拖拽），贴边时 clamp 不被裁掉。
      const qqLoginStyle = panelCenterStyle(panelRef, loginMode !== null, 170, 460);
      const loginModal = loginMode !== null ? portalToBody(React.createElement('div', { className: 'dsh-music-picker-overlay' },
        React.createElement('div', { className: 'dsh-music-picker qq-login', style: qqLoginStyle },
          React.createElement('div', { className: 'dsh-music-picker-head' },
            React.createElement('span', { className: 'dsh-music-picker-title' }, 'QQ 音乐登录'),
            React.createElement('button', { className: 'dsh-music-icon-btn', title: '关闭', onClick: closeLogin }, '✕')),
          React.createElement('div', { className: 'dsh-music-qq-login-body' },
            loginBusy && qrImage === '' ? React.createElement('div', { className: 'dsh-music-loading' }, '生成二维码…')
              : qrImage ? React.createElement('img', { className: 'dsh-music-qq-qr', src: qrImage, alt: '二维码' }) : null,
            React.createElement('div', { className: 'dsh-music-qq-login-status' }, loginStatus || ''),
            loginStatus !== '登录成功' ? React.createElement('div', { className: 'dsh-music-qq-login-actions' },
              React.createElement('button', { className: 'dsh-music-settings-btn', onClick: () => startLogin(loginMode) }, '刷新二维码'),
              React.createElement('button', { className: 'dsh-music-settings-btn', onClick: closeLogin }, '取消')) : null,
          )))) : null;

      // ---- 未登录：只显示居中两个登录按钮（QQ 登录 / 微信登录，分两行）+ 风险提示 ----
      if (!loggedIn) {
        return React.createElement('div', { className: 'dsh-music-qq dsh-music-qq-login' },
          React.createElement('div', { className: 'dsh-music-qq-login-center' },
            React.createElement('button', { className: 'dsh-music-qq-login-btn', onClick: () => startLogin('qq') }, 'QQ 登录'),
            React.createElement('button', { className: 'dsh-music-qq-login-btn', onClick: () => startLogin('wx') }, '微信登录'),
            React.createElement('div', { className: 'dsh-music-qq-login-warn' },
              React.createElement('div', { className: 'dsh-music-qq-login-warn-title' }, '使用声明（重要）'),
              React.createElement('div', { className: 'dsh-music-qq-login-warn-p' },
                '在线 QQ 音乐功能通过非官方接口访问 QQ 音乐资源，所播放/收藏的内容版权归版权方及 QQ 音乐平台所有。本功能仅供个人学习、技术研究、日常试听使用，严禁用于任何商业用途、公开传播、二次分发或盈利行为。使用本功能即表示您已知悉并同意：'),
              React.createElement('div', { className: 'dsh-music-qq-login-warn-item' },
                React.createElement('span', { className: 'dsh-music-qq-login-warn-num' }, '1'),
                React.createElement('span', null, '您应对自己的使用行为及其后果负责。')),
              React.createElement('div', { className: 'dsh-music-qq-login-warn-item' },
                React.createElement('span', { className: 'dsh-music-qq-login-warn-num' }, '2'),
                React.createElement('span', null, '因使用非官方接口登录/播放导致的账号风控、封禁、限流，以及可能引发的法律、版权纠纷，均由使用者自行承担。')),
              React.createElement('div', { className: 'dsh-music-qq-login-warn-item' },
                React.createElement('span', { className: 'dsh-music-qq-login-warn-num' }, '3'),
                React.createElement('span', null, '本项目作者不承担任何因此产生的直接或间接责任。')),
              React.createElement('div', { className: 'dsh-music-qq-login-warn-p' },
                '如您不同意以上条款，请勿使用本功能。'))),
          loginModal,
          qqJoinMenu);
      }

      // ---- 播放列表UI（第 2 层）：返回 + 可滚动歌曲列表 ----
      if (layer === 'playlist') {
        const pl = activePl || { name: '在线播放列表', songs: [], source: '在线' };
        return React.createElement('div', { className: 'dsh-music-qq' },
          React.createElement('div', { className: 'dsh-music-qq-head' },
            React.createElement('div', { className: 'dsh-music-qq-detail-head' },
              React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: backToMain }, '← 返回'),
              React.createElement('span', { className: 'dsh-music-settings-cur', title: pl.name }, pl.source === '歌单' ? '▸ 歌单：' + pl.name : pl.name),
              React.createElement('span', { className: 'dsh-music-hint' }, (pl.creator ? (pl.creator + ' · ') : '') + ((pl.songs || []).length + ' 首'))),
            pl.description ? React.createElement('p', { className: 'dsh-music-hint' }, pl.description) : null,
            (pl.songs && pl.songs.length)
              ? React.createElement('div', { className: 'dsh-music-qq-pl-actions' },
                React.createElement('button', { className: 'dsh-music-qq-playall', onClick: playAllQQSongs }, '▶ 播放全部'))
              : null),
          React.createElement('div', { className: 'dsh-music-qq-body', ref: qqPlRef },
            plLoading
              ? React.createElement('div', { className: 'dsh-music-hint' }, '加载中…')
              : (pl.songs && pl.songs.length
                ? React.createElement('div', null, pl.songs.map((song) => songRow(song, pl.songs, pl.name, pl.mine)))
                : React.createElement('div', { className: 'dsh-music-hint' }, '暂无歌曲。'))),
          loginModal,
          qqJoinMenu);
      }

      // ---- 主UI（第 1 层）：顶部工具栏 + 4 个子tab，只滚动子tab内容区 ----
      let body;
      // 搜索 tab 的固定行（在滚动容器 .dsh-music-qq-body 之外）：搜索框行 + 「歌曲/
      // 相关歌单」子tab 行，与 head 一样固定，滚动条只作用于其下方的结果内容。
      let searchRow = null;
      let resultTabsRow = null;
      if (browseTab === 'search') {
        const hasSongs = results.length > 0;
        const hasPls = plResults.length > 0;
        let resultContent = null;
        // 搜索分页「加载更多」：歌曲用接口 total（可靠）；歌单 total 缺失，用「最近一页较满(≥20)」。
        const songMoreBtn = (searchTotal > results.length)
          ? React.createElement('div', { className: 'dsh-music-qq-loadmore' },
            React.createElement('button', { className: 'dsh-music-qq-loadmore-btn', onClick: loadMoreSongs },
              searchingMore ? '加载中…' : '加载更多'))
          : null;
        const plMoreBtn = (plSearchLastLen >= QQ_PL_PAGE)
          ? React.createElement('div', { className: 'dsh-music-qq-loadmore' },
            React.createElement('button', { className: 'dsh-music-qq-loadmore-btn', onClick: loadMorePls },
              plSearchingMore ? '加载中…' : '加载更多'))
          : null;
        // 「歌曲 / 相关歌单」子tab 行固定在搜索框下方，不随结果滚动。
        if (hasSongs && hasPls) {
          resultTabsRow = React.createElement('div', { className: 'dsh-music-qq-resulttabs fixed' },
            resultTabBtn('songs', '歌曲'),
            resultTabBtn('playlists', '相关歌单'));
        }
        if (searching) {
          resultContent = React.createElement('div', { className: 'dsh-music-hint' }, '搜索中…');
        } else if (qError || !(hasSongs || hasPls)) {
          resultContent = React.createElement('div', { className: 'dsh-music-error' }, qError || '未找到相关结果。');
        } else if (resultTab === 'playlists' && hasPls) {
          resultContent = React.createElement('div', null, plResults.map((p) => playRow(p)), plMoreBtn);
        } else {
          resultContent = React.createElement('div', null, results.map((song) => songRow(song, results, '搜索结果')), songMoreBtn);
        }
        searchRow = React.createElement('div', { className: 'dsh-music-qq-searchrow' }, searchBox, histPop);
        // body 只放结果内容（在 .dsh-music-qq-body 滚动容器内）。
        body = searched ? React.createElement('div', null, resultContent) : null;
      } else {
        let content;
        if (browseTab === 'mine') {
          const listEl = !mineLoaded
            ? React.createElement('div', { className: 'dsh-music-hint' }, '加载我的歌单…')
            : (minePlays.length > 0
              ? minePlays.map((p) => playRow(p, true))
              : React.createElement('div', { className: 'dsh-music-hint' }, '暂无歌单。可到 QQ 音乐 App 创建或收藏歌单后再来查看。'));
          content = React.createElement('div', null, listEl);
          body = React.createElement('div', null, content,
            browseErr ? React.createElement('div', { className: 'dsh-music-error' }, browseErr) : null,
            browseLoading ? React.createElement('div', { className: 'dsh-music-loading' }, '加载中…') : null);
        } else if (browseTab === 'category') {
          const catMoreBtn = curCategory && catPlays.length > 0 && catHasMore
            ? React.createElement('div', { className: 'dsh-music-qq-loadmore' },
              React.createElement('button', { className: 'dsh-music-qq-loadmore-btn', onClick: loadMoreCategory },
                catLoadingMore ? '加载中…' : '加载更多'))
            : null;
          const CAT_COLLAPSED_COUNT = 8;
          const shownCats = catExpanded ? categories : categories.slice(0, CAT_COLLAPSED_COUNT);
          const catToggle = categories.length > CAT_COLLAPSED_COUNT
            ? React.createElement('button', { className: 'dsh-music-qq-cat-toggle', onClick: () => setCatExpanded((v) => !v) },
              catExpanded ? '收起' : '展开全部分类（' + categories.length + '）')
            : null;
          content = React.createElement('div', null,
            React.createElement('div', { className: 'dsh-music-qq-cats' }, shownCats.length ? shownCats.map(catTab) : React.createElement('span', { className: 'dsh-music-hint' }, '加载分类中…')),
            catToggle,
            curCategory ? React.createElement('div', null,
              (catPlays.length ? catPlays.map((p) => playRow(p)) : React.createElement('div', { className: 'dsh-music-hint' }, '该分类暂无歌单。')),
              catMoreBtn) : null);
          body = React.createElement('div', null, content,
            browseErr ? React.createElement('div', { className: 'dsh-music-error' }, browseErr) : null,
            browseLoading ? React.createElement('div', { className: 'dsh-music-loading' }, '加载中…') : null);
        } else if (browseTab === 'tops') {
          let content;
          if (topDetail) {
            // 榜单详情：返回 + 歌曲列表（支持「加载更多」分页续载）。
            const rows = topDetail.songs && topDetail.songs.length
              ? topDetail.songs.map((song) => songRow(song, topDetail.songs, topDetail.name))
              : React.createElement('div', { className: 'dsh-music-hint' }, '该榜单暂无歌曲。');
            const moreBtn = topHasMore
              ? React.createElement('div', { className: 'dsh-music-qq-loadmore' },
                React.createElement('button', { className: 'dsh-music-qq-loadmore-btn', onClick: loadMoreTopSongs },
                  topLoadingMore ? '加载中…' : '加载更多'))
              : null;
            content = React.createElement('div', null,
              rows,
              moreBtn);
          } else {
            const topCards = (tl) => tl.map((t) => {
              const meta = t.listenNum ? ((t.listenNum / 1e4).toFixed(0) + '万收听') : (t.totalNum ? t.totalNum + ' 首' : '');
              return React.createElement('button', {
                key: t.id, className: 'dsh-music-playlist-card',
                onClick: () => loadTopSongs(t),
                title: t.intro || '',
              },
                plCoverEl(t),
                React.createElement('span', { className: 'dsh-music-playlist-info' },
                  React.createElement('span', { className: 'dsh-music-playlist-name' }, t.name),
                  React.createElement('span', { className: 'dsh-music-playlist-meta' }, meta)));
            });
            const rows = topGroups.map((g) =>
              React.createElement('div', { key: g.id || g.name, className: 'dsh-music-qq-topgroup' },
                React.createElement('div', { className: 'dsh-music-hint' }, g.name),
                React.createElement('div', null, topCards(g.toplists))));
            content = React.createElement('div', null,
              topGroups.length ? rows : React.createElement('div', { className: 'dsh-music-hint' }, '加载排行榜…'),
              topLoading ? React.createElement('div', { className: 'dsh-music-loading' }, '加载榜单中…') : null);
          }
          body = React.createElement('div', null, content,
            browseErr ? React.createElement('div', { className: 'dsh-music-error' }, browseErr) : null,
            browseLoading ? React.createElement('div', { className: 'dsh-music-loading' }, '加载中…') : null);
        } else if (browseTab === 'new') {
          const rows = newSongs.length
            ? newSongs.map((song) => songRow(song, newSongs, '新歌速递'))
            : React.createElement('div', { className: 'dsh-music-hint' }, '加载新歌速递…');
          body = React.createElement('div', null, rows,
            browseErr ? React.createElement('div', { className: 'dsh-music-error' }, browseErr) : null,
            browseLoading ? React.createElement('div', { className: 'dsh-music-loading' }, '加载中…') : null);
        } else {
          const recCards = recommended.length > 0 ? recommended.map((p) => playRow(p)) : React.createElement('div', { className: 'dsh-music-hint' }, '加载推荐歌单…');
          const moreBtn = recommended.length > 0 && recHasMore
            ? React.createElement('div', { className: 'dsh-music-qq-loadmore' },
              React.createElement('button', { className: 'dsh-music-qq-loadmore-btn', onClick: loadMoreRecommended },
                recLoadingMore ? '加载中…' : '加载更多'))
            : null;
          content = React.createElement('div', null, recCards, moreBtn);
          body = React.createElement('div', null, content,
            browseErr ? React.createElement('div', { className: 'dsh-music-error' }, browseErr) : null,
            browseLoading ? React.createElement('div', { className: 'dsh-music-loading' }, '加载中…') : null);
        }
      }

      // 榜单详情头（返回 + 榜名/封面）放在滚动容器 .dsh-music-qq-body 之外：
      // 头部不会被滚走，滚动条从头部下方开始、高度与歌曲列表对齐（不被头遮挡）。
      const topHeadRow = (browseTab === 'tops' && topDetail)
        ? React.createElement('div', { className: 'dsh-music-qq-tophead-fixed' },
            React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: backToTops }, '← 返回'),
            React.createElement('div', { className: 'dsh-music-qq-topdetail-head' },
              topDetail.cover ? React.createElement('img', {
                className: 'dsh-music-playlist-cover', src: topDetail.cover, alt: '', loading: 'lazy',
                onError: (e) => { e.currentTarget.style.display = 'none'; },
              }) : null,
              React.createElement('div', null,
                React.createElement('div', { className: 'dsh-music-playlist-name' }, topDetail.name),
                React.createElement('div', { className: 'dsh-music-hint' },
                  (topDetail.updateTime ? '更新于 ' + topDetail.updateTime + ' · ' : '')
                  + (topTotal ? (topDetail.songs || []).length + ' / ' + topTotal + ' 首' : '')))),
            (topDetail.songs && topDetail.songs.length)
              ? React.createElement('button', { className: 'dsh-music-qq-playall', onClick: playAllQQTops }, '▶ 播放全部')
              : null)
        : null;
      // 新歌速递固定头（「播放全部」按钮，位于滚动容器之外，与榜单头一致）。
      const newHeadRow = (browseTab === 'new' && newSongs.length)
        ? React.createElement('div', { className: 'dsh-music-qq-tophead-fixed' },
            React.createElement('button', { className: 'dsh-music-qq-playall', onClick: playAllQQNewSongs }, '▶ 播放全部'))
        : null;
      const head = React.createElement('div', { className: 'dsh-music-qq-head' },
        React.createElement('div', { className: 'dsh-music-qq-toolbar' },
          React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: openQueue }, '播放列表'),
          React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: logout }, '退出登录')),
        React.createElement('div', { className: 'dsh-music-qq-viewtabs' },
          browseTabBtn('mine', '我的歌单'),
          browseTabBtn('recommend', '推荐歌单'),
          browseTabBtn('category', '分类歌单'),
          browseTabBtn('tops', '排行榜'),
          browseTabBtn('new', '新歌'),
          browseTabBtn('search', '搜索')));

      return React.createElement('div', { className: 'dsh-music-qq' },
        head,
        searchRow,
        resultTabsRow,
        newHeadRow,
        topHeadRow,
        React.createElement('div', { className: 'dsh-music-qq-body' }, body),
        loginModal,
        qqJoinMenu,
      );
    }

    function PlayerPanel() {
      const s = useStore();
      const isBook = s.currentId !== null && String(s.currentId).startsWith('book:');
      const listRef = useRef(null);
      const panelRef = useRef(null);
      // Draggable panel position + size ({x, y, w, h} left/top/width/height once
      // dragged or resized; null = CSS default: centered, 380px, auto height).
      const [pos, setPos] = useState(loadPanelPos);
      // The Host prefs snapshot arrives async (loadTracks -> loadServerPrefs).
      // Once it is ready, re-apply the persisted panel geometry — all prefs are
      // Host-backed now, so the mount-time value above comes from the snapshot.
      useEffect(() => {
        if (!s.prefsReady) return;
        const next = loadPanelPos();
        if (next !== null) setPos(next);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [s.prefsReady]);
      const dragRef = useRef(null);   // head-drag state
      const resizeRef = useRef(null); // corner-resize state
      // 曲库每行「＋」打开的「加入歌单」菜单：{track, x, y}（锚点=按钮右上角视口坐标）。
      const [addMenu, setAddMenu] = useState(null);
      const openAddMenu = (track, e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setAddMenu({ track, x: r.right, y: r.top });
      };

      // Once the panel is dragged/resized we switch from CSS centering
      // (left:50%; top:50%; translate(-50%,-50%)) to explicit left/top/width/height.
      // Locking height, clearing max-height and nulling the CSS translate matters:
      // with only top+left and the CSS max-height:72vh still applying, a fixed
      // element whose CSS also sets the translate would collapse/clamp and shift
      // by half its own size while dragging.
      // 面板常驻不卸载：关闭时仅用 display:none 隐藏（子树、QQ 面板状态全保留），
      // 重新打开时按播放类别重设 tab（见 togglePanel）并恢复显示。因此组件不会
      // 在关闭时 unmount，切 tab / 关面板重开都不会丢内部 useState 状态。
      const rootStyle = { ...(pos === null ? { minHeight: PANEL_AUTO_MIN_H } : { left: pos.x, top: pos.y, width: pos.w, height: pos.h, maxHeight: 'none', transform: 'none' }), display: s.panelOpen ? '' : 'none' };

      const onHeadDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        // don't start a drag from the close button
        if (e.target.closest && e.target.closest('.dsh-music-icon-btn')) return;
        const el = panelRef.current;
        if (el === null) return;
        const rect = el.getBoundingClientRect();
        const w = pos !== null ? pos.w : PANEL_W;
        const h = pos !== null ? pos.h : rect.height;
        const next = { x: pos !== null ? pos.x : rect.left, y: pos !== null ? pos.y : rect.top, w, h };
        dragRef.current = {
          startX: e.clientX, startY: e.clientY,
          originX: next.x, originY: next.y, w, h,
        };
        setPos(next);
        savePref(PREF_PANEL_POS, JSON.stringify(next));
        if (typeof e.currentTarget.setPointerCapture === 'function') e.currentTarget.setPointerCapture(e.pointerId);
      };
      const onHeadMove = (e) => {
        const d = dragRef.current;
        if (d === null) return;
        let x = d.originX + (e.clientX - d.startX);
        let y = d.originY + (e.clientY - d.startY);
        const el = panelRef.current;
        if (el !== null) {
          x = Math.max(0, Math.min(x, window.innerWidth - el.offsetWidth));
          y = Math.max(0, Math.min(y, window.innerHeight - el.offsetHeight));
        }
        const next = { x, y, w: d.w, h: d.h };
        setPos(next);
        savePref(PREF_PANEL_POS, JSON.stringify(next));
      };
      const onHeadUp = (e) => {
        dragRef.current = null;
        if (typeof e.currentTarget.releasePointerCapture === 'function'
          && typeof e.currentTarget.hasPointerCapture === 'function'
          && e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      };

      // Corner drag-to-resize: grow/shrink width & height from the bottom-right
      // handle, clamped to [min, max] and kept inside the viewport. The panel's
      // top-left (x/y) is untouched by a resize.
      const onResizeDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        const el = panelRef.current;
        if (el === null) return;
        const rect = el.getBoundingClientRect();
        const cur = {
          x: pos !== null ? pos.x : rect.left,
          y: pos !== null ? pos.y : rect.top,
          w: pos !== null ? pos.w : PANEL_W,
          h: pos !== null ? pos.h : rect.height,
        };
        resizeRef.current = { startX: e.clientX, startY: e.clientY, originW: cur.w, originH: cur.h };
        setPos(cur);
        savePref(PREF_PANEL_POS, JSON.stringify(cur));
        if (typeof e.currentTarget.setPointerCapture === 'function') e.currentTarget.setPointerCapture(e.pointerId);
      };
      const onResizeMove = (e) => {
        const d = resizeRef.current;
        if (d === null) return;
        const el = panelRef.current;
        const x = pos !== null ? pos.x : (el !== null ? el.getBoundingClientRect().left : 0);
        const y = pos !== null ? pos.y : (el !== null ? el.getBoundingClientRect().top : 0);
        const vw = window.innerWidth, vh = window.innerHeight;
        const maxW = Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, vw - x));
        const maxH = Math.min(Math.floor(vh * PANEL_MAX_H_VH), Math.max(PANEL_MIN_H, vh - y));
        const w = Math.max(PANEL_MIN_W, Math.min(d.originW + (e.clientX - d.startX), maxW));
        const h = Math.max(PANEL_MIN_H, Math.min(d.originH + (e.clientY - d.startY), maxH));
        const next = { x, y, w, h };
        setPos(next);
        savePref(PREF_PANEL_POS, JSON.stringify(next));
      };
      const onResizeUp = (e) => {
        resizeRef.current = null;
        if (typeof e.currentTarget.releasePointerCapture === 'function'
          && typeof e.currentTarget.hasPointerCapture === 'function'
          && e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      };

      useEffect(() => {
        if (!s.panelOpen) return;
        // Close the playlist panel when the user clicks outside it
        // (mousedown precedes the toggle's click, so both stay consistent).
        // Several popups are PORTALED to <body> (to escape the panel's
        // overflow:hidden clipping): directory/file pickers, the「加入歌单」menu,
        // the QQ search-history dropdown, the chapter TOC, and the bar's
        // mode/volume popups. A click inside any of them is technically outside
        // the panel's DOM, but they are part of the panel/bar UI — treat them as
        // "inside" so interacting never closes the panel underneath.
        // 播放条名称区（.dsh-music-bar-name，含怠速标题 .dsh-music-bar-idle）同样
        // 豁免：它们自身是面板的 toggle。若不豁免，面板打开时点歌名会先被这里的
        // mousedown 关掉、随后的 click toggle 又重新打开——表现为「再单击还是打开」
        // （真实浏览器 mousedown 恒先于 click；右侧按钮组豁免同理）。
        const onDown = (e) => {
          if (panelRef.current !== null && !panelRef.current.contains(e.target)
            && !(e.target.closest && (
              e.target.closest('.dsh-music-picker-overlay')
              || e.target.closest('.dsh-music-add-pop')
              || e.target.closest('.dsh-music-qq-hist')
              || e.target.closest('.dsh-music-toc')
              || e.target.closest('.dsh-music-mode-pop')
              || e.target.closest('.dsh-music-bar-vol-pop')
              || e.target.closest('.dsh-music-bar-btns')
              || e.target.closest('.dsh-music-bar-name')
              || e.target.closest('.dsh-music-bar-idle')
            ))) {
            set({ panelOpen: false });
          }
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
      }, [s.panelOpen]);
      useEffect(() => {
        if (!s.panelOpen) return;
        const list = listRef.current;
        if (list === null) return;
        const active = list.querySelector('.dsh-music-track.active');
        if (active !== null && typeof active.scrollIntoView === 'function') active.scrollIntoView({ block: 'nearest' });
      }, [s.panelOpen, s.currentId]);
      // 面板关闭时清掉「加入歌单」弹层状态，避免重开面板时残留。
      useEffect(() => { if (!s.panelOpen) setAddMenu(null); }, [s.panelOpen]);
      // 面板打开时检查并校正越界位置：屏幕分辨率变化（如外接显示器断开）
      // 可能导致持久化的坐标超出当前视口，面板被"隐藏"在屏幕外面。
      // 若面板至少有一个角在视口内则保留，否则重置为默认居中。
      useEffect(() => {
        if (!s.panelOpen || pos === null) return;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        if (pos.x + pos.w <= 0 || pos.x >= vw || pos.y + pos.h <= 0 || pos.y >= vh) {
          setPos(null);
        }
      }, [s.panelOpen, pos]);
      // 面板常驻不卸载：关闭时用根 div 的 display:none 隐藏，而非 return null。
      const rows = s.tracks.map((t) => {
        const active = t.id === s.currentId;
        const playing = active && s.playing;
        return React.createElement('div', { key: t.id, className: 'dsh-music-track-row' + (active ? ' active' : '') },
          React.createElement('button', {
            className: 'dsh-music-track' + (active ? ' active' : ''),
            title: t.path,
            // A browser's double-click fires the row's click twice: the first
            // click starts the track, the second lands on the now-active row and
            // would togglePlay() it (pausing it and aborting its pending play
            // promise — historically misreported as an autoplay block). Ignore
            // the repeat click (detail >= 2, plus a time-window fallback) so a
            // double-click keeps playing.
            onClick: (e) => { if (shouldIgnoreRowClick(e, active)) return; if (active) togglePlay(); else startPlayFrom(t.id, 'library'); },
          },
            React.createElement('span', { className: 'dsh-music-track-name' }, (playing ? '▶ ' : '') + t.name),
            React.createElement('span', { className: 'dsh-music-track-size' }, formatSize(t.size)),
          ),
          React.createElement('button', {
            className: 'dsh-music-playlist-mini add',
            title: '加入歌单',
            onClick: (e) => { e.stopPropagation(); openAddMenu(t, e); },
          }, '＋'),
        );
      });
      const bookRows = s.books.map((b) => {
        const active = 'book:' + b.id === s.currentId;
        const playing = active && s.playing;
        return React.createElement('button', {
          key: b.id,
          className: 'dsh-music-track' + (active ? ' active' : ''),
          title: b.path || b.name,
          onClick: (e) => { if (shouldIgnoreRowClick(e, active)) return; if (active) togglePlay(); else resumeOrPlayBook(b.id); },
        },
          React.createElement('span', { className: 'dsh-music-track-name' }, (playing ? '▶ ' : '') + b.name),
          React.createElement('span', { className: 'dsh-music-track-size' }, formatSize(b.size)),
        );
      });
      const tabBtn = (key, label) => React.createElement('button', {
        className: 'dsh-music-tab' + (s.tab === key ? ' active' : ''),
        onClick: () => set({ tab: key }),
      }, label);
      // 音乐页子标签：曲库 / 我最喜欢 / ＋ / 自建歌单
      const subTabBtn = (key, label, extraCls, rkey) => React.createElement('button', {
        key: rkey,
        className: 'dsh-music-subtab' + (s.subTab === key ? ' active' : '') + (extraCls ? ' ' + extraCls : ''),
        title: label,
        onClick: () => set({ subTab: key }),
      }, label);
      const musicSubTabs = React.createElement('div', { className: 'dsh-music-subtabs' },
        subTabBtn('library', '曲库'),
        subTabBtn(FAV_PLAYLIST_ID, '♥ 我最喜欢'),
        // 自建歌单排在 ＋ 号之前；＋ 固定在末尾用于新建。
        (s.playlists || []).filter((p) => p.id !== FAV_PLAYLIST_ID).map((p) => subTabBtn(p.id, p.name, null, p.id)),
        React.createElement('button', { className: 'dsh-music-subtab add', title: '新建歌单', onClick: onCreatePlaylist }, '＋'),
      );
      const isPlaylistView = s.subTab !== 'library';
      const plView = isPlaylistView ? playlistById(s.subTab) : null;
      const musicBody = plView
        ? React.createElement(PlaylistDetail, { pl: plView, panelRef })
        : (rows.length > 0
          ? rows
          : React.createElement('div', { className: 'dsh-music-empty' }, '暂无音乐。点击上方“选择音乐目录”并选择目录后自动扫描。'));
      // 各 tab 的内容常驻渲染、非活动 tab 用 display:none 隐藏：这样切 tab 时
      // 不会卸载任何面板（本地音乐 / QQ 面板 / AI 讲书），各自内部 useState 状态
      // 全部保留（例如 QQ 面板当前在「我的歌单/搜索/歌单详情」的哪个 UI）。
      const paneStyle = (key) => ({ display: s.tab === key ? '' : 'none' });
      const bookEmptyBody = s.books.length > 0
        ? bookRows
        : React.createElement('div', { className: 'dsh-music-empty' }, '未发现 .txt / .epub 小说文件。');
      // 三个 pane 直接在 .dsh-music-list（flex column）里；仅 QQ pane 设
      // flex:1 + min-height:0 + overflow:hidden（见 .dsh-music-qq-pane），让
      // .dsh-music-qq 撑满 pane 高度、.dsh-music-qq-body 独立滚动：播放列表 UI
      // 只滚歌曲列表，head（返回按钮/歌单名）固定不滚。本地音乐/讲书 pane 保持
      // 普通块级，超高时仍由 .dsh-music-list 滚动。
      const listBody = React.createElement('div', { className: 'dsh-music-list-body' },
        React.createElement('div', { style: paneStyle('music') }, musicBody),
        React.createElement('div', { className: 'dsh-music-qq-pane', style: paneStyle('qq') }, React.createElement(QQOnlinePanel, { panelRef })),
        React.createElement('div', { className: 'dsh-music-qq-pane', style: paneStyle('kg') }, React.createElement(KGOnlinePanel, { panelRef })),
        React.createElement('div', { style: paneStyle('book') }, bookEmptyBody),
        React.createElement('div', { className: 'dsh-music-news-pane', style: paneStyle('news') }, React.createElement(NewsPane, { panelRef })),
        React.createElement('div', { style: paneStyle('about') }, React.createElement(About, null)),
        React.createElement('div', { style: paneStyle('config') }, React.createElement(SystemSetting, null)));
      // 各 tab 主 UI 底部的提示（.dsh-music-tts-hint）：本地音乐=格式说明；AI 讲书=编号列表
      // （格式说明排首位 + xiaomi 语音）；新闻播报=编号列表（xiaomi 语音 + DeepSeek 搜索）；
      // 关于=免责声明。多于一条才加序号。
      const ttsHintLines = s.tab === 'book'
        ? ['支持 .txt / .epub 等格式。', 'AI 语音目前仅支持 xiaomi 提供方（限时免费），请在 DSH 设置中配置好再使用。']
        : (s.tab === 'news'
          ? ['AI 语音目前仅支持 xiaomi 提供方（限时免费），请在 DSH 设置中配置好再使用。',
             '新闻收集需要 DeepSeek 搜索服务（web_search 使用 DeepSeek 官方 API），请在 DSH 设置中配置好再使用。']
          : (s.tab === 'music'
            ? ['支持 mp3 / m4a / flac / wav / ogg / opus / aac / webm 等格式，自动递归扫描子目录。']
            : (s.tab === 'about' ? ['在线音乐功能通过非官方接口访问，内容版权归版权方及平台所有，仅供个人学习、技术研究与日常试听，严禁商业用途与二次分发；账号风控与法律风险由使用者自行承担。'] : null)));
      const ttsHint = ttsHintLines !== null
        ? React.createElement('div', { className: 'dsh-music-tts-hint' },
            ttsHintLines.map((line, i) => React.createElement('div', { key: i }, (ttsHintLines.length > 1 ? (i + 1) + '. ' : '') + line)))
        : null;
      return React.createElement('div', { className: 'dsh-music-panel', ref: panelRef, style: rootStyle },
        React.createElement('div', {
          className: 'dsh-music-panel-head dsh-music-panel-drag',
          onPointerDown: onHeadDown, onPointerMove: onHeadMove, onPointerUp: onHeadUp,
        },
          React.createElement('span', { className: 'dsh-music-panel-grip', 'aria-hidden': true }, '⠿'),
          React.createElement('span', { className: 'dsh-music-panel-title' }, 'DeepSeek Harness 音乐播放器'),
          React.createElement('button', { className: 'dsh-music-icon-btn', title: '关闭', onClick: () => set({ panelOpen: false }) }, '✕')),
        React.createElement('div', { className: 'dsh-music-panel-body' },
          // Tab 标签竖排在窗口左侧（侧边栏），内容区在其右侧。
          React.createElement('div', { className: 'dsh-music-tabs' },
            tabBtn('music', '本地音乐'), tabBtn('qq', 'QQ音乐'), tabBtn('kg', '酷狗音乐'), tabBtn('book', 'AI讲书'), tabBtn('news', '新闻播报'), tabBtn('config', '系统配置'), tabBtn('about', '关于')),
          React.createElement('div', { className: 'dsh-music-panel-content' },
            (s.tab === 'qq' || s.tab === 'kg' || s.tab === 'news' || s.tab === 'config' || s.tab === 'about') ? null : React.createElement(DirectorySetting, { panelRef }),
            s.tab === 'music' ? musicSubTabs : null,
            // 关于页头部（名称/版本/简介）固定在上方、不随卡片列表滚动。
            s.tab === 'about' ? React.createElement(AboutHead, null) : null,
            // While a novel is playing, keep music-only errors/scanning out of the
            // panel (novel status shows on the playback bar instead).
            // 音乐/小说统一在主列表区上方显示 error（设置块不再重复/分模式显示）。
            // 系统配置 / 关于页不显示曲库扫描相关的错误/加载提示。
            s.error && s.tab !== 'config' && s.tab !== 'about' ? React.createElement('div', { className: 'dsh-music-error' }, s.error) : null,
            !isBook && s.tab !== 'news' && s.tab !== 'config' && s.tab !== 'about' && s.loading ? React.createElement('div', { className: 'dsh-music-loading' }, '扫描中…') : null,
            React.createElement('div', { className: 'dsh-music-list', style: pos === null ? null : { maxHeight: 'none' }, ref: (el) => { listRef.current = el; } }, listBody),
            ttsHint,
          ),
        ),
        React.createElement('div', { className: 'dsh-music-resize', title: '拖动调整面板大小', onPointerDown: onResizeDown, onPointerMove: onResizeMove, onPointerUp: onResizeUp }),
        addMenu ? React.createElement(AddToPlaylistMenu, {
          track: addMenu.track, anchor: { x: addMenu.x, y: addMenu.y },
          onClose: () => setAddMenu(null),
        }) : null,
        s.prompt ? React.createElement(PromptModal, { key: s.prompt.id, panelRef }) : null,
        s.confirm ? React.createElement(ConfirmModal, { key: s.confirm.title, panelRef }) : null,
        s.whatsNewOpen ? React.createElement(WhatsNewModal, { key: 'whatsnew' }) : null,
        s.toast ? React.createElement('div', { className: 'dsh-music-panel-toast' + (s.toast.ok ? ' ok' : ' err') }, s.toast.text) : null,
      );
    }
    // ---- 歌词/字幕面板：双击播放条歌词打开，显示完整歌词并标识当前进度 ----
    // 复用播放面板的交互骨架：头部拖拽移动 + 右下角拉伸，默认居中；位置/尺寸独立
    // 持久化到 PREF_LYRIC_PANEL_POS（与播放面板互不影响）。面板常驻不卸载，
    // lyricPanelOpen 控制 display，歌词数据实时跟随当前播放内容（lyricLines/lyricCur）。
    function LyricPanel() {
      const s = useStore();
      const panelRef = useRef(null);
      const listRef = useRef(null);
      const [pos, setPos] = useState(loadLyricPanelPos);
      useEffect(() => {
        if (!s.prefsReady) return;
        const next = loadLyricPanelPos();
        if (next !== null) setPos(next);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [s.prefsReady]);
      const dragRef = useRef(null);
      const resizeRef = useRef(null);
      const rootStyle = { ...(pos === null ? { height: '40vh', maxHeight: '80vh' } : { left: pos.x, top: pos.y, width: pos.w, height: pos.h, maxHeight: 'none', transform: 'none' }), display: s.lyricPanelOpen ? '' : 'none' };
      const onHeadDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        if (e.target.closest && e.target.closest('.dsh-music-icon-btn')) return;
        const el = panelRef.current;
        if (el === null) return;
        const rect = el.getBoundingClientRect();
        const w = pos !== null ? pos.w : LYRIC_PANEL_W;
        const h = pos !== null ? pos.h : rect.height;
        const next = { x: pos !== null ? pos.x : rect.left, y: pos !== null ? pos.y : rect.top, w, h };
        dragRef.current = { startX: e.clientX, startY: e.clientY, originX: next.x, originY: next.y, w, h };
        setPos(next);
        savePref(PREF_LYRIC_PANEL_POS, JSON.stringify(next));
        if (typeof e.currentTarget.setPointerCapture === 'function') e.currentTarget.setPointerCapture(e.pointerId);
      };
      const onHeadMove = (e) => {
        const d = dragRef.current;
        if (d === null) return;
        let x = d.originX + (e.clientX - d.startX);
        let y = d.originY + (e.clientY - d.startY);
        const el = panelRef.current;
        if (el !== null) {
          x = Math.max(0, Math.min(x, window.innerWidth - el.offsetWidth));
          y = Math.max(0, Math.min(y, window.innerHeight - el.offsetHeight));
        }
        const next = { x, y, w: d.w, h: d.h };
        setPos(next);
        savePref(PREF_LYRIC_PANEL_POS, JSON.stringify(next));
      };
      const onHeadUp = (e) => {
        dragRef.current = null;
        if (typeof e.currentTarget.releasePointerCapture === 'function'
          && typeof e.currentTarget.hasPointerCapture === 'function'
          && e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      };
      const onResizeDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        const el = panelRef.current;
        if (el === null) return;
        const rect = el.getBoundingClientRect();
        const cur = {
          x: pos !== null ? pos.x : rect.left,
          y: pos !== null ? pos.y : rect.top,
          w: pos !== null ? pos.w : LYRIC_PANEL_W,
          h: pos !== null ? pos.h : rect.height,
        };
        resizeRef.current = { startX: e.clientX, startY: e.clientY, originW: cur.w, originH: cur.h };
        setPos(cur);
        savePref(PREF_LYRIC_PANEL_POS, JSON.stringify(cur));
        if (typeof e.currentTarget.setPointerCapture === 'function') e.currentTarget.setPointerCapture(e.pointerId);
      };
      const onResizeMove = (e) => {
        const d = resizeRef.current;
        if (d === null) return;
        const el = panelRef.current;
        const x = pos !== null ? pos.x : (el !== null ? el.getBoundingClientRect().left : 0);
        const y = pos !== null ? pos.y : (el !== null ? el.getBoundingClientRect().top : 0);
        const vw = window.innerWidth, vh = window.innerHeight;
        const maxW = Math.min(LYRIC_PANEL_MAX_W, Math.max(LYRIC_PANEL_MIN_W, vw - x));
        const maxH = Math.min(Math.floor(vh * LYRIC_PANEL_MAX_H_VH), Math.max(LYRIC_PANEL_MIN_H, vh - y));
        const w = Math.max(LYRIC_PANEL_MIN_W, Math.min(d.originW + (e.clientX - d.startX), maxW));
        const h = Math.max(LYRIC_PANEL_MIN_H, Math.min(d.originH + (e.clientY - d.startY), maxH));
        const next = { x, y, w, h };
        setPos(next);
        savePref(PREF_LYRIC_PANEL_POS, JSON.stringify(next));
      };
      const onResizeUp = (e) => {
        resizeRef.current = null;
        if (typeof e.currentTarget.releasePointerCapture === 'function'
          && typeof e.currentTarget.hasPointerCapture === 'function'
          && e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      };
      // 当前行高亮滚动到可视区**垂直居中**：每次 lyricCur 变化（换行/切歌/seek/下一首）
      // 都按当前行实际位置重新计算居中 scrollTop。绝对居中不依赖任何「上一次位置」
      // 的增量基准——增量方案在切歌/下一首时基准是旧歌的，会把高亮冲到错误位置。
      // useLayoutEffect 保证在浏览器绘制前完成滚动，一次到位（若用 useEffect 会在
      // 绘制后才滚，产生「先偏移再弹回中间」的两帧闪烁）。行高恒定（字号字重统一、
      // scrollbar-gutter: stable 防滚动条宽度变化）保证换行时 rect 准确、无抖动。
      // jsdom 无布局时全 0，赋值安全。
      useLayoutEffect(() => {
        if (!s.lyricPanelOpen) return;
        const list = listRef.current;
        if (list === null) return;
        const active = list.querySelector('.dsh-music-lyric-line.active');
        if (active === null) return;
        const listRect = list.getBoundingClientRect();
        const activeRect = active.getBoundingClientRect();
        const target = list.scrollTop + (activeRect.top - listRect.top) - (list.clientHeight - activeRect.height) / 2;
        const maxScroll = Math.max(0, list.scrollHeight - list.clientHeight);
        list.scrollTop = Math.max(0, Math.min(target, maxScroll));
      }, [s.lyricPanelOpen, s.lyricCur, s.lyricLines]);
      // 校正越界位置（分辨率变化后持久化坐标可能移出视口）。
      useEffect(() => {
        if (!s.lyricPanelOpen || pos === null) return;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        if (pos.x + pos.w <= 0 || pos.x >= vw || pos.y + pos.h <= 0 || pos.y >= vh) {
          setPos(null);
        }
      }, [s.lyricPanelOpen, pos]);
      const lines = s.lyricLines || [];
      const isBook = s.currentId !== null && String(s.currentId).startsWith('book:');
      const title = (hasTrackName(s) ? (s.currentName || '歌词') : '歌词/字幕') + (isBook ? '（字幕）' : '（歌词）');
      const rows = lines.length > 0
        ? lines.map((l, i) => React.createElement('div', {
            key: i,
            className: 'dsh-music-lyric-line' + (i === s.lyricCur ? ' active' : ''),
            'data-idx': i,
            // 文字放进内联 span：高亮背景只包裹文字长度，而非撑满整行；长歌词换行时
            // box-decoration-break: clone 让每段都带圆角+内边距。
          }, React.createElement('span', { className: 'dsh-music-lyric-line-text' }, l.text)))
        : React.createElement('div', { className: 'dsh-music-empty' }, '暂无歌词/字幕。');
      // ghost 类：透明模式（s.lyricPanelGhost）——CSS 隐去外壳背景/边框/阴影，
      // 歌词像直接显示在页面上；标题栏/关闭按钮/拉伸角标悬停面板时才显现。
      return React.createElement('div', { className: 'dsh-music-lyric-panel' + (s.lyricPanelGhost ? ' ghost' : ''), ref: panelRef, style: rootStyle },
        React.createElement('div', {
          className: 'dsh-music-panel-head dsh-music-panel-drag',
          onPointerDown: onHeadDown, onPointerMove: onHeadMove, onPointerUp: onHeadUp,
        },
          React.createElement('span', { className: 'dsh-music-panel-grip', 'aria-hidden': true }, '⠿'),
          React.createElement('span', { className: 'dsh-music-panel-title' }, title),
          React.createElement('button', { className: 'dsh-music-icon-btn', title: '关闭', onClick: () => set({ lyricPanelOpen: false }) }, '✕')),
        React.createElement('div', { className: 'dsh-music-lyric-panel-body', ref: listRef }, rows),
        React.createElement('div', { className: 'dsh-music-resize', title: '拖动调整面板大小', onPointerDown: onResizeDown, onPointerMove: onResizeMove, onPointerUp: onResizeUp }),
      );
    }
    // 歌词面板标题：有当前曲目则用曲名，否则通用标题。
    function hasTrackName(s) {
      return s && (s.currentName !== null || s.pendingName !== null);
    }
    // 自定义输入弹窗（替代浏览器 prompt）：新建/重命名歌单等需要名称输入的场景。
    // 以面板中心为基准居中；回车=确定、Esc/点遮罩/关闭=取消。key 由父级传 id，
    // 保证每次 openPrompt 打开时重新挂载、初始输入值正确。
    function PromptModal({ panelRef }) {
      const s = useStore();
      const p = s.prompt;
      if (p === null) return null;
      const [value, setValue] = useState(p.initial || '');
      const inputRef = useRef(null);
      useEffect(() => { if (inputRef.current) { inputRef.current.focus(); inputRef.current.select(); } }, []);
      const submit = () => {
        const v = value.trim();
        if (v === '') return;
        closePrompt();
        if (typeof p.onOk === 'function') p.onOk(v);
      };
      const cancel = () => closePrompt();
      const onKeyDown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      };
      return portalToBody(React.createElement('div', { className: 'dsh-music-picker-overlay' },
        React.createElement('div', { className: 'dsh-music-picker prompt', style: panelCenterStyle(panelRef, true, 150, 160) },
          React.createElement('div', { className: 'dsh-music-picker-head' },
            React.createElement('span', { className: 'dsh-music-picker-title' }, p.title),
            React.createElement('button', { className: 'dsh-music-icon-btn', title: '关闭', onClick: cancel }, '✕')),
          React.createElement('input', {
            className: 'dsh-music-prompt-input', ref: inputRef, value,
            placeholder: '请输入名称', onChange: (e) => setValue(e.target.value), onKeyDown,
            'aria-label': p.title,
          }),
          React.createElement('div', { className: 'dsh-music-picker-foot' },
            React.createElement('button', { className: 'dsh-music-settings-btn', onClick: submit }, '确定'),
            React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: cancel }, '取消')),
        )));
    }
    // 自定义确认弹窗（替代浏览器 confirm）：删除/清空歌单等破坏性操作前的确认。
    // 无输入框，仅标题 + 提示消息 + 确定/取消；以面板中心为基准居中。
    function ConfirmModal({ panelRef }) {
      const s = useStore();
      const c = s.confirm;
      if (c === null) return null;
      const ok = () => { closeConfirm(); if (typeof c.onOk === 'function') c.onOk(); };
      const onKeyDown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); ok(); }
        else if (e.key === 'Escape') { e.preventDefault(); closeConfirm(); }
      };
      return portalToBody(React.createElement('div', { className: 'dsh-music-picker-overlay' },
        React.createElement('div', { className: 'dsh-music-picker confirm', style: panelCenterStyle(panelRef, true, 150, 280), onKeyDown },
          React.createElement('div', { className: 'dsh-music-picker-head' },
            React.createElement('span', { className: 'dsh-music-picker-title' }, c.title),
            React.createElement('button', { className: 'dsh-music-icon-btn', title: '关闭', onClick: closeConfirm }, '✕')),
          c.message ? React.createElement('p', { className: 'dsh-music-hint' }, c.message) : null,
          React.createElement('div', { className: 'dsh-music-picker-foot' },
            React.createElement('button', { className: 'dsh-music-settings-btn' + (c.danger ? ' danger' : ''), onClick: ok }, c.okText),
            React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: closeConfirm }, '取消')),
        )));
    }
    // ---- 版本更新弹窗（What's New）----
    // 三种形态：welcome（首装欢迎）/ upgrade（升级：当前版更新内容 + 历史折叠）/
    // history（「关于」页手动查看，完整历史直列）。全部内容来自 manifest 下发
    //（whatsNew / whatsNewHistory / whatsNewWelcome），客户端不维护更新文案。
    const WHATSNEW_SEC_LABEL = { feature: '✨ 新特性', improve: '⚡ 优化', fix: '🐛 修复' };
    function WhatsNewSection({ sec }) {
      if (!sec || !Array.isArray(sec.items) || sec.items.length === 0) return null;
      const label = WHATSNEW_SEC_LABEL[sec.type] || WHATSNEW_SEC_LABEL.improve; // 未知类型兜底
      return React.createElement('div', { className: 'dsh-music-whatsnew-sec' },
        React.createElement('div', { className: 'dsh-music-whatsnew-sec-title' }, label),
        sec.items.map((it, i) => React.createElement('div', { key: i, className: 'dsh-music-whatsnew-item' }, String(it))));
    }
    function WhatsNewModal() {
      const s = useStore();
      const [histOpen, setHistOpen] = useState(false);
      // history 模式（关于页完整更新日志）：各版本默认折叠，仅最新版（当前版）展开——
      // 点击版本头部展开/收起，避免一打开就被一屏旧内容淹没。
      const [openVers, setOpenVers] = useState(() => {
        const arr = Array.isArray(s.whatsNewHistory) ? s.whatsNewHistory : [];
        const first = arr[0];
        return new Set(first && first.version ? [first.version] : []);
      });
      // Esc 关闭：挂在 document 上（弹窗不设自动聚焦元素，容器 onKeyDown 方案
      // 需先点一下才有焦点，不可靠）。
      useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); dismissWhatsNew(); } };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, []);
      const mode = s.whatsNewMode;
      const isWelcome = mode === 'welcome';
      const entry = mode === 'upgrade' ? (s.whatsNew || null) : null;
      const welcome = s.whatsNewWelcome || { sections: [] };
      const mainSections = isWelcome ? (welcome.sections || []) : ((entry && entry.sections) || []);
      // 历史列表：upgrade 模式折叠展开时跳过当前版（正文已在上方，避免重复）；
      // history 模式直列全部（含当前版）。
      const historyAll = Array.isArray(s.whatsNewHistory) ? s.whatsNewHistory : [];
      const history = (mode === 'history' || entry === null)
        ? historyAll
        : historyAll.filter((h) => h && h.version !== entry.version);
      const showHist = mode === 'history' || histOpen;
      const toggleVer = (ver) => {
        const next = new Set(openVers);
        if (next.has(ver)) next.delete(ver); else next.add(ver);
        setOpenVers(next);
      };
      // historyAll 晚于挂载到达（manifest 异步下发）时补开最新版（默认「最新展开、旧版折叠」）。
      useEffect(() => {
        if (mode !== 'history' || openVers.size !== 0 || historyAll.length === 0) return;
        const first = historyAll[0];
        if (first && first.version) setOpenVers(new Set([first.version]));
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [mode, historyAll, openVers.size]);
      // 标题/副标题：welcome 用欢迎语；upgrade 强调「新版本」；history 是手动
      // 查看完整日志的中性标题（不带 NEW 徽章）。
      const title = isWelcome
        ? (welcome.title || '欢迎使用 DSH 音乐播放器')
        : (mode === 'history'
          ? '更新日志'
          : '新版本 v' + ((entry && entry.version) || s.version || ''));
      const sub = isWelcome
        ? (s.description || '')
        : (mode === 'history'
          ? (s.description || '')
          : [(entry && entry.title) || '', (entry && entry.date) || ''].filter(Boolean).join(' · '));
      return portalToBody(React.createElement('div', {
          className: 'dsh-music-picker-overlay',
          // 点遮罩空白处关闭（点在面板内部不关）。
          onClick: (e) => { if (e.target === e.currentTarget) dismissWhatsNew(); },
        },
        React.createElement('div', { className: 'dsh-music-whatsnew', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
          React.createElement('div', { className: 'dsh-music-whatsnew-head' },
            React.createElement('span', { className: 'dsh-music-whatsnew-logo', 'aria-hidden': true }, '♪'),
            // 插件名常驻头部：弹窗 portal 到 body、独立于播放面板展示，升级/历史
            // 模式下用户需要一眼看出这是哪个插件的更新说明。welcome 模式标题本身
            // 已含插件名，不再重复一行。
            React.createElement('div', { className: 'dsh-music-whatsnew-head-text' },
              mode !== 'welcome' ? React.createElement('div', { className: 'dsh-music-whatsnew-app' }, 'DSH音乐播放器') : null,
              React.createElement('div', { className: 'dsh-music-whatsnew-title' }, title)),
            mode === 'upgrade' ? React.createElement('span', { className: 'dsh-music-whatsnew-badge' }, 'NEW') : null,
            React.createElement('button', { className: 'dsh-music-icon-btn', title: '关闭', onClick: dismissWhatsNew }, '✕')),
          sub ? React.createElement('div', { className: 'dsh-music-whatsnew-sub' }, sub) : null,
          React.createElement('div', { className: 'dsh-music-whatsnew-body' },
            mainSections.map((sec, i) => React.createElement(WhatsNewSection, { key: i, sec })),
            mode !== 'history' && history.length > 0
              ? React.createElement('div', {
                  className: 'dsh-music-whatsnew-hist-toggle', title: '查看更早版本的更新内容',
                  onClick: () => setHistOpen(!histOpen),
                }, (histOpen ? '▾' : '▸') + ' 历史版本')
              : null,
            showHist && history.length > 0
              ? history.map((h, i) => {
                const ver = (h && h.version) || ('h' + i);
                // history 模式：各版本可折叠（默认仅最新版展开）；upgrade 模式保持直列展开。
                const open = mode === 'history' ? openVers.has(ver) : true;
                return React.createElement('div', { key: ver, className: 'dsh-music-whatsnew-hist' },
                  React.createElement('div', {
                    className: 'dsh-music-whatsnew-hist-head'
                      + (mode === 'history' ? ' clickable' : '') + (open ? ' open' : ''),
                    title: mode === 'history' ? '点击展开/收起' : undefined,
                    onClick: mode === 'history' ? () => toggleVer(ver) : undefined,
                  },
                    (mode === 'history' ? (open ? '▾ ' : '▸ ') : '')
                      + 'v' + ((h && h.version) || '?') + ((h && h.date) ? ' · ' + h.date : '')),
                  open ? ((Array.isArray(h.sections) ? h.sections : []).map((sec, j) => React.createElement(WhatsNewSection, { key: j, sec }))) : null);
              })
              : null),
          React.createElement('div', { className: 'dsh-music-whatsnew-foot' },
            React.createElement('button', { className: 'dsh-music-settings-btn', onClick: dismissWhatsNew },
              isWelcome ? '开始使用' : (mode === 'history' ? '关闭' : '开始体验'))))));
    }
    // Directory setting block, embedded in the player panel (the former
    // 设置 → 音乐播放器 page moved in-panel so all library config lives in one place).
    function DirectorySetting({ panelRef }) {
      const s = useStore();
      const [pickerOpen, setPickerOpen] = useState(false);
      const [dirs, setDirs] = useState([]);
      const [files, setFiles] = useState([]);
      const [curPath, setCurPath] = useState('');
      const [curName, setCurName] = useState('');
      const [curCrumbs, setCurCrumbs] = useState([]);
      const [curUp, setCurUp] = useState(null);
      const [dirError, setDirError] = useState(null);
      // 手动刷新按钮：扫描进行中禁用并显示「刷新中…」。
      const [refreshing, setRefreshing] = useState(false);
      const isBook = s.tab === 'book';
      const activeRoot = isBook ? s.bookRoot : s.root;
      const pickerTitle = isBook ? '选择小说目录' : '选择音乐目录';
      const refreshTitle = isBook ? '重新扫描小说目录' : '重新扫描音乐目录';
      // 格式/AI 语音等提示统一移到各 tab 主 UI 底部（.dsh-music-tts-hint），顶部设置块不再放提示。
      return React.createElement('div', { className: 'dsh-music-settings' },
        React.createElement('div', { className: 'dsh-music-settings-row' },
          React.createElement('span', { className: 'dsh-music-settings-cur', title: activeRoot || '' },
            '📁 ' + (activeRoot || '未配置')),
          React.createElement('button', { className: 'dsh-music-settings-btn', onClick: () => openPicker() }, pickerTitle),
          // 手动刷新：重新扫描当前目录（新增文件后无需重选目录即可看到）。
          React.createElement('button', {
            className: 'dsh-music-settings-btn ghost',
            title: refreshTitle,
            disabled: refreshing,
            onClick: async () => {
              if (refreshing) return;
              setRefreshing(true);
              await rescanLibrary();
              setRefreshing(false);
            },
          }, refreshing ? '刷新中…' : '刷新')),
        pickerOpen ? portalToBody(React.createElement('div', { className: 'dsh-music-picker-overlay' },
          React.createElement('div', { className: 'dsh-music-picker', style: panelCenterStyle(panelRef, pickerOpen, 320, Math.round(window.innerHeight * 0.72)) },
            React.createElement('div', { className: 'dsh-music-picker-head' },
              React.createElement('span', { className: 'dsh-music-picker-title' }, pickerTitle),
              React.createElement('button', { className: 'dsh-music-icon-btn', title: '关闭', onClick: () => setPickerOpen(false) }, '✕')),
            React.createElement('div', { className: 'dsh-music-picker-cur', title: curPath },
              React.createElement('div', { className: 'dsh-music-picker-cur-left' },
                React.createElement('button', { className: 'dsh-music-crumb', onClick: () => browse('__drives__'), title: '本机磁盘' }, '💻 本机'),
                React.createElement('span', { className: 'dsh-music-crumb-sep' }, '›'),
                renderCrumbs(curCrumbs, curPath, curName, browse)
              ),
              React.createElement('div', { className: 'dsh-music-picker-cur-up' },
                curUp !== null ? React.createElement('button', { className: 'dsh-music-crumb up', onClick: () => browse(curUp), title: '上级目录' }, '↑') : null
              )),
            React.createElement('div', { className: 'dsh-music-picker-list' },
              // 目录排在前（可点击进入），文件排在后（仅作展示，不响应点击）。
              dirs.map((d) => React.createElement('button', {
                key: d.path,
                className: 'dsh-music-picker-item',
                title: d.path,
                onClick: () => browse(d.path),
              }, '📁 ' + d.name)),
              files.map((f) => React.createElement('span', {
                key: f.path,
                className: 'dsh-music-picker-item file',
                title: f.path,
              }, '📄 ' + f.name)),
              dirError ? React.createElement('div', { className: 'dsh-music-error' }, dirError) : null,
            ),
            React.createElement('div', { className: 'dsh-music-picker-foot' },
              React.createElement('button', { className: 'dsh-music-settings-btn', onClick: () => pickCurrent() }, '选择此目录'),
              React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: () => setPickerOpen(false) }, '取消'),
            ),
          ),
        )) : null,
      );
      function openPicker() {
        setPickerOpen(true);
        setDirError(null);
        // Open directly at the currently configured root (for this tab) so the
        // user sees the existing choice first; fall back to the home when unset.
        browse(activeRoot || '');
      }
      async function browse(path) {
        setDirError(null);
        try {
          const data = await jsonGet('/dsh-music/dir?path=' + encodeURIComponent(path || ''));
          if (data && data.error) { setDirError(data.error); return; }
          setCurPath(data.path || '');
          setCurName(data.name || '');
          setCurCrumbs(data.crumbs || []);
          setCurUp(data.up !== undefined ? data.up : null);
          setDirs(data.dirs || []);
          setFiles(data.files || []);
        } catch (err) {
          setDirError('读取目录失败：' + String((err && err.message) || err));
        }
      }
      function pickCurrent() {
        const p = curPath;
        // The drive-list view ("__drives__") is not a real directory.
        if (p === '' || p === '__drives__') return;
        setPickerOpen(false);
        saveRoot(p, isBook ? 'book' : 'music');
      }
    }
    // 系统配置面板（「系统配置」tab）：播放条歌词 / 频谱显示开关，持久化到 Host prefs。
    function SystemSetting() {
      const s = useStore();
      // 通用开关行：右侧一个开关按钮，点击切换并保存。
      const toggleRow = (label, desc, value, onChange) => React.createElement('div', { className: 'dsh-music-config-row' },
        React.createElement('div', { className: 'dsh-music-config-info' },
          React.createElement('span', { className: 'dsh-music-config-label' }, label),
          desc ? React.createElement('span', { className: 'dsh-music-config-desc' }, desc) : null),
        React.createElement('button', {
          className: 'dsh-music-toggle' + (value ? ' on' : ''),
          role: 'switch',
          'aria-checked': value,
          onClick: () => onChange(!value),
        }, React.createElement('span', { className: 'dsh-music-toggle-knob' })));
      // 沉浸感：鼠标移出后播放条变半透明。拖动滑块调节透明度。
      const immersePct = Math.round(s.immerse * 100);
      const immerseRow = React.createElement('div', { className: 'dsh-music-config-row' },
        React.createElement('div', { className: 'dsh-music-config-info' },
          React.createElement('span', { className: 'dsh-music-config-label' }, '沉浸感'),
          React.createElement('span', { className: 'dsh-music-config-desc' }, '鼠标移出后播放条的透明度')),
        React.createElement('div', { className: 'dsh-music-config-slider' },
          React.createElement('input', {
            className: 'dsh-music-config-range', type: 'range', min: 0, max: 100, step: 5,
            value: immersePct,
            onChange: (e) => set({ immerse: Number(e.target.value) / 100 }),
          }),
          React.createElement('span', { className: 'dsh-music-config-val' }, immersePct + '%')));
      // 歌词动效：分段选择器（单选按钮组）。参照主流播放器的换行风格：
      // none=无动效（硬切）｜slide=上滑淡入（网易云桌面词）
      // ｜blur=模糊浮入（Apple Music）｜karaoke=卡拉OK扫色（KTV，整行匀速点亮近似）。
      const fxOptions = [
        ['none', '无动效'],
        ['slide', '上滑淡入'],
        ['blur', '模糊浮入'],
        ['karaoke', '卡拉OK'],
      ];
      const lyricFxRow = React.createElement('div', { className: 'dsh-music-config-row' },
        React.createElement('div', { className: 'dsh-music-config-info' },
          React.createElement('span', { className: 'dsh-music-config-label' }, '歌词动效'),
          React.createElement('span', { className: 'dsh-music-config-desc' }, '歌词/字幕过渡风格')),
        React.createElement('div', { className: 'dsh-music-config-seg' },
          fxOptions.map(([val, label]) => React.createElement('button', {
            key: val,
            className: 'dsh-music-config-seg-btn' + (s.lyricFx === val ? ' on' : ''),
            onClick: () => set({ lyricFx: val }),
            'aria-pressed': s.lyricFx === val,
            title: label,
          }, label))));
      // 频谱样式：柱状图（经典 12 段）或波形图（示波器式连续曲线）。两者都只由
      // 实时 captureStream 捕获驱动，失败即不显示（无离线回退）。
      const vizModeOptions = [
        ['bars', '柱状图'],
        ['wave', '波形图'],
      ];
      const vizModeRow = React.createElement('div', { className: 'dsh-music-config-row' },
        React.createElement('div', { className: 'dsh-music-config-info' },
          React.createElement('span', { className: 'dsh-music-config-label' }, '频谱样式'),
          React.createElement('span', { className: 'dsh-music-config-desc' }, '柱状图（频段能量）或波形图（示波器曲线）')),
        React.createElement('div', { className: 'dsh-music-config-seg' },
          vizModeOptions.map(([val, label]) => React.createElement('button', {
            key: val,
            className: 'dsh-music-config-seg-btn' + (s.vizMode === val ? ' on' : ''),
            onClick: () => set({ vizMode: val }),
            'aria-pressed': s.vizMode === val,
            title: label,
          }, label))));
      // 分组卡片：把相关的配置行放进同一个带标题的卡片里（歌词一组、频谱一组），
      // 卡片内行之间用细分隔线，视觉上归为一类。
      // 分组卡片：把相关的配置行放进同一个外框里（歌词一组、频谱一组），卡片内行之间
      // 用细分隔线，视觉上归为一类（无标题文字）。
      const configCard = (...children) => React.createElement('div', { className: 'dsh-music-config-card' }, children);
      return React.createElement('div', { className: 'dsh-music-config' },
        configCard(
          toggleRow('歌词显示', '播放条上显示当前歌词 / 讲书字幕', s.showLyric, (v) => set({ showLyric: v })),
          // 歌词动效依附于歌词显示：关闭歌词时隐藏该配置行（已存的动效偏好保留，
          // 重新打开歌词后原样恢复）。
          s.showLyric ? lyricFxRow : null,
        ),
        // 歌词面板透明模式：外壳隐身、歌词像直接显示在页面上（默认开）。
        // 独立行紧跟歌词分组卡片下方（与歌词显示相关的配置就近排列）。
        toggleRow('歌词面板透明', '歌词/字幕面板隐去背景边框，歌词像直接显示在页面上（悬停显示标题/关闭）', s.lyricPanelGhost, (v) => set({ lyricPanelGhost: v })),
        configCard(
          toggleRow('频谱显示', '播放条上显示实时音频频谱', s.showViz, (v) => set({ showViz: v })),
          s.showViz ? vizModeRow : null,
        ),
        toggleRow('音质徽章显示', '在歌名后显示音质徽章', s.showQuality, (v) => set({ showQuality: v })),
        toggleRow('进度条显示', '播放条底部显示播放进度条', s.showProgress, (v) => set({ showProgress: v })),
        toggleRow('播放条背景显示', '显示播放条边框与背景色', s.showBarBg, (v) => set({ showBarBg: v })),
        immerseRow,
      );
    }
    // 关于页头部（插件名称 + 版本徽章 + 简介）：渲染在滚动列表之外（panel-content
    // 顶层），因此始终固定不动，滚动条只出现在其下方的卡片列表区。简介来自 Host
    // 经 manifest 下发的 package.json description（单一数据源）；未下发时退回通用文案。
    function AboutHead() {
      const s = useStore();
      return React.createElement('div', { className: 'dsh-music-about-top' },
        React.createElement('div', { className: 'dsh-music-about-head' },
          React.createElement('div', { className: 'dsh-music-about-logo' }, '♪'),
          React.createElement('div', { className: 'dsh-music-about-title' },
            'DSH音乐播放器',
            // 版本徽章可点击 → 打开「历史版本」更新日志（与下方「更新日志」行同入口）。
            React.createElement('span', {
              className: 'dsh-music-about-ver dsh-music-about-ver-btn', title: '查看更新日志',
              onClick: () => openWhatsNew('history'),
            }, 'v' + (s.version || '—')))),
        React.createElement('div', { className: 'dsh-music-about-desc' },
          s.description || 'Vibe coding时的好伴侣'));
    }
    // 关于页内容（卡片组）：运行状态 / 关于。只渲染卡片本身，放在 .dsh-music-list
    // 滚动列表内——超高时滚动条出现在卡片区，头部不动；免责声明在底部统一 tts-hint 页脚。
    function About() {
      const s = useStore();
      const infoRow = (k, v, cls, title) => React.createElement('div', { className: 'dsh-music-about-row' },
        React.createElement('span', { className: 'dsh-music-about-k' }, k),
        React.createElement('span', {
          className: 'dsh-music-about-v' + (cls ? ' ' + cls : ''),
          title: (title !== undefined ? title : v),
        }, v));
      // 可跳转链接行：外链用 <a target="_blank" rel="noopener noreferrer">（与 DSH
      // web 组件 WebBlock 处理外链的方式一致，webview 会路由到系统浏览器打开）。
      const linkRow = (k, label, href) => React.createElement('div', { className: 'dsh-music-about-row' },
        React.createElement('span', { className: 'dsh-music-about-k' }, k),
        React.createElement('a', { className: 'dsh-music-about-v dsh-music-about-link', href, target: '_blank', rel: 'noopener noreferrer', title: href }, label));
      // 行内按钮（与 linkRow 同款右对齐链接样式，但为站内动作而非外链）。
      const actionRow = (k, label, fn) => React.createElement('div', { className: 'dsh-music-about-row' },
        React.createElement('span', { className: 'dsh-music-about-k' }, k),
        React.createElement('button', { className: 'dsh-music-about-link dsh-music-about-btn', type: 'button', title: label, onClick: fn }, label));
      // AI 讲书：已配置时显示 DSH 模型配置里实际匹配到的提供方名称（Host 经
      // manifest 下发）；未下发则退回通用文案。未配置时直接显示「未配置」。
      const ttsTxt = s.ttsConfigured
        ? ('已配置（' + (s.ttsProvider || 'xiaomi / MiMo') + '）')
        : '未配置';
      // QQ 登录态：区分登录方式——'wx'=微信扫码 / 'qq'=QQ 扫码（Host 经 manifest 下发）；
      // 未知方式时只显示「已登录」。
      const qqLoginLabel = s.qqLoginFrom === 'wx' ? '微信' : (s.qqLoginFrom === 'qq' ? 'QQ' : '');
      const qqTxt = s.qqLoggedIn ? ('已登录' + (qqLoginLabel ? '（' + qqLoginLabel + '）' : '')) : '未登录（扫码后可用）';
      const kgTxt = s.kgLoggedIn ? '已登录' : '未登录（扫码后可用）';
      return React.createElement('div', { className: 'dsh-music-about' },
        React.createElement('div', { className: 'dsh-music-about-card' },
          React.createElement('div', { className: 'dsh-music-about-card-title' }, '运行状态'),
          infoRow('音乐目录', s.root || '未设置（默认 ~/Music）'),
          infoRow('小说目录', s.bookRoot || '未设置（默认同音乐目录）'),
          infoRow('曲库歌曲', String(s.count || 0) + ' 首'),
          infoRow('本地小说', String((s.books || []).length) + ' 本'),
          infoRow('AI 讲书/新闻播报', ttsTxt, s.ttsConfigured ? 'ok' : 'err'),
          infoRow('QQ音乐', qqTxt, s.qqLoggedIn ? 'ok' : ''),
          infoRow('酷狗音乐', kgTxt, s.kgLoggedIn ? 'ok' : '')),
        React.createElement('div', { className: 'dsh-music-about-card' },
          React.createElement('div', { className: 'dsh-music-about-card-title' }, '关于'),
          infoRow('项目', 'dsh-music-player'),
          linkRow('仓库', 'github.com/kendu76/dsh-music-player', 'https://github.com/kendu76/dsh-music-player'),
          actionRow('更新日志', '查看', () => openWhatsNew('history')),
          infoRow('许可', 'MIT © kendu76')));
    }
    // 「加入歌单」弹层：曲库每行「＋」点击后出现，列出所有歌单（含我最喜欢）并可新建。
    // 用 fixed 定位（锚点为按钮视口坐标），避免被面板滚动列表裁剪。
    function AddToPlaylistMenu({ track, anchor, onClose }) {
      const ref = useRef(null);
      useEffect(() => {
        const onDown = (e) => { if (ref.current !== null && !ref.current.contains(e.target)) onClose(); };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
      }, [onClose]);
      const openUp = (anchor.y || 0) > ((window.innerHeight || 0) - 240);
      const style = {
        left: Math.max(8, (anchor.x || 0) - 150),
        top: openUp ? (anchor.y || 0) - 6 : (anchor.y || 0) + 8,
        transform: openUp ? 'translateY(-100%)' : 'none',
      };
      const list = store.playlists || [];
      // 加入已有歌单：成功关弹窗并居中提示，失败保留弹窗（可换歌单重试）居中提示。
      const addTo = (id) => {
        const pl = list.find((p) => p.id === id);
        const name = (pl && pl.name) || '歌单';
        apiPlaylistAdd(id, [track.path], (r) => {
          if (r && r.ok && r.playlist) { onClose(); showToast('添加到' + name + '成功', true); }
          else showToast('添加到' + name + '失败', false);
        });
      };
      const addNew = () => {
        openPrompt('新建歌单名称', '', (trimmed) => {
          if (!trimmed) return;
          fetch('/dsh-music/playlist', {
            method: 'POST', cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: trimmed }),
          }).then((r) => r.json()).then((r) => {
            if (r && r.playlist) {
              set({ playlists: [...(store.playlists || []), r.playlist] });
              apiPlaylistAdd(r.playlist.id, [track.path], (add) => {
                if (add && add.ok && add.playlist) { onClose(); showToast('添加到' + r.playlist.name + '成功', true); }
                else showToast('添加到' + r.playlist.name + '失败', false);
              });
            } else {
              showToast('添加到' + trimmed + '失败', false);
            }
          }).catch(() => showToast('添加到' + trimmed + '失败', false));
        });
      };
      return React.createElement('div', { className: 'dsh-music-add-pop', ref, style },
        list.length > 0 ? list.map((p) => React.createElement('button', {
          key: p.id,
          className: 'dsh-music-add-pop-item',
          title: '加入「' + p.name + '」',
          onClick: () => addTo(p.id),
        }, (p.id === FAV_PLAYLIST_ID ? '♥ ' : '') + p.name + '（' + p.count + '）')) : null,
        React.createElement('button', { className: 'dsh-music-add-pop-item new', onClick: addNew }, '＋ 新建歌单'),
      );
    }
    // 歌单详情：添加歌曲 + 重命名/删除 + 歌曲列表（移除/上移/下移）。
    function PlaylistDetail({ pl, panelRef }) {
      const [pickerOpen, setPickerOpen] = useState(false);
      const rows = (pl.tracks || []).map((t, idx) => {
        const active = t.id === store.currentId;
        const playing = active && store.playing;
        return React.createElement('div', { key: t.id, className: 'dsh-music-playlist-row' + (active ? ' active' : '') },
          React.createElement('button', {
            className: 'dsh-music-track',
            title: t.path,
            // Same double-click guard as the library rows: the second click of a
            // dblclick must not togglePlay() (pause) the just-started track.
            onClick: (e) => { if (shouldIgnoreRowClick(e, active)) return; if (active) togglePlay(); else startPlayFrom(t.id, 'playlist', pl.id); },
          },
            React.createElement('span', { className: 'dsh-music-track-name' }, (playing ? '▶ ' : '') + (idx + 1) + '. ' + t.name),
            React.createElement('span', { className: 'dsh-music-track-size' }, formatSize(t.size)),
          ),
          React.createElement('button', { className: 'dsh-music-playlist-mini', title: '上移', onClick: (e) => { e.stopPropagation(); movePlaylistTrack(pl, t.path, -1); } }, '↑'),
          React.createElement('button', { className: 'dsh-music-playlist-mini', title: '下移', onClick: (e) => { e.stopPropagation(); movePlaylistTrack(pl, t.path, 1); } }, '↓'),
          React.createElement('button', { className: 'dsh-music-playlist-mini del', title: '从歌单移除', onClick: (e) => { e.stopPropagation(); apiPlaylistRemove(pl.id, [t.path]); } }, '×'),
        );
      });
      return React.createElement('div', { className: 'dsh-music-playlist' },
        React.createElement('div', { className: 'dsh-music-playlist-head' },
          React.createElement('button', { className: 'dsh-music-playlist-btn', onClick: () => setPickerOpen(true) }, '＋ 添加歌曲'),
          React.createElement('button', { className: 'dsh-music-playlist-btn', onClick: () => onClearPlaylist(pl) }, '清空'),
          !pl.fixed ? React.createElement('button', { className: 'dsh-music-playlist-btn', onClick: () => onRenamePlaylist(pl) }, '重命名') : null,
          !pl.fixed ? React.createElement('button', { className: 'dsh-music-playlist-btn', onClick: () => onDeletePlaylist(pl) }, '删除') : null,
          pl.missing > 0 ? React.createElement('span', { className: 'dsh-music-playlist-missing', title: '部分歌曲文件已被移动或删除' }, pl.missing + ' 首已失效') : null,
        ),
        rows.length > 0 ? rows : React.createElement('div', { className: 'dsh-music-empty dsh-music-playlist-empty' }, '歌单为空，点击「添加歌曲」从本地文件选择音乐。'),
        pickerOpen ? React.createElement(FilePicker, { pl, panelRef, onClose: () => setPickerOpen(false) }) : null,
      );
    }
    // 文件系统多选器：浏览目录 + 勾选音频文件，用于歌单「添加歌曲」。
    function FilePicker({ pl, panelRef, onClose }) {
      const [cur, setCur] = useState({ path: '', name: '', dirs: [], files: [], crumbs: [], up: null });
      const [sel, setSel] = useState(new Set());
      const [err, setErr] = useState(null);
      const [busy, setBusy] = useState(false);
      const browse = async (p) => {
        setErr(null);
        try {
          const data = await jsonGet('/dsh-music/files?path=' + encodeURIComponent(p || ''));
          if (data && data.error) { setErr(data.error); return; }
          setCur({ path: data.path || '', name: data.name || '', dirs: data.dirs || [], files: data.files || [], crumbs: data.crumbs || [], up: data.up !== undefined ? data.up : null });
        } catch (e) { setErr('读取目录失败：' + String((e && e.message) || e)); }
      };
      // 默认定位到音乐目录（store.root），未配置时回退家目录。
      useEffect(() => { browse(store.root || ''); }, []);
      const toggle = (p) => {
        const next = new Set(sel);
        if (next.has(p)) next.delete(p); else next.add(p);
        setSel(next);
      };
      const confirmAdd = async () => {
        const paths = [...sel];
        if (paths.length === 0 || busy) { onClose(); return; }
        setBusy(true);
        apiPlaylistAdd(pl.id, paths, () => onClose());
      };
      return portalToBody(React.createElement('div', { className: 'dsh-music-picker-overlay' },
        React.createElement('div', { className: 'dsh-music-picker', style: panelCenterStyle(panelRef, true, 320, Math.round(window.innerHeight * 0.72)) },
          React.createElement('div', { className: 'dsh-music-picker-head' },
            React.createElement('span', { className: 'dsh-music-picker-title' }, '添加歌曲到「' + pl.name + '」'),
            React.createElement('button', { className: 'dsh-music-icon-btn', title: '关闭', onClick: onClose }, '✕')),
          React.createElement('div', { className: 'dsh-music-picker-cur', title: cur.path },
            React.createElement('div', { className: 'dsh-music-picker-cur-left' },
              React.createElement('button', { className: 'dsh-music-crumb', onClick: () => browse('__drives__'), title: '本机磁盘' }, '💻 本机'),
              React.createElement('span', { className: 'dsh-music-crumb-sep' }, '›'),
              renderCrumbs(cur.crumbs, cur.path, cur.name, browse)
            ),
            React.createElement('div', { className: 'dsh-music-picker-cur-up' },
              cur.up !== null ? React.createElement('button', { className: 'dsh-music-crumb up', onClick: () => browse(cur.up), title: '上级目录' }, '↑') : null
            )),
          React.createElement('div', { className: 'dsh-music-picker-list' },
            (cur.dirs || []).map((d) => React.createElement('button', {
              key: d.path, className: 'dsh-music-picker-item', title: d.path,
              onClick: () => browse(d.path),
            }, '📁 ' + d.name)),
            (cur.files || []).map((f) => {
              const checked = sel.has(f.path);
              return React.createElement('button', {
                key: f.path,
                className: 'dsh-music-file-item' + (checked ? ' checked' : ''),
                title: f.path,
                onClick: () => toggle(f.path),
              },
                React.createElement('span', { className: 'dsh-music-file-check' }, checked ? '✓' : ''),
                React.createElement('span', { className: 'dsh-music-file-name' }, f.name),
                React.createElement('span', { className: 'dsh-music-track-size' }, formatSize(f.size)),
              );
            }),
            err ? React.createElement('div', { className: 'dsh-music-error' }, err) : null,
          ),
          React.createElement('div', { className: 'dsh-music-picker-foot' },
            React.createElement('button', { className: 'dsh-music-settings-btn', onClick: confirmAdd, disabled: busy }, '确定添加（' + sel.size + '）'),
            React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: onClose }, '取消'),
          ),
        ),
      ));
    }

    const inject = ['slots'];
    function apply(ctx) {
      const slots = ctx.get('slots');
      if (slots === undefined) return;

      ctx.effect(() => {
        const styleEl = document.createElement('style');
        styleEl.setAttribute('data-plugin', 'dsh-music-player');
        styleEl.textContent = PLAYER_CSS;
        document.head.appendChild(styleEl);
        return () => { if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl); };
      });

      ctx.effect(() => {
        attachAudioElements();
        const unbind = bindAudio();
        startRaf();
        // The live analyser is a captureStream() TAP — created only once a real src is
        // loaded (startPlay/onPlay), NOT up front, because a stream captured before any
        // src exists can carry no audio track. We deliberately avoid createMediaElementSource
        // here: it re-routes the element's output into the Web Audio graph and goes
        // SILENT whenever that graph/context isn't running (which is what broke audio
        // after switching tracks). The tap can never mute the player; if the tap can't
        // provide audio (the getTopURL bug) we fall back to the offline FFT envelope.
        const accentWatch = watchAccent();
        // Browsers auto-release a wake lock when the page is hidden; re-acquire
        // on return if playback is still running, and drop it on hide so we
        // don't hold it while the tab is backgrounded.
        const onVis = () => {
          if (document.hidden) releaseWakeLock();
          else { acquireWakeLock(); resumeVizCtx(); }
        };
        // On refresh/unload, stop the media element cleanly BEFORE the document
        // is torn down — otherwise Chromium's media pipeline can race the
        // teardown and throw an internal "getTopURL" error in the console.
        const onPageHide = () => {
          try { audio.pause(); } catch (e) {}
          try { preAudio.pause(); } catch (e) {}
          // Best-effort flush of pending prefs to the Host before teardown
          // (fetch uses keepalive; if the request is cut off, the periodic and
          // debounced flushes have normally already persisted the state).
          void flushServerPrefs();
        };
        document.addEventListener('visibilitychange', onVis);
        // Resume the analyser's AudioContext on any user gesture so it's already
        // running when a track starts. setupLiveViz() creates the tap once a real src
        // is loaded (startPlay/onPlay); the context just needs to be running for the
        // bars to move.
        const onFirstGesture = () => { resumeVizCtx(); };
        window.addEventListener('pointerdown', onFirstGesture);
        window.addEventListener('keydown', onFirstGesture, true);
        window.addEventListener('pagehide', onPageHide);
        // This Chromium's media pipeline throws a benign internal "getTopURL" TypeError
        // as an UNHANDLED promise rejection while a media element is routed through
        // Web Audio (needed for the live spectrum) with our proxied stream. It does NOT
        // affect playback or the analyser — but it spams the console. Suppress exactly
        // that benign case; leave every other rejection untouched.
        const onUnhandled = (ev) => {
          const r = ev && ev.reason;
          if (r && /getTopURL/.test(String((r && r.message) || r))) ev.preventDefault();
        };
        window.addEventListener('unhandledrejection', onUnhandled);
        return () => {
          window.removeEventListener('unhandledrejection', onUnhandled);
          window.removeEventListener('pagehide', onPageHide);
          window.removeEventListener('pointerdown', onFirstGesture);
          window.removeEventListener('keydown', onFirstGesture, true);
          document.removeEventListener('visibilitychange', onVis); stopRaf(); unbind(); closeLiveViz(); releaseWakeLock();
          if (accentWatch !== null) accentWatch.disconnect();
          accentObserver = null;
        };
      }, 'music-player: audio + viz engine');

      loadTracks();

      const intentTimer = setInterval(() => {
        jsonGet('/dsh-music/intent').then((intent) => {
          if (intent === null || typeof intent !== 'object') return;
          const action = intent.action || 'play';
          // Transport commands operate on the current playback state (no track id).
          if (action === 'pause') { audio.pause(); set({ playing: false }); return; }
          if (action === 'resume') {
            const p = audio.play();
            if (p !== undefined && typeof p.catch === 'function') p.catch((err) => { if (!isPlayAborted(err)) set({ error: '播放失败' }); });
            return;
          }
          if (action === 'stop') { stop(); return; }
          if (action === 'next') {
            // 讲书模式下：下一章；音乐模式下：下一首。
            if (store.currentId !== null && String(store.currentId).startsWith('book:')) stepBook(1); else step(1);
            return;
          }
          if (action === 'prev') {
            if (store.currentId !== null && String(store.currentId).startsWith('book:')) stepBook(-1); else step(-1);
            return;
          }
          // play with a playlist: switch scope to that playlist and start it.
          if (intent.playlistId) {
            const pl = playlistById(intent.playlistId);
            if (pl && pl.tracks && pl.tracks.length > 0) {
              startPlayFrom(pl.tracks[0].id, 'playlist', pl.id);
            }
            return;
          }
          // online QQ music track (agent requested source=web, or panel click).
          if (intent.kind === 'qq' && typeof intent.id === 'string' && /^[A-Za-z0-9]+$/.test(intent.id)) {
            const song = { id: intent.id, songmid: intent.id, title: intent.name || 'QQ音乐', artists: intent.artists || [], payplay: 0, source: 'qq' };
            startQQPlayback(song, [song], '在线');
            return;
          }
          // 每日新闻播报（agent 提交 news_broadcast 后推送）：先拉期次列表再走
          // 「虚拟书」管线播放；同时标记该期已播（清除面板「待播」徽标）。
          if (intent.kind === 'news' && typeof intent.id === 'string' && /^[A-Za-z0-9-]+$/.test(intent.id)) {
            newsResume = snapshotNewsResume(intent.id);
            playNewsFrom(intent.id, 0);
            return;
          }
          // play (default): needs an id — a book id (e.g. "b0") starts AI 讲书.
          if (intent.id === undefined) return;
          const book = bookById(intent.id);
          if (book !== null) {
            set({ pendingId: 'book:' + book.id, pendingName: intent.name || book.name, error: null });
            resumeOrPlayBook(book.id);
            return;
          }
          const track = resolvePlayable(intent.id);
          if (track !== null) {
            // 换到一首「新」的曲目：清除刷新恢复的定位钉，避免 onTime 把新曲目 seek
            // 回上一首的保存进度（换歌从旧进度开始）。play 意图=从头开始（续播走
            // togglePlay / resume 意图），因此这里无条件清除。
            restoredMusicPos = null;
            bookRestorePos = -1;
            audio.src = track.url;
            audio.load();
            set({ currentId: intent.id, currentName: track.name, currentArtists: track.artists || [], error: null, scope: { kind: 'library' }, position: 0, duration: 0 });
            savePlayback();
            const promise = audio.play();
            if (promise !== undefined && typeof promise.catch === 'function') {
              promise.catch((err) => {
                if (!isAutoplayBlocked(err)) return;
                set({ error: '浏览器拦截了自动播放，请在播放条点击▶解锁', pendingId: intent.id, pendingName: track.name });
              });
            }
          }
        }).catch(() => {});
      }, 2000);

      ctx.effect(() => slots.inject('conversation.input.dock', () => slots.register(
        { name: 'conversation.input.dock', id: 'music-player-bar', order: 40 },
        () => React.createElement(NowPlayingBar),
      )), 'music-player: now playing bar');
      ctx.effect(() => slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'music-player-panel', order: 20 },
        () => React.createElement(PlayerPanel),
      )), 'music-player: overlay panel');
      ctx.effect(() => slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'music-player-lyric-panel', order: 21 },
        () => React.createElement(LyricPanel),
      )), 'music-player: lyric panel');

      ctx.effect(() => () => clearInterval(intentTimer), 'music-player: intent poll stop');
    }

    exports.apply = apply;
    exports.inject = inject;

    // ---- CSS ----
    const PLAYER_CSS = '\n' +
      // Accent follows the host app's theme brand color (stable from the start —
      // no green-default-to-sampled-blue flash); green is only the fallback when
      // the app exposes no brand color. The alias must be declared on BODY, not
      // :root: DSH defines its --dsw-alias-* theme tokens on <body> only, and a
      // var() reference resolves against the element that declares it — on
      // :root (html) it cannot see body's tokens and would always fall back to
      // green. Declared on body, the reference resolves and children inherit
      // the theme's actual brand color.
      'body { --dsh-music-accent: var(--dsw-alias-brand-primary, #2f9e6e); --dsh-music-accent-fg: var(--dsw-alias-label-primary-foreground, #fff); }\n' +
      // 由于安装了第三方皮肤，该控件会被 'html[data-dsh-skin] [data-phase="active"]
      // [data-slot="conversation.input.dock"] > * { }' 强行接管，可能会出现背景颜色
      '#dsh-music-bar-wrap { background-color: transparent !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; }\n' +
      '.dsh-music-bar-wrap { box-sizing: border-box; width: 100%; padding: 0 var(--dsh-composer-side-clearance, 16px); }\n' +
      '.dsh-music-bar { box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%; max-width: var(--dsh-composer-card-max-width, 780px); margin: 0 auto; padding: 4px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2)); border-radius: 8px; cursor: default; user-select: none; position: relative; overflow: hidden; transition: opacity 0.3s ease; }\n' +
      // 系统配置「播放条背景显示」关闭时：去掉播放条外壳的边框与背景色，只保留内容
      // （歌名/歌词/频谱/按钮等子元素自身样式独立，不受影响；内边距/圆角/布局保持不变）。
      '.dsh-music-bar.bare { background: transparent; border: none; }\n' +
      '.dsh-music-bar.dimmed { opacity: var(--dsh-music-immerse, 0.5); }\n' +
      // 播放进度细线：绝对定位在播放条底部（占满其宽度），高 1px、视觉上是一条细线；
      // 轨道用低透明度衬底色，填充部分用主题色，随 position/duration 实时前进
      // （宽度 0.12s 平滑过渡）。播放条容器已 overflow:hidden，细线两端会被裁剪到
      // 圆角形状内，不会「戳出」圆角之外；pointer-events:none 避免挡住下方交互。
      // 轨道色用「次级文字色 + 低透明度」而非 bg-layer-2：后者在深色主题是亮层级、
      // 浅色主题也是亮层级，浅色背景下几乎不可见；文字色在深色主题偏亮、浅色主题
      // 偏暗，无论深浅背景都能衬出一条可见的细线轨道。
      '.dsh-music-bar-progress { position: absolute; left: 0; right: 0; bottom: 0; height: 1px; overflow: hidden; pointer-events: none; background: color-mix(in srgb, var(--dsw-alias-label-secondary, #8a8f98) 30%, transparent); }\n' +
      '.dsh-music-bar-progress-fill { height: 100%; background: color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 55%, var(--dsw-alias-bg-base)); transition: width 0.12s linear; }\n' +
      '.dsh-music-bar-idle { color: var(--dsw-alias-label-primary, #e6e6e6); font-weight: 500; display: inline-flex; align-items: center; }\n' +
      '.dsh-music-bar-name { max-width: 36%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-flex; align-items: center; min-width: 0; }\n' +
      // 名称文本（音符图标 + 歌名）内层：承载双击打开面板；参与外层 flex、可省略截断。
      '.dsh-music-bar-name-text { display: inline-flex; align-items: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }\n' +
      '.dsh-music-note { color: var(--dsh-music-accent, #2f9e6e); flex: none; margin-right: 4px; }\n' +
      // canvas 默认是 inline 级元素，会有基线留白导致在 flex 行里整体偏上；
      // display:block + margin:auto 0 + align-self:center 显式保证画布在播放条垂直居中。
      '.dsh-music-viz { flex: none; display: block; width: 60px; height: 20px; margin: auto 0; align-self: center; }\n' +
      // 歌词/字幕：夹在频谱与时长之间，吃掉剩余宽度，文本在可用空间内水平居中。
      // 三层结构：outer(定宽裁剪/遮罩/溢出标记) → run(跑马灯平移层) → fx(入场动画层)。
      // 无退场动画：上一句随 fx 重挂即时消失（data-prev 仅作「首次挂载」延迟判定）。
      // 首次出现仍延迟 0.28s（与控件组滑出 0.3s 对齐，:not([data-prev]) 只命中
      // 「无上一行」的首次挂载），行间切换立即播放过渡不额外等待。
      // 边缘渐隐（内置恒开）：两端各留 ~1em 渐变。未溢出时遮罩落在空白上，无视觉副作用。
      '.dsh-music-bar-lyric { flex: 1 1 auto; min-width: 0; overflow: hidden; text-align: center; color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 14px; position: relative; -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 14px, #000 calc(100% - 14px), transparent 100%); mask-image: linear-gradient(90deg, transparent 0, #000 14px, #000 calc(100% - 14px), transparent 100%); }\n' +
      // 中层：跑马灯平移；暂停时跟随音频停住（paused 由 playing prop 下发）。
      '.dsh-music-bar-lyric-run { display: inline-block; white-space: nowrap; max-width: none; }\n' +
      // 未溢出（无 .mq）时显式复位 transform，杜绝上一句动画值残留导致的短句被平移。
      '.dsh-music-bar-lyric-run:not(.mq) { transform: none; }\n' +
      '.dsh-music-bar-lyric-run.mq { animation: dsh-lyric-mq var(--mq-dur, 8s) ease-in-out infinite alternate; }\n' +
      '.dsh-music-bar-lyric-run.paused, .dsh-music-bar-lyric-fx.fxfrozen { animation-play-state: paused; }\n' +
      '@keyframes dsh-lyric-mq { from { transform: translateX(0); } to { transform: translateX(calc(-1 * var(--mq-over, 0px))); } }\n' +
      // fx 层：内联块收缩到文本宽度，退场伪元素 inset:0 精确叠在字形上。
      '.dsh-music-bar-lyric-fx { display: inline-block; position: relative; white-space: nowrap; }\n' +
      // — 入场动画（none 无 → 选择器不命中）：
      ".dsh-music-bar-lyric-fx[data-fx='slide'] { animation: dsh-lyric-slide-in 0.32s cubic-bezier(0.2, 0.7, 0.3, 1) backwards; }\n" +
      ".dsh-music-bar-lyric-fx[data-fx='blur'] { animation: dsh-lyric-blur-in 0.42s ease-out backwards; }\n" +
      // 首次挂载（没有上一行）：推迟出现，避开按钮组收起过程（见上方注释）。
      ".dsh-music-bar-lyric-fx:not([data-prev])[data-fx='slide'], .dsh-music-bar-lyric-fx:not([data-prev])[data-fx='blur'] { animation-delay: 0.28s; }\n" +
      // （退场动画已移除：上一句随 fx 重挂即时消失，不叠映过渡；data-prev 仍保留，
      // 仅用于上方「首次挂载」的入场延迟判定。）
      // karaoke 扫色：background-clip:text 上色，--kar-dur/--kar-delay(-elapsed) 让扫描
      // 定位到行内当前进度；暂停时整体停帧。配色走「明度+色相双重反差」才够醒目：
      // 已唱 = accent 实色绿；扫描头 = 41%→42% 一窄条混白高光（发亮的边界，一眼可见）；
      // 未唱 = 主文字色降到 40% 不透明度的「暗场」（比原来的中灰对比强得多）。羽化带
      // 收窄到 3%（原 10%），扫过的是清晰边界而不是一大片渐糊。背景 250% 宽 + 位置
      // 100%→0% 平移：起末两端分别正好露出纯暗场/纯绿色段（几何上已按窗口覆盖率校准）。
      ".dsh-music-bar-lyric-fx[data-fx='karaoke'] { background-image: linear-gradient(90deg, var(--dsh-music-accent, #2f9e6e) 0%, var(--dsh-music-accent, #2f9e6e) 41%, color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 55%, #fff) 42%, color-mix(in srgb, var(--dsw-alias-label-primary, #e6e6e6) 40%, transparent) 44%, color-mix(in srgb, var(--dsw-alias-label-primary, #e6e6e6) 40%, transparent) 100%); background-size: 250% 100%; background-repeat: no-repeat; -webkit-background-clip: text; background-clip: text; color: transparent; animation: dsh-kar-sweep var(--kar-dur, 6s) linear var(--kar-delay, 0s) backwards, dsh-kar-in 0.22s ease backwards; }\n" +
      // 音频时钟驱动模式（QRC 行窗口）：停用墙钟关键帧动画与过渡——位置由
      // karaokeFrame 逐帧按精确逆映射直写（帧间增量本身很小，无需过渡平滑；
      // 过渡反而会让渲染值持续落后目标）。
      ".dsh-music-bar-lyric-fx[data-fx='karaoke'][data-audioclock] { animation: dsh-kar-in 0.22s ease backwards; transition: none; }\n" +
      '@keyframes dsh-kar-sweep { from { background-position-x: 100%; } to { background-position-x: 0%; } }\n' +
      '@keyframes dsh-kar-in { from { opacity: 0; } to { opacity: 1; } }\n' +
      // 未唱「暗场」由 250% 渐变铺满实现；若浏览器不支持 color-mix，整个 gradient 失效
      // 会退化为无背景 → 文字全透明不可见！因此无 @supports 时先给一个实色兜底：
      // 先声明 background-color 后再被支持的浏览器以 background-image 覆盖观感。
      ".dsh-music-bar-lyric-fx[data-fx='karaoke'] { background-color: transparent; }\n" +
      "@supports not (background: color-mix(in srgb, red 50%, blue)) {\n" +
      "  .dsh-music-bar-lyric-fx[data-fx='karaoke'] { color: var(--dsw-alias-label-primary, #e6e6e6); }\n" +
      "}\n" +
      // karaoke 已移除退场伪元素（上一句即时消失）。
      '@keyframes dsh-lyric-slide-in { from { opacity: 0; transform: translateY(9px); } to { opacity: 1; transform: translateY(0); } }\n' +
      '@keyframes dsh-lyric-blur-in { from { opacity: 0; filter: blur(5px); transform: translateY(3px); } to { opacity: 1; filter: blur(0); transform: translateY(0); } }\n' +
      // 减动效：全部歌词动画停用；溢出行左对齐起步（跑马灯不滚动时至少能读到行首）。
      '@media (prefers-reduced-motion: reduce) { .dsh-music-bar-lyric-run.mq, .dsh-music-bar-lyric-fx { animation: none !important; } .dsh-music-bar-lyric-fx[data-audioclock] { transition: none !important; } .dsh-music-bar-lyric-run.mq { text-align: left; } }\n' +
      '.dsh-music-bar-warn { background: transparent; border: none; color: var(--dsw-alias-state-warn-primary, #d9a441); font-size: 12px; cursor: pointer; padding: 0; white-space: nowrap; }\n' +
      '.dsh-music-bar-btn { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 24px; height: 24px; border-radius: 50%; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.05)); color: var(--dsh-music-accent, #2f9e6e); cursor: pointer; font-size: 13px; line-height: 1; padding: 0; }\n' +
      '.dsh-music-bar-btn:hover { color: var(--dsh-music-accent-fg, #fff); background: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-bar-btn.active { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-bar-vol { position: relative; flex: none; display: inline-flex; align-self: center; }\n' +
      '.dsh-music-bar-vol-pop { position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); display: flex; align-items: center; justify-content: center; width: 36px; height: 108px; box-sizing: border-box; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 8px; box-shadow: 0 8px 20px rgba(0,0,0,0.3); z-index: 60; }\n' +
      // 讲书时音量弹层加宽，容纳 AI 声音选择 + 音量条。
      '.dsh-music-bar-vol-pop.book { width: 136px; height: auto; padding: 10px; flex-direction: column; gap: 10px; align-items: stretch; }\n' +
      '.dsh-music-voice { display: flex; flex-direction: column; gap: 4px; }\n' +
      '.dsh-music-voice-label { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-voice-select { width: 100%; padding: 4px 6px; font-size: 12px; color: var(--dsw-alias-label-primary, #e6e6e6); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.3)); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 6px; cursor: pointer; }\n' +
      '.dsh-music-voice-switching { font-size: 10px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-bar-vol-pop.book .dsh-music-vol-slider { align-self: center; }\n' +
      '.dsh-music-vol-slider { position: relative; width: 24px; height: 84px; cursor: pointer; touch-action: none; }\n' +
      '.dsh-music-vol-track { position: absolute; left: 50%; top: 0; bottom: 0; width: 4px; transform: translateX(-50%); border-radius: 2px; background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.14)); }\n' +
      '.dsh-music-vol-fill { position: absolute; left: 50%; bottom: 0; width: 4px; transform: translateX(-50%); border-radius: 2px; background: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-vol-thumb { position: absolute; left: 50%; transform: translateX(-50%); width: 14px; height: 14px; border-radius: 50%; background: var(--dsh-music-accent, #2f9e6e); box-shadow: 0 1px 3px rgba(0,0,0,0.4); }\n' +
      // 时长：与按钮组同源的「从右滑入」动画——悬停时按钮组展开、时长挂载进场，
      // 二者同步从右侧滑入（translateX 16px→0 + 淡入），避免时长突兀地「直接显示」。
      '.dsh-music-bar-time { line-height: 1; font-variant-numeric: tabular-nums; animation: dsh-music-time-in 0.3s ease; }\n' +
      '@keyframes dsh-music-time-in { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: translateX(0); } }\n' +
      '.dsh-music-bar-hint { color: var(--dsw-alias-state-warn-primary, #d9a441); white-space: nowrap; }\n' +
      // 时长 + 控制按钮的组合：留在 flex 流中右对齐（margin-left:auto）——这样窄屏下
      // 按钮组仍可随 flex 收缩，不会被 overflow:hidden 裁掉（与改动前行为一致）。
      // min-width 保持 0：折叠态按钮 max-width:0，控件区不占宽、不挤压中间 flex:1 的
      // 歌词/字幕。右端触发由绝对定位的 .dsh-music-bar-hotspot 承接（不占流），
      // 鼠标移入右端区域才触发按钮组滑入/滑出，整个播放条其它区域不再触发。
      // position:relative + z-index:2 让按钮组盖在热区之上，保持可点击。
      '.dsh-music-bar-controls { position: relative; z-index: 2; display: inline-flex; align-items: center; gap: 8px; flex: none; margin-left: auto; min-width: 0; }\n' +
      // 右端热区：绝对定位覆盖播放条右端一段区域（不占 flex 宽度 → 不挤压歌词/字幕），
      // 承接鼠标移入触发按钮组滑出。z-index:1 低于按钮组（z-index:2），不挡按钮点击。
      '.dsh-music-bar-hotspot { position: absolute; top: 0; bottom: 0; right: 0; width: 100px; z-index: 1; }\n' +
      // 控制按钮组：默认折叠（max-width:0 + overflow:hidden 裁剪），鼠标进入右端热区时
      // 从右向左滑入展开（translateX + opacity）。折叠时时长与按钮一并隐藏（闲置态）。
      // overflow:hidden 只用于裁剪左右滑动的按钮；三个向上弹出的弹层（音量/模式/
      // 章节目录）已改为 portal 渲染到 body，不受此裁剪影响。
      '.dsh-music-bar-btns { display: inline-flex; align-items: center; gap: 8px; overflow: hidden; max-width: 0; opacity: 0; transform: translateX(16px); transition: max-width 0.3s ease, opacity 0.2s ease, transform 0.3s ease; white-space: nowrap; }\n' +
      '.dsh-music-bar-controls.on .dsh-music-bar-btns { max-width: 340px; opacity: 1; transform: translateX(0); }\n' +
      '.dsh-music-bar-buffering { display: inline-flex; align-items: center; gap: 5px; margin-left: 8px; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 11px; }\n' +
      '.dsh-music-spinner { width: 12px; height: 12px; border: 2px solid var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.2)); border-top-color: var(--dsh-music-accent, #2f9e6e); border-radius: 50%; animation: dsh-music-spin 0.8s linear infinite; flex: none; }\n' +
      '@keyframes dsh-music-spin { to { transform: rotate(360deg); } }\n' +
      '.dsh-music-bar-berr { margin-left: 8px; color: var(--dsw-alias-state-error-primary, #e5534b); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; display: inline-flex; align-items: center; gap: 4px; }\n' +
      '.dsh-music-bar-berr-text { overflow: hidden; text-overflow: ellipsis; }\n' +
      '.dsh-music-bar-btn.retry { width: auto; color: var(--dsw-alias-state-error-primary, #e5534b); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 6px; padding: 0 6px; height: 18px; flex: none; }\n' +
      '.dsh-music-bar-btn.retry:hover { background: var(--dsw-alias-state-error-primary, #e5534b); color: #fff; }\n' +
      '.dsh-music-bar .dsh-music-mode-trigger { width: 24px; height: 24px; }\n' +
      '.dsh-music-bar .dsh-music-mode-trigger svg { flex: none; }\n' +
      '.dsh-music-bar .dsh-music-mode-menu { align-self: center; }\n' +
      '.dsh-music-panel { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 600px; max-height: 72vh; display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,0.35); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; z-index: 1000; pointer-events: auto; overflow: hidden; }\n' +
      // 歌词/字幕面板：与播放面板同款外壳视觉（背景/边框/圆角/阴影），默认居中、
      // 宽 420px 高 40vh（无侧边栏，歌词阅读更宽裕）。position 改为 fixed 时
      // 保留 left/top 居中；拖动/拉伸后由内联 left/top/width/height 覆盖。
      '.dsh-music-lyric-panel { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 420px; height: 40vh; max-height: 80vh; display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsh-music-accent, #2f9e6e); border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,0.35); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; z-index: 1000; pointer-events: auto; overflow: hidden; }\n' +
      // 透明模式（ghost）：外壳完全隐身——背景透明、边框只去色（保留 1px 占位不改
      // 几何）、去掉投影，歌词像直接显示在背景页面上（歌词文字无阴影）。
      // 边框/标题栏/关闭按钮/右下角拉伸角标默认隐藏，悬停面板时才浮现
      // （拖拽/关闭/拉伸功能不受影响，隐藏只是视觉淡出，pointer-events 保持可用）。
      '.dsh-music-lyric-panel.ghost { background: transparent; border-color: transparent; box-shadow: none; transition: border-color 0.15s; }\n' +
      '.dsh-music-lyric-panel.ghost:hover, .dsh-music-lyric-panel.ghost:focus-within { border-color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-lyric-panel.ghost .dsh-music-panel-head { opacity: 0; transition: opacity 0.15s; }\n' +
      '.dsh-music-lyric-panel.ghost:hover .dsh-music-panel-head, .dsh-music-lyric-panel.ghost:focus-within .dsh-music-panel-head { opacity: 1; }\n' +
      '.dsh-music-lyric-panel.ghost .dsh-music-resize::after { opacity: 0; }\n' +
      '.dsh-music-lyric-panel.ghost:hover .dsh-music-resize::after { opacity: 0.7; }\n' +
      // 标题栏通栏强调色底：负外边距抵消面板 12px 内边距，强调色条贴满面板顶部
      // （顶角由面板 overflow:hidden + 12px 圆角裁出）。前景一律用配套令牌
      // --dsh-music-accent-fg（宿主按主题提供「强调色上的前景色」）——不能写死
      // #fff：浅色主题下 brand 强调色偏浅，白字会直接隐形。仅歌词面板生效——
      // 主播放面板标题栏保持中性（两面板共用 .dsh-music-panel-head）。
      '.dsh-music-lyric-panel .dsh-music-panel-head { background: var(--dsh-music-accent, #2f9e6e); margin: -12px -12px 0; padding: 8px 12px; }\n' +
      '.dsh-music-lyric-panel .dsh-music-panel-title { color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-lyric-panel .dsh-music-panel-grip { color: var(--dsh-music-accent-fg, #fff); opacity: 1; }\n' +
      '.dsh-music-lyric-panel .dsh-music-panel-head .dsh-music-icon-btn { color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-lyric-panel .dsh-music-panel-head .dsh-music-icon-btn:hover { color: var(--dsh-music-accent-fg, #fff); background: color-mix(in srgb, var(--dsh-music-accent-fg, #fff) 18%, transparent); }\n' +
      // 歌词面板正文：可滚动歌词列表，逐行显示。行（.dsh-music-lyric-line）是块级，
      // 仅承载布局与行距；文字放内联 span（.dsh-music-lyric-line-text）承载字号与颜色。
      // 当前行（.active）高亮为「强调色 + 放大到 18px + 加粗（font-weight:700）」，并带
      // 0.18s 的字号平滑过渡（放大/回缩都动画），突出正在朗读/演唱的行；无背景框——
      // 颜色与字号随活动行即时跟随主题 accent。
      // 面板本身保持 13px（标题/按钮等控件字号不变）。
      // 滚动条悬浮化：自定义 6px 细滚动条，滑块默认全透明——换行自动滚动时不再闪出
      // 原生滚动条；悬停面板时滑块才浮现（与 ghost 模式标题栏同一交互语言）。
      // scrollbar-gutter: stable 保留：滑块/轨道占位恒定（webkit 自定义滚动条恒占
      // 6px，Firefox thin + stable 双保险），换行居中的 scrollTop 计算不受宽度抖动影响。
      '.dsh-music-lyric-panel-body { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; padding: 4px 8px; scrollbar-gutter: stable; scrollbar-width: thin; scrollbar-color: transparent transparent; }\n' +
      '.dsh-music-lyric-panel:hover .dsh-music-lyric-panel-body { scrollbar-color: rgba(128,128,128,0.45) transparent; }\n' +
      '.dsh-music-lyric-panel-body::-webkit-scrollbar { width: 6px; }\n' +
      '.dsh-music-lyric-panel-body::-webkit-scrollbar-track { background: transparent; }\n' +
      '.dsh-music-lyric-panel-body::-webkit-scrollbar-thumb { background: transparent; border-radius: 3px; }\n' +
      '.dsh-music-lyric-panel:hover .dsh-music-lyric-panel-body::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.45); }\n' +
      '.dsh-music-lyric-line { padding: 3px 0; }\n' +
      '.dsh-music-lyric-line-text { font-size: 16px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #8a8f98); white-space: pre-wrap; word-break: break-word; transition: font-size 0.18s ease; }\n' +
      '.dsh-music-lyric-line.active .dsh-music-lyric-line-text { color: var(--dsh-music-accent, #2f9e6e); font-weight: 700; font-size: 18px; }\n' +
      '.dsh-music-resize { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; touch-action: none; z-index: 5; }\n' +
      '.dsh-music-resize::after { content: ""; position: absolute; right: 4px; bottom: 4px; width: 5px; height: 5px; border-right: 2px solid var(--dsw-alias-label-secondary, #8a8f98); border-bottom: 2px solid var(--dsw-alias-label-secondary, #8a8f98); opacity: 0.7; }\n' +
      '.dsh-music-resize:hover::after { opacity: 1; }\n' +
      '.dsh-music-panel-head { display: flex; align-items: center; gap: 6px; }\n' +
      // 面板主体：左右布局——左侧 Tab 侧边栏，右侧内容区。两侧紧贴（gap:0），
      // 选中 tab 就能与内容区无缝连成整体。
      '.dsh-music-panel-body { display: flex; flex-direction: row; gap: 0; flex: 1; min-height: 0; }\n' +
      // 内容区：不设背景，透出面板自然底色；与左侧深色侧边栏靠明暗对比区分。
      '.dsh-music-panel-content { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; min-height: 0; padding-left: 12px; }\n' +
      // Tab 标签竖排在窗口左侧（侧边栏）：背景比右侧略深。左右无内边距保证
      // 选中项撑满整列并与内容区无缝连接；上下内边距加大，让标签组与上方标题、
      // 下方边缘留出呼吸空间。
      '.dsh-music-tabs { display: flex; flex-direction: column; gap: 4px; flex: none; width: 88px; padding: 48px 0; background: rgba(0,0,0,0.28); }\n' +
      '.dsh-music-tab { flex: none; width: 100%; padding: 16px 8px; border: none; background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 12px; }\n' +
      // 选中的 tab：用面板底色填充，与右侧透明内容区同色、右缘直通（无缝隙）连成整体；
      // 左缘一条强调色竖条 + 加粗，指示当前所在项。
      '.dsh-music-tab.active { background: var(--dsw-alias-bg-overlay, #1e1f22); color: var(--dsw-alias-label-primary, #e6e6e6); font-weight: 600; box-shadow: inset 3px 0 0 var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-panel-drag { cursor: move; touch-action: none; user-select: none; }\n' +
      '.dsh-music-panel-grip { color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 12px; letter-spacing: -1px; opacity: 0.7; }\n' +
      '.dsh-music-panel-title { font-weight: 600; margin-right: auto; }\n' +
      '.dsh-music-icon-btn { background: transparent; border: none; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 14px; padding: 2px 6px; border-radius: 6px; }\n' +
      '.dsh-music-icon-btn:hover { color: var(--dsw-alias-label-primary, #e6e6e6); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-panel-root { font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-mode-menu { position: relative; flex: none; }\n' +
      '.dsh-music-mode-menu.right { margin-left: auto; }\n' +
      '.dsh-music-mode-trigger { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 50%; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.05)); color: var(--dsh-music-accent, #2f9e6e); cursor: pointer; }\n' +
      '.dsh-music-mode-trigger:hover, .dsh-music-mode-trigger.active { background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-mode-pop { position: absolute; left: 50%; transform: translateX(-50%); bottom: calc(100% + 6px); z-index: 60; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 6px; height: 108px; box-sizing: border-box; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.3); }\n' +
      '.dsh-music-mode-item { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border: none; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; }\n' +
      '.dsh-music-mode-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-mode-item.active { background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; min-height: 60px; max-height: 42vh; }\n' +
      // pane 层的包裹 div：改成 flex 列容器（否则它是块级元素，QQ pane 的 flex:1
      // 不生效、没有确定高度，导致 .dsh-music-qq-body 不滚动、整棵被 .dsh-music-list
      // 滚走 → 滚动条会盖住固定的 head）。设为 flex:1+min-height:0 撑满列表区高度：
      // QQ pane 内的 .dsh-music-qq-body 成为唯一滚动容器，滚动条只出现在 head 下方。
      // 本地音乐/讲书 pane 因 min-height:auto 不会被压缩、仍超高溢出、由列表滚动，行为不变。
      '.dsh-music-list-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }\n' +
      '.dsh-music-track { display: flex; align-items: center; gap: 8px; width: 100%; max-width: 100%; box-sizing: border-box; text-align: left; padding: 6px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-track:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      // 正在播放/选中的条目：填充强调色底 + 强调色文字，让当前条目一眼可见（选中态）。
      '.dsh-music-track.active { color: var(--dsh-music-accent, #2f9e6e); background: color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 14%, transparent); }\n' +
      '.dsh-music-track.active .dsh-music-track-name { font-weight: 600; }\n' +
      '.dsh-music-track-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      // 在线 QQ 歌曲行：歌名 + 内嵌 VIP 徽标并排，歌名省略、VIP 徽标不省略。
      '.dsh-music-track-name.qq { display: inline-flex; align-items: center; gap: 5px; overflow: hidden; }\n' +
      '.dsh-music-track-name.qq .dsh-music-track-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-track-name.qq .dsh-music-online-tag { flex: 0 0 auto; margin-left: 0; }\n' +
      // 歌单卡片：封面图 + 名称 + 元信息，网格排布。
      '.dsh-music-playlist-card { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.06)); border-radius: 10px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-playlist-card:hover { border-color: var(--dsh-music-accent, #2f9e6e); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.05)); }\n' +
      // 「我的歌单」卡片：外层相对定位，右上角删除按钮悬浮。
      '.dsh-music-qq-mine-card { position: relative; }\n' +
      '.dsh-music-qq-mine-del { position: absolute; top: 6px; right: 6px; z-index: 2; width: 20px; height: 20px; line-height: 18px; padding: 0; text-align: center; border-radius: 50%; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35)); background: var(--dsw-alias-bg-overlay, rgba(0,0,0,0.55)); color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 11px; opacity: 0; transition: opacity 0.15s; }\n' +
      '.dsh-music-qq-mine-card:hover .dsh-music-qq-mine-del { opacity: 1; }\n' +
      '.dsh-music-qq-mine-del:hover { color: #fff; background: #c9352c; border-color: #c9352c; }\n' +
      // 「取消收藏」用星标图标，悬停金色以区分于删除。
      '.dsh-music-qq-mine-del.uncollect:hover { color: #fff; background: #d9a441; border-color: #d9a441; }\n' +
      '.dsh-music-playlist-cover { width: 56px; height: 56px; border-radius: 8px; object-fit: cover; flex: 0 0 auto; background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      // 无封面（酷狗「默认收藏」等系统歌单接口不返回 pic）时的音符占位块。
      '.dsh-music-playlist-cover.empty { display: flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-tertiary, rgba(255,255,255,0.45)); }\n' +
      '.dsh-music-playlist-cover.empty .dsh-music-note { width: 24px; height: 24px; }\n' +
      '.dsh-music-playlist-info { display: flex; flex-direction: column; gap: 4px; min-width: 0; }\n' +
      '.dsh-music-playlist-name-row { display: flex; align-items: center; gap: 6px; min-width: 0; }\n' +
      '.dsh-music-playlist-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }\n' +
      '.dsh-music-playlist-meta { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-qq-topdetail-head { display: flex; align-items: center; gap: 10px; margin: 8px 0 6px; }\n' +
      // 榜单详情头（返回 + 榜名/封面）固定在滚动容器 .dsh-music-qq-body 之外：头部不被滚走，
      // 滚动条从头部下方开始、高度与歌曲列表对齐（不再被固定头遮挡）。
      '.dsh-music-qq-tophead-fixed { flex: none; }\n' +
      // 「加载更多」：水平居中 + 圆角胶囊按钮。
      '.dsh-music-qq-loadmore { display: flex; justify-content: center; margin: 14px 0 6px; }\n' +
      '.dsh-music-qq-loadmore-btn { padding: 7px 22px; border-radius: 20px; border: 1px solid var(--dsh-music-accent, #2f9e6e); background: transparent; color: var(--dsh-music-accent, #2f9e6e); cursor: pointer; font-size: 12px; transition: background 0.15s, color 0.15s; }\n' +
      '.dsh-music-qq-loadmore-btn:hover { background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      // 公开歌单详情页「收藏」按钮：头部标题行下方一条胶囊按钮；已收藏置灰不可点。
      '.dsh-music-qq-collect-pl { align-self: flex-start; margin: 2px 0 6px; padding: 5px 14px; border-radius: 14px; border: 1px solid var(--dsh-music-accent, #2f9e6e); background: transparent; color: var(--dsh-music-accent, #2f9e6e); cursor: pointer; font-size: 12px; transition: background 0.15s, color 0.15s; }\n' +
      '.dsh-music-qq-collect-pl:hover:not(:disabled) { background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-qq-collect-pl:disabled { cursor: default; border-color: var(--dsw-alias-border-l1, rgba(128,128,128,0.35)); color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      // 「播放全部」：主操作按钮，实心强调色胶囊（歌单详情/榜单详情头）。
      '.dsh-music-qq-playall { flex: none; display: inline-flex; align-items: center; gap: 4px; padding: 5px 14px; border-radius: 14px; border: none; background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); cursor: pointer; font-size: 12px; transition: opacity 0.15s; }\n' +
      '.dsh-music-qq-playall:hover { opacity: 0.85; }\n' +
      // 歌单详情操作行（播放全部 + 收藏）：放在简介下方、歌曲列表上方，横向排列。
      '.dsh-music-qq-pl-actions { display: flex; align-items: center; gap: 8px; margin: 2px 0 6px; }\n' +
      '.dsh-music-qq-pl-actions .dsh-music-qq-collect-pl { margin: 0; }\n' +
      '.dsh-music-track-size { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-empty { padding: 12px; text-align: center; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 12px; }\n' +
      '.dsh-music-error { color: var(--dsw-alias-state-error-primary, #e5534b); font-size: 12px; }\n' +
      // 新闻失败提示行：文本 + 右侧「✕」清除按钮（flex 布局，文本可换行、按钮固定右侧）。
      '.dsh-music-news-failure { display: flex; align-items: flex-start; gap: 6px; color: var(--dsw-alias-state-error-primary, #e5534b); font-size: 12px; line-height: 1.5; }\n' +
      '.dsh-music-news-failure-text { flex: 1; min-width: 0; word-break: break-word; }\n' +
      '.dsh-music-news-failure-close { flex: none; padding: 0 4px; background: none; border: none; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 12px; cursor: pointer; line-height: 1.5; border-radius: 4px; }\n' +
      '.dsh-music-news-failure-close:hover { color: var(--dsw-alias-state-error-primary, #e5534b); background: rgba(229, 83, 75, 0.12); }\n' +
      '.dsh-music-loading { color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 12px; }\n' +
      // 系统配置面板：开关行（标签 + 描述 + 右侧开关）。
      '.dsh-music-config { display: flex; flex-direction: column; gap: 12px; }\n' +
      // 分组卡片：整体一个外框（无标题），卡片内行之间用细分隔线（不各自带边框）。
      '.dsh-music-config-card { border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); overflow: hidden; }\n' +
      // 卡片内行：去掉独立边框/背景/圆角，只留上下内边距；相邻行之间画一条细分隔线。
      '.dsh-music-config-card .dsh-music-config-row { border: none; border-radius: 0; background: transparent; padding-top: 10px; padding-bottom: 10px; }\n' +
      '.dsh-music-config-card .dsh-music-config-row + .dsh-music-config-row { border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.18)); }\n' +
      '.dsh-music-config-row { display: flex; align-items: center; gap: 12px; padding: 12px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); }\n' +
      '.dsh-music-config-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }\n' +
      '.dsh-music-config-label { color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; font-weight: 600; }\n' +
      '.dsh-music-config-desc { color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 11px; }\n' +
      // 开关：右侧胶囊。用固定强调色而非随主题反转的 brand-primary，
      // 让深/浅主题下都读作「绿色=开、灰=关」；旋钮恒白保证两种主题下对比清晰。
      '.dsh-music-toggle { position: relative; flex: none; width: 40px; height: 22px; padding: 0; border: none; border-radius: 22px; background: var(--dsw-alias-border-l1, rgba(128,128,128,0.35)); cursor: pointer; transition: background 0.15s; }\n' +
      '.dsh-music-toggle .dsh-music-toggle-knob { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.35); transition: left 0.15s; }\n' +
      // 开启：固定绿色强调色（不随主题反转），旋钮右移。
      '.dsh-music-toggle.on { background: #2f9e6e; }\n' +
      '.dsh-music-toggle.on .dsh-music-toggle-knob { left: 20px; }\n' +
      // 沉浸感滑块行：右侧 range + 百分比数值。
      '.dsh-music-config-slider { flex: none; display: flex; align-items: center; gap: 8px; }\n' +
      '.dsh-music-config-range { width: 140px; accent-color: #2f9e6e; cursor: pointer; }\n' +
      // 歌词动效分段选择器：一组互斥小按钮，选中项用主题色描边+填充。
      '.dsh-music-config-seg { flex: none; display: flex; gap: 4px; }\n' +
      '.dsh-music-config-seg-btn { padding: 3px 9px; font-size: 11px; line-height: 1.5; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35)); background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; white-space: nowrap; transition: background 0.15s, color 0.15s, border-color 0.15s; }\n' +
      '.dsh-music-config-seg-btn:hover { color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      // 选中态与配置面板其它控件（开关/滑块）同款实心主色绿，保证同一面板内视觉统一。
      '.dsh-music-config-seg-btn.on { background: #2f9e6e; border-color: #2f9e6e; color: #fff; font-weight: 600; }\n' +
      '.dsh-music-config-val { min-width: 34px; text-align: right; font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); font-variant-numeric: tabular-nums; }\n' +
      // 关于页：头部（插件名称 + 版本徽章 + 简介）渲染在滚动列表之外（panel-content
      // 顶层），始终固定不动；下方卡片组在 .dsh-music-list 内滚动，滚动条只出现在
      // 卡片区、高度与该区域一致。与「选择音乐目录」设置块同款固定方式，最可靠。
      // 与系统配置面板同款卡片外观（同边框/底色/细分隔线），保证同一面板内视觉统一。
      '.dsh-music-about-top { display: flex; flex-direction: column; gap: 8px; }\n' +
      '.dsh-music-about-head { display: flex; align-items: center; gap: 10px; }\n' +
      // 音符图标：与版本更新弹窗图标（.dsh-music-whatsnew-logo）同款样式——
      // 强调色块 + 音符用成对主题变量（--dsh-music-accent 底 / --dsh-music-accent-fg
      // 前景随底色自适应，深浅主题下对比度都有保证），跟随 DSH 主题强调色；
      // 尺寸保持关于页头部的 42px 比例。♪ 字形笔画纤细且多数字体无粗体变体，
      // 用 font-weight 合成粗体 + 细描边（-webkit-text-stroke，Chromium 生效）
      // 让音符视觉上加粗。
      '.dsh-music-about-logo { flex: none; width: 42px; height: 42px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); font-size: 20px; font-weight: 700; -webkit-text-stroke: 0.6px currentColor; }\n' +
      '.dsh-music-about-title { font-size: 15px; font-weight: 700; display: flex; align-items: center; }\n' +
      '.dsh-music-about-ver { font-size: 11px; color: var(--dsh-music-accent, #2f9e6e); border: 1px solid var(--dsh-music-accent, #2f9e6e); border-radius: 10px; padding: 1px 8px; margin-left: 8px; font-weight: 600; }\n' +
      '.dsh-music-about-desc { font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); line-height: 1.7; }\n' +
      // 卡片区：普通流式块，超高时由外层 .dsh-music-list 滚动。
      '.dsh-music-about { display: flex; flex-direction: column; gap: 12px; }\n' +
      '.dsh-music-about-card { border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); overflow: hidden; }\n' +
      '.dsh-music-about-card-title { padding: 8px 12px; font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary, #8a8f98); letter-spacing: 0.5px; }\n' +
      '.dsh-music-about-row { display: flex; align-items: center; gap: 8px; padding: 7px 12px; font-size: 12px; }\n' +
      '.dsh-music-about-row + .dsh-music-about-row { border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.14)); }\n' +
      '.dsh-music-about-k { flex: none; width: 110px; white-space: nowrap; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-about-v { flex: 1; min-width: 0; text-align: right; color: var(--dsw-alias-label-primary, #e6e6e6); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      // 状态值着色：就绪/已登录用强调色（绿），未就绪/未登录用警示色（黄）。
      '.dsh-music-about-v.ok { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-about-v.err { color: var(--dsw-alias-state-warning-primary, #d9a441); }\n' +
      // 仓库地址：可点击外链（强调色 + 悬停下划线，与 DSH 外链样式一致）。
      '.dsh-music-about-link { flex: 1; min-width: 0; text-align: right; color: var(--dsh-music-accent, #2f9e6e); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-decoration: none; }\n' +
      // 站内动作行内按钮（复用 about-link 配色）与可点击版本徽章：button/span 重置。
      '.dsh-music-about-btn { background: none; border: none; padding: 0; cursor: pointer; font: inherit; }\n' +
      '.dsh-music-about-ver-btn { cursor: pointer; }\n' +
      '.dsh-music-about-link:hover { text-decoration: underline; }\n' +
      '.dsh-music-settings { display: flex; flex-direction: column; gap: 10px; }\n' +
      '.dsh-music-settings-row { display: flex; gap: 8px; align-items: center; }\n' +
      '.dsh-music-settings-cur { flex: 1; min-width: 0; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-settings-btn { padding: 6px 12px; border-radius: 8px; border: none; background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); cursor: pointer; font-size: 13px; white-space: nowrap; }\n' +
      '.dsh-music-settings-btn.ghost { background: transparent; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-settings-btn.danger { background: #c9352c; color: #fff; }\n' +
      '.dsh-music-picker-overlay { position: fixed; inset: 0; z-index: 2000; display: flex; overflow: auto; padding: 16px; background: rgba(0,0,0,0.45); }\n' +
      // 版本更新弹窗（What's New）：居中固定面板（同 .dsh-music-panel 的居中方式），
      // 叠在 picker-overlay 遮罩上；正文区独立滚动，历史折叠后整体高度可控。
      '.dsh-music-whatsnew { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); box-sizing: border-box; width: 460px; max-width: calc(100vw - 32px); max-height: 78vh; display: flex; flex-direction: column; gap: 8px; padding: 16px; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,0.35); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; pointer-events: auto; }\n' +
      '.dsh-music-whatsnew-head { display: flex; align-items: center; gap: 8px; }\n' +
      '.dsh-music-whatsnew-head-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }\n' +
      '.dsh-music-whatsnew-app { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-whatsnew-logo { flex: none; width: 26px; height: 26px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); font-size: 15px; }\n' +
      '.dsh-music-whatsnew-title { min-width: 0; font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-whatsnew-badge { flex: none; padding: 1px 7px; border-radius: 999px; font-size: 10px; font-weight: 700; letter-spacing: 0.5px; background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-whatsnew-sub { font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-whatsnew-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 10px; padding-right: 2px; }\n' +
      '.dsh-music-whatsnew-sec { display: flex; flex-direction: column; gap: 4px; }\n' +
      '.dsh-music-whatsnew-sec-title { font-size: 12px; font-weight: 600; color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-whatsnew-item { font-size: 12.5px; line-height: 1.55; color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.dsh-music-whatsnew-item::before { content: "· "; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-whatsnew-hist-toggle { align-self: flex-start; font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; user-select: none; padding: 2px 0; }\n' +
      '.dsh-music-whatsnew-hist-toggle:hover { color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.dsh-music-whatsnew-hist { border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2)); padding-top: 8px; display: flex; flex-direction: column; gap: 6px; }\n' +
      '.dsh-music-whatsnew-hist-head { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-whatsnew-hist-head.clickable { cursor: pointer; user-select: none; }\n' +
      '.dsh-music-whatsnew-hist-head.clickable:hover { color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.dsh-music-whatsnew-hist-head.open { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-whatsnew-foot { display: flex; justify-content: center; padding-top: 2px; }\n' +
      '.dsh-music-picker { box-sizing: border-box; width: 88%; max-width: 640px; max-height: 100%; margin: auto; display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 12px; color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.dsh-music-picker-head { display: flex; align-items: center; flex: none; }\n' +
      '.dsh-music-picker-title { font-weight: 600; margin-right: auto; }\n' +
      '.dsh-music-picker-cur { flex: none; font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); padding-bottom: 2px; display: flex; align-items: center; gap: 4px; }\n' +
      '.dsh-music-picker-cur-left { flex: 1; min-width: 0; display: flex; align-items: center; overflow-x: auto; overflow-y: hidden; white-space: nowrap; }\n' +
      '.dsh-music-picker-cur-left::-webkit-scrollbar { height: 4px; }\n' +
      '.dsh-music-picker-cur-left::-webkit-scrollbar-thumb { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.14)); border-radius: 4px; }\n' +
      '.dsh-music-picker-cur-up { flex: none; }\n' +
      '.dsh-music-crumb { display: inline-block; padding: 1px 4px; border: none; background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 12px; border-radius: 4px; }\n' +
      '.dsh-music-crumb:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.08)); color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.dsh-music-crumb.cur { color: var(--dsw-alias-label-primary, #e6e6e6); font-weight: 600; cursor: default; }\n' +
      '.dsh-music-crumb-sep { margin: 0 2px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-crumb-plain { color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-picker-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }\n' +
      '.dsh-music-picker-item { text-align: left; padding: 6px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 13px; }\n' +
      '.dsh-music-picker-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      // 文件条目：仅作展示，不可点击（无 hover 高亮，光标为默认）。
      '.dsh-music-picker-item.file { color: var(--dsw-alias-label-secondary, #8a8f98); cursor: default; }\n' +
      '.dsh-music-picker-foot { display: flex; gap: 8px; justify-content: flex-end; flex: none; }\n' +
      // 自定义输入弹窗（新建/重命名歌单）的输入框。
      '.dsh-music-prompt-input { box-sizing: border-box; width: 100%; padding: 8px 10px; font-size: 13px; color: var(--dsw-alias-label-primary, #e6e6e6); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 8px; outline: none; }\n' +
      '.dsh-music-prompt-input:focus { border-color: var(--dsh-music-accent, #2f9e6e); }\n' +
      // 新建/重命名/删除/清空弹窗较窄，不用居中列表那种 640px 宽。
      '.dsh-music-picker.prompt, .dsh-music-picker.confirm { width: 300px; max-width: 90vw; }\n' +
      '.dsh-music-hint { font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      // AI 讲书 / 新闻播报底部固定的 xiaomi 语音提示（吸底、与列表区上方内容分隔）。
      '.dsh-music-tts-hint { flex: none; margin-top: auto; padding: 6px 8px 2px; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary, #8a8f98); border-top: 1px solid rgba(128,128,128,0.15); }\n' +
      // ---- 在线 QQ 音乐 ----
      '.dsh-music-qq { display: flex; flex-direction: column; gap: 10px; }\n' +
      '.dsh-music-settings-row.qq-account { gap: 6px; }\n' +
      '.dsh-music-qq-search { display: flex; gap: 8px; position: relative; }\n' +
      // 搜索输入框内部的「一键清除」×：包裹层相对定位，清除钮绝对定位在输入框右内侧，
      // 且始终渲染（空时 .hidden 仅隐藏、不改变布局），输入框宽度与 UI 位置恒定不抖。
      '.dsh-music-qq-inputwrap { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; }\n' +
      '.dsh-music-qq-inputwrap .dsh-music-qq-input { flex: 1; padding-right: 26px; }\n' +
      '.dsh-music-qq-clear { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); width: 18px; height: 18px; line-height: 16px; padding: 0; text-align: center; border-radius: 50%; border: none; background: transparent; color: var(--dsw-alias-label-tertiary, rgba(255,255,255,0.45)); cursor: pointer; font-size: 12px; visibility: visible; }\n' +
      '.dsh-music-qq-clear.hidden { visibility: hidden; }\n' +
      '.dsh-music-qq-clear:hover { color: #fff; background: rgba(128,128,128,0.3); }\n' +
      '.dsh-music-qq-hist { position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 20; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 8px; padding: 4px; max-height: 240px; overflow-y: auto; box-shadow: 0 8px 20px rgba(0,0,0,0.3); }\n' +
      '.dsh-music-qq-hist-head { display: flex; align-items: center; justify-content: space-between; padding: 2px 6px 4px; }\n' +
      '.dsh-music-qq-hist-clear { border: none; background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 11px; padding: 2px 4px; border-radius: 4px; }\n' +
      '.dsh-music-qq-hist-clear:hover { color: var(--dsw-alias-state-error-primary, #e5534b); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-qq-hist-item { display: block; width: 100%; text-align: left; padding: 6px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-qq-hist-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-qq-input { flex: 1; min-width: 0; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; }\n' +
      '.dsh-music-online-tag { flex: 0 0 auto; font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); border-radius: 6px; padding: 0 6px; line-height: 16px; margin-left: 6px; }\n' +
      '.dsh-music-online-tag.vip { color: #e6a23c; border-color: #e6a23c; }\n' +
      '.dsh-music-online-tag.collect { color: #d9a441; border-color: #d9a441; }\n' +
      // QQ「我喜欢」等系统默认歌单的标签（主题色，区别于自建的灰色）。
      '.dsh-music-online-tag.default { color: var(--dsh-music-accent, #2f9e6e); border-color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-picker.qq-login { max-width: 340px; }\n' +
      '.dsh-music-qq-login-body { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 12px 4px; }\n' +
      '.dsh-music-qq-qr { width: 280px; height: 280px; max-width: 70vw; image-rendering: pixelated; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 8px; object-fit: contain; }\n' +
      '.dsh-music-qq-login-status { font-size: 14px; color: var(--dsw-alias-label-primary, #e6e6e6); text-align: center; }\n' +
      '.dsh-music-qq-login-actions { display: flex; gap: 8px; }\n' +
      '.dsh-music-qq-viewtabs { display: flex; gap: 6px; }\n' +
      '.dsh-music-qq-viewtab { flex: none; white-space: nowrap; padding: 5px 12px; border-radius: 8px; border: none; background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 13px; }\n' +
      '.dsh-music-qq-viewtab.active { background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      // 搜索结果内的「歌曲 / 相关歌单」切换 tab：与上方「我的歌单/推荐/分类/…」的
      // 填充式胶囊（viewtab）刻意区分——采用经典下划线式次级 tab（透明底 + 底部
      // 强调色指示条），一眼可辨这是「结果内二级切换」，而不是上层浏览入口。
      '.dsh-music-qq-resulttabs { display: flex; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); margin: 4px 0 8px; }\n' +
      // 搜索框行与「歌曲/相关歌单」子tab行固定在滚动容器(.dsh-music-qq-body)之外，
      // 滚动条只作用于其下方的结果内容，搜索结果出现竖向滚动条时输入框所在行不再左右偏移。
      '.dsh-music-qq-searchrow { flex: none; }\n' +
      '.dsh-music-qq-resulttabs.fixed { margin: 0; }\n' +
      '.dsh-music-qq-resulttab { flex: none; white-space: nowrap; padding: 6px 14px; border: none; background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 13px; border-bottom: 2px solid transparent; margin-bottom: -1px; }\n' +
      '.dsh-music-qq-resulttab:hover { color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.dsh-music-qq-resulttab.active { color: var(--dsh-music-accent, #2f9e6e); border-bottom-color: var(--dsh-music-accent, #2f9e6e); font-weight: 600; }\n' +
      '.dsh-music-qq-cats { display: flex; flex-wrap: wrap; gap: 6px; }\n' +
      // 酷狗分类：一级与二级分类之间的分隔线（负 margin 会导致横向溢出出现滚动条，故用 0 边距）。
      '.dsh-music-cat-divider { border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); margin: 10px 0 0; }\n' +
      '.dsh-music-qq-cat { padding: 4px 10px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: transparent; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-qq-cat.active { border-color: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent, #2f9e6e); }\n' +
      // 分类折叠/展开切换按钮：小号、次要色、无边框。
      '.dsh-music-qq-cat-toggle { display: block; margin: 8px auto 0; padding: 3px 12px; border: none; background: transparent; color: var(--dsh-music-accent, #2f9e6e); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-qq-cat-toggle:hover { text-decoration: underline; }\n' +
      '.dsh-music-qq-topgroup { margin-bottom: 8px; }\n' +
      '.dsh-music-qq-topitem { display: flex; justify-content: space-between; align-items: center; width: 100%; padding: 7px 10px; margin: 3px 0; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: transparent; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 13px; text-align: left; }\n' +
      '.dsh-music-qq-topitem:hover { border-color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-qq-topname { font-weight: 600; }\n' +
      '.dsh-music-qq-topmeta { font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-qq-detail-head { display: flex; gap: 8px; align-items: center; margin: 6px 0; }\n' +
      '.dsh-music-qq { display: flex; flex-direction: column; flex: 1; min-height: 0; height: 100%; }\n' +
      // QQ 面板所在 pane 不设 overflow:hidden（否则它自身会成为一个滚动容器，把
      // sticky 的 head 困在内部、无法吸附到真正滚动的 .dsh-music-list）。pane 保持
      // 普通流式布局，滚动交给 head 下方的 .dsh-music-list / .dsh-music-qq-body。
      '.dsh-music-qq-pane { flex: 1; min-height: 0; overflow: visible; display: flex; flex-direction: column; }\n' +
      // head 用 sticky 固定在滚动区顶部：无论实际滚动容器是 .dsh-music-list
      // 还是 .dsh-music-qq-body，返回按钮行 / 子tab 行都不会被列表滚走（内容在其下方滑动）。
      '.dsh-music-qq-head { flex: none; position: sticky; top: 0; z-index: 3; background: var(--dsw-alias-bg-overlay, #1e1f22); padding-bottom: 4px; }\n' +
      '.dsh-music-qq-body { flex: 1; overflow-y: auto; min-height: 0; }\n' +
      '.dsh-music-qq-section { font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); margin: 10px 0 4px; font-weight: 600; }\n' +
      '.dsh-music-qq-now { display: flex; align-items: center; gap: 4px; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); font-size: 12px; color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.dsh-music-qq-now-name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-qq-now-artist { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary, #8a8f98); margin-left: 4px; }\n' +
      '.dsh-music-qq-now-src { flex: 0 0 auto; color: var(--dsw-alias-label-secondary, #8a8f98); margin-left: auto; }\n' +
      '.dsh-music-qq-toolbar { display: flex; justify-content: space-between; gap: 8px; align-items: center; margin-bottom: 12px; }\n' +
      '.dsh-music-qq-login { flex: 1; min-height: 200px; display: flex; align-items: center; justify-content: center; }\n' +
      '.dsh-music-qq-login-center { display: flex; flex-direction: column; gap: 12px; align-items: center; max-width: 320px; }\n' +
      '.dsh-music-qq-login-dead { width: 100%; max-width: 300px; padding: 8px 10px; box-sizing: border-box; border: 1px solid var(--dsw-alias-state-error-border, rgba(216, 82, 80, 0.5)); border-radius: 6px; background: var(--dsw-alias-state-error-bg, rgba(216, 82, 80, 0.08)); color: var(--dsw-alias-state-error-primary, #d85250); font-size: 13px; line-height: 1.5; text-align: center; }\n' +
      '.dsh-music-qq-login-btn { width: 200px; padding: 10px 16px; font-size: 15px; }\n' +
      // 免责声明：居中块内的左对齐编号列表，阅读更清晰。
      '.dsh-music-qq-login-warn { display: flex; flex-direction: column; gap: 4px; width: 100%; max-width: 300px; margin-top: 4px; font-size: 12px; color: var(--dsw-alias-state-warn-primary, #d9a441); line-height: 1.5; text-align: left; box-sizing: border-box; max-height: 30vh; overflow-y: auto; }\n' +
      '.dsh-music-qq-login-warn-title { font-weight: 600; margin-bottom: 2px; }\n' +
      '.dsh-music-qq-login-warn-p { margin: 0; }\n' +
      '.dsh-music-qq-login-warn-item { display: flex; gap: 6px; align-items: flex-start; }\n' +
      '.dsh-music-qq-login-warn-num { flex: none; }\n' +
      // 讲书时章节名拼接在小说名后（复用 .dsh-music-bar-artist 样式），名称容器用默认
      // max-width:36%（与音乐「歌名 - 歌手」一致），不再单独给书名 24% 让空间。
      '.dsh-music-bar-src { margin-left: 6px; flex: 0 0 auto; white-space: nowrap; color: var(--dsh-music-accent, #2f9e6e); font-size: 11px; border: 1px solid var(--dsh-music-accent, #2f9e6e); border-radius: 6px; padding: 0 6px; line-height: 16px; }\n' +
      '.dsh-music-bar-artist { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 12px; margin-left: 6px; }\n' +
      '.dsh-music-bar-artist-name { margin-left: 6px; }\n' +
      '.dsh-music-toc-trigger { position: relative; flex: none; display: inline-flex; align-self: center; }\n' +
      // 章节目录弹层：与音量/播放模式弹窗同款定位观感——portal 到 body 后由
      // tocAnchorAbove 以内联 fixed + bottom 锚定（底边贴按钮上方 6px、高度限制在
      // 视口可用空间内）。这里仅保留结构样式与 CSS 兜底定位。
      '.dsh-music-toc { position: absolute; left: 50%; transform: translateX(-50%); bottom: calc(100% + 6px); width: 380px; max-height: 60vh; display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,0.35); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; z-index: 60; box-sizing: border-box; }\n' +
      '.dsh-music-toc-head { display: flex; align-items: center; gap: 6px; }\n' +
      '.dsh-music-toc-title { font-weight: 600; margin-right: auto; }\n' +
      '.dsh-music-toc-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }\n' +
      '.dsh-music-toc-item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 5px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-toc-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-toc-item.active { color: var(--dsh-music-accent, #2f9e6e); background: color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 14%, transparent); }\n' +
      '.dsh-music-toc-item.active .dsh-music-toc-heading { font-weight: 600; }\n' +
      '.dsh-music-toc-type { flex: none; font-size: 10px; padding: 1px 5px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.08)); color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-toc-item.active .dsh-music-toc-type { background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-toc-heading { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      // 自建歌单：音乐页子标签 / 歌单详情 / 文件多选 / 播放条收藏
      '.dsh-music-subtabs { display: flex; gap: 4px; flex-wrap: wrap; }\n' +
      '.dsh-music-subtab { flex: none; padding: 4px 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: transparent; border-radius: 16px; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 12px; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-subtab:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-subtab.active { background: var(--dsh-music-accent, #2f9e6e); border-color: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-subtab.add { width: 30px; padding: 4px 0; text-align: center; color: var(--dsh-music-accent, #2f9e6e); }\n' +
      // 每日新闻播报：定时任务卡片（时间/类别/开关/操作按钮）
      '.dsh-music-news-toolbar { flex: none; padding: 6px 10px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); }\n' +
      '.dsh-music-news-card-list { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px 10px; }\n' +
      '.dsh-music-news-card { box-sizing: border-box; width: 100%; max-width: 100%; display: flex; align-items: center; gap: 10px; padding: 8px 10px; background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); border-radius: 10px; cursor: pointer; }\n' +
      '.dsh-music-news-card:hover { border-color: var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); }\n' +
      '.dsh-music-news-card.current { border-color: color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 55%, transparent); background: color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 8%, transparent); }\n' +
      '.dsh-music-news-card-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }\n' +
      '.dsh-music-news-card-title { display: flex; align-items: center; gap: 6px; min-width: 0; }\n' +
      '.dsh-music-news-card-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.dsh-music-news-card-meta { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }\n' +
      '.dsh-music-news-card-badge { flex: none; font-size: 10px; line-height: 1; padding: 2px 5px; border-radius: 4px; color: var(--dsw-alias-label-secondary, #8a8f98); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); }\n' +
      '.dsh-music-news-card-badge.live { color: var(--dsh-music-accent, #2f9e6e); border-color: color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 55%, transparent); }\n' +
      '.dsh-music-news-card-actions { display: flex; align-items: center; gap: 4px; flex: none; }\n' +
      '.dsh-music-news-shift-card { box-sizing: border-box; width: 100%; max-width: 100%; display: flex; align-items: center; gap: 10px; padding: 8px 10px; background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); border-radius: 10px; }\n' +
      '.dsh-music-news-shift-card:hover { border-color: var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); }\n' +
      '.dsh-music-news-shift-time { flex: none; font-size: 15px; font-weight: 600; color: var(--dsh-music-accent, #2f9e6e); font-variant-numeric: tabular-nums; }\n' +
      '.dsh-music-news-shift-badge { flex: none; font-size: 10px; line-height: 1; padding: 2px 5px; border-radius: 4px; color: var(--dsh-music-accent, #2f9e6e); border: 1px solid color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 55%, transparent); white-space: nowrap; }\n' +
      '.dsh-music-news-shift-scope { flex: 1; min-width: 0; font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-news-shift-actions { flex: none; display: flex; align-items: center; gap: 2px; }\n' +
      '.dsh-music-news-shift-toggle { flex: none; display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; white-space: nowrap; padding: 0 6px; }\n' +
      '.dsh-music-news-shift-empty { padding: 10px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); border: 1px dashed var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 10px; }\n' +
      '.dsh-music-news-shift-modal { width: 360px; max-width: 90vw; overflow-y: auto; }\n' +
      '.dsh-music-news-field-label { font-size: 12px; font-weight: 600; margin-bottom: 4px; }\n' +
      '.dsh-music-news-field { display: flex; flex-direction: column; }\n' +
      '.dsh-music-news-time-input { box-sizing: border-box; width: 120px; padding: 4px 6px; font-size: 13px; color: var(--dsw-alias-label-primary, #e6e6e6); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 8px; outline: none; }\n' +
      '.dsh-music-news-time-input:focus { border-color: var(--dsh-music-accent, #2f9e6e); }\n' +
      // 新闻播报 pane：撑满列表区、纵向滚动只作用于下方内容（头部/操作栏固定不滚）。
      '.dsh-music-news-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }\n' +
      '.dsh-music-news-pane-inner { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }\n' +
      '.dsh-music-news-head { flex: none; }\n' +
      '.dsh-music-news-body { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; }\n' +
      '.dsh-music-playlist { display: flex; flex-direction: column; flex: 1; }\n' +
      '.dsh-music-playlist-empty { flex: 1; display: flex; align-items: center; justify-content: center; }\n' +
      '.dsh-music-playlist-head { display: flex; align-items: center; gap: 6px; padding: 2px 2px 0; }\n' +
      '.dsh-music-playlist-btn { flex: none; background: transparent; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 6px; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 11px; padding: 2px 8px; }\n' +
      '.dsh-music-playlist-btn:hover { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-playlist-missing { flex: none; margin-left: auto; font-size: 11px; color: var(--dsw-alias-state-warn-primary, #d9a441); }\n' +
      '.dsh-music-playlist-row { display: flex; align-items: center; gap: 4px; }\n' +
      '.dsh-music-playlist-row .dsh-music-track { flex: 1; min-width: 0; }\n' +
      '.dsh-music-playlist-row.active { border-radius: 6px; background: color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 14%, transparent); }\n' +
      '.dsh-music-playlist-row.active .dsh-music-track { color: var(--dsh-music-accent, #2f9e6e); background: transparent; }\n' +
      '.dsh-music-playlist-row.active .dsh-music-track-name { font-weight: 600; }\n' +
      '.dsh-music-playlist-mini { flex: none; width: 20px; height: 20px; padding: 0; border: none; background: transparent; border-radius: 4px; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 12px; line-height: 1; }\n' +
      '.dsh-music-playlist-mini:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-playlist-mini.del:hover { color: var(--dsw-alias-state-error-primary, #e5534b); }\n' +
      '.dsh-music-file-item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 6px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-file-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-file-item.checked { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.1)); color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-file-check { flex: none; width: 14px; height: 14px; border-radius: 3px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.4)); display: inline-flex; align-items: center; justify-content: center; font-size: 10px; }\n' +
      '.dsh-music-file-item.checked .dsh-music-file-check { background: var(--dsh-music-accent, #2f9e6e); border-color: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-file-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      // 曲库每行：track 按钮 + 行尾「＋」（加入歌单）
      '.dsh-music-track-row { display: flex; align-items: center; gap: 4px; }\n' +
      '.dsh-music-track-row .dsh-music-track { flex: 1; min-width: 0; }\n' +
      '.dsh-music-track-row.active { border-radius: 6px; background: color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 14%, transparent); }\n' +
      '.dsh-music-track-row.active .dsh-music-track { color: var(--dsh-music-accent, #2f9e6e); background: transparent; }\n' +
      '.dsh-music-track-row.active .dsh-music-track-name { font-weight: 600; }\n' +
      '.dsh-music-playlist-mini.add { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-playlist-mini.remove { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-playlist-mini.remove:hover { color: var(--dsw-alias-state-error-primary, #e5534b); }\n' +
      '.dsh-music-add-pop { position: fixed; z-index: 1200; min-width: 150px; max-width: 210px; display: flex; flex-direction: column; gap: 2px; padding: 6px; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.3); }\n' +
      '.dsh-music-add-pop-item { display: block; width: 100%; text-align: left; padding: 5px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n' +
      '.dsh-music-add-pop-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-add-pop-item.new { color: var(--dsh-music-accent, #2f9e6e); border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2)); margin-top: 2px; padding-top: 6px; }\n' +
      // 「加入歌单」成功/失败提示：面板窗口内绝对居中，颜色跟随 DSH 主题
      // （成功 = 主题强调色 --dsh-music-accent；失败 = 主题错误色），2s 自动消失。
      '.dsh-music-panel-toast { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 20; padding: 8px 18px; border-radius: 8px; font-size: 13px; font-weight: 500; color: var(--dsh-music-accent-fg, #fff); background: rgba(30,31,34,0.92); box-shadow: 0 6px 20px rgba(0,0,0,0.35); pointer-events: none; white-space: nowrap; max-width: 90%; text-align: center; animation: dsh-music-toast-in 0.18s ease; }\n' +
      '.dsh-music-panel-toast.ok { background: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-panel-toast.err { background: var(--dsw-alias-state-error-primary, #e5534b); }\n' +
      '@keyframes dsh-music-toast-in { from { opacity: 0; transform: translate(-50%, -50%) scale(0.94); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }\n' +
      '.dsh-music-bar-btn.fav { color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-bar-btn.fav:hover { color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-bar-btn.fav.on { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-bar-btn.fav.on:hover { color: var(--dsh-music-accent-fg, #fff); }\n';

    return module.exports;
  },
});
