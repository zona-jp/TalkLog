/* =========================================================================
 * TalkLog — リアルタイム会話文字起こし
 *
 * 設計方針
 *  - 「自分（マイク）」と「相手（タブ／画面の共有音声）」で SpeechRecognition を完全分離する
 *  - ブラウザは PC 内部の再生音へ直接触れないため、相手の声は音声共有を経由して取る
 *  - 相手側は Chrome の SpeechRecognition.start(MediaStreamTrack) を機能検出して使用する
 *  - interimResults を有効にし、発話途中から画面へ反映する（同一発話は同じ要素を書き換え）
 *  - DOM への書き込みは requestAnimationFrame で 1 フレーム 1 回にまとめる
 *  - 認識文字列は textContent のみで扱い、innerHTML へは絶対に代入しない
 *
 * 構成
 *  Support         : ブラウザ対応状況の判定
 *  AudioManager    : マイク（getUserMedia）と共有音声（getDisplayMedia）の取得と解放
 *  RecognitionEngine : SpeechRecognition 1 系統分のラッパ（自動再開・エラー方針を内包）
 *  TranscriptStore : 会話データ（構造化）の保持
 *  TranscriptView  : 会話の DOM 描画（差分更新・自動スクロール）
 *  StatusView / Alerts / Toast : 状態表示と通知
 *  Exporter        : コピー / TXT
 *  App             : 開始フローと全体のオーケストレーション
 * ========================================================================= */

'use strict';

(function () {

  /* =======================================================================
   * 定数
   * ===================================================================== */

  const SPEAKER = { SELF: 'self', REMOTE: 'remote' };
  const SPEAKER_LABEL = { self: '自分', remote: '相手' };

  /** 認識言語（日本語専用） */
  const LANG = 'ja-JP';

  /** 選択したマイクを覚えておくキー */
  const MIC_STORAGE_KEY = 'talklog.micDeviceId';

  /** UTF-8 BOM。日本語版 Excel / メモ帳での文字化けを防ぐために先頭へ付ける */
  const BOM = '\uFEFF';

  const CFG = {
    /** 自動再開の基本待ち時間(ms)。連続再開のたびに指数的に伸ばす */
    RESTART_BASE_DELAY_MS: 200,
    /** 自動再開の最大待ち時間(ms) */
    RESTART_MAX_DELAY_MS: 4000,
    /** ネットワークエラー時の待ち時間(ms) */
    RESTART_NETWORK_DELAY_MS: 1500,
    /** 再開回数を数える時間窓(ms) */
    RESTART_WINDOW_MS: 60000,
    /** 時間窓内に許容する再開回数。超えたら暴走とみなし停止 */
    RESTART_MAX_IN_WINDOW: 25,
    /** この時間以上連続稼働できたら「安定した」とみなしバックオフをリセット(ms) */
    STABLE_RUN_MS: 5000,
    /** start() 後この時間内に onstart が来なければ作り直す(ms) */
    START_TIMEOUT_MS: 3000,
    /** ネットワークエラーが何回続いたら画面へ知らせるか */
    NETWORK_FAILURES_BEFORE_NOTICE: 2,
    /** 開始後この時間まったく認識結果が無ければヒントを出す(ms) */
    NO_RESULT_HINT_MS: 15000,
    /** 画面下端からこの距離以内なら「最下部を見ている」と判定(px) */
    SCROLL_BOTTOM_THRESHOLD_PX: 56,
    /** DOM に残す確定メッセージの最大件数（超過分は画面からのみ間引く） */
    MAX_RENDERED_ENTRIES: 300,
    /** 間引く際に一度に削除する件数 */
    TRIM_CHUNK: 60,
    /** レベルメーターの更新しきい値(%)。これ未満の変化では DOM を触らない */
    METER_MIN_DELTA: 2,
    /** rAF が止まる背景タブ向けの反映フォールバック間隔(ms) */
    FLUSH_FALLBACK_MS: 100,
    /** トーストの表示時間(ms) */
    TOAST_DURATION_MS: 2600,
    /** セッション時間表示の更新間隔(ms) */
    TIMER_INTERVAL_MS: 1000,
  };

  /** 再開しても意味がない致命的エラー */
  const FATAL_ERRORS = new Set(['not-allowed', 'service-not-allowed', 'audio-capture']);
  /** 無視して再開してよいエラー */
  const BENIGN_ERRORS = new Set(['no-speech', 'aborted', 'bad-grammar']);

  const ERROR_MESSAGE = {
    'not-allowed': 'マイク（または音声入力）へのアクセスが許可されていません。',
    'service-not-allowed': 'ブラウザの音声認識サービスが利用できませんでした。',
    'audio-capture': '音声入力デバイスを取得できませんでした。',
    'network': '音声認識サーバーへの通信に失敗しました。ネットワーク接続を確認してください。',
    'language-not-supported': '選択した言語はこの環境の音声認識で利用できません。',
  };

  /* =======================================================================
   * 汎用ユーティリティ
   * ===================================================================== */

  const $ = (id) => document.getElementById(id);

  /** 2 桁ゼロ埋め */
  const pad2 = (n) => String(n).padStart(2, '0');

  /** 時刻のみ (HH:MM:SS) */
  function formatClock(ts) {
    const d = new Date(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  /** 日付込み (YYYY-MM-DD HH:MM:SS) */
  function formatStamp(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
           `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  /** ファイル名用のタイムスタンプ */
  function formatFileStamp(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-` +
           `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  }

  /** 経過時間 (MM:SS / HH:MM:SS) */
  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
  }

  /** 一意な ID（crypto が使えない環境へのフォールバック付き） */
  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /** MediaStream の全トラックを確実に停止する */
  function stopStream(stream) {
    if (!stream || typeof stream.getTracks !== 'function') return;
    for (const track of stream.getTracks()) {
      try { track.stop(); } catch (_) { /* 既に停止済みなら無視 */ }
    }
  }

  /* =======================================================================
   * Support — ブラウザ対応状況の判定
   * ===================================================================== */

  const Support = {
    /** SpeechRecognition コンストラクタ（未対応なら null） */
    SR: window.SpeechRecognition || window.webkitSpeechRecognition || null,
    /** HTTPS / localhost かどうか */
    secure: window.isSecureContext === true,
    /** getUserMedia が使えるか */
    getUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    /** SpeechRecognition.start(MediaStreamTrack) が使えるか（遅延判定） */
    trackInput: null,
    /** オンデバイス認識が使えるか（遅延判定） */
    onDevice: false,
    /** Chromium 系ブラウザか */
    chromium: /Chrome\/|Chromium\/|Edg\//.test(navigator.userAgent),

    /**
     * SpeechRecognition が MediaStreamTrack 入力に対応しているかを判定する。
     *
     * JavaScript は余分な引数を黙って捨てるため、単に start(track) を呼んでも
     * 「未対応なのでマイクを聴き続ける」という最悪の誤動作に気付けない。
     * そこで *不正な引数* を渡し、WebIDL の型変換で TypeError が投げられるか
     * どうかでオーバーロードの有無を判定する。
     *  - 対応環境 : MediaStreamTrack へ変換できず同期的に TypeError
     *  - 未対応環境: 引数が無視されて start() として動き出す → 直後に abort する
     *
     * マイク許可の取得後に一度だけ呼ぶこと（許可ダイアログを誘発しないため）。
     * @returns {Promise<boolean>}
     */
    async detectTrackInput() {
      if (this.trackInput !== null) return this.trackInput;

      // 動作確認用の手動オーバーライド（?trackInput=on / off）
      const forced = new URLSearchParams(location.search).get('trackInput');
      if (forced === 'on' || forced === 'off') {
        this.trackInput = (forced === 'on');
        return this.trackInput;
      }

      if (!this.SR) { this.trackInput = false; return false; }

      let probe = null;
      let supported = false;
      let started = false;

      // 判定用インスタンスが終了しきるまで待つための約束
      let settle = () => {};
      const settled = new Promise((resolve) => { settle = resolve; });

      try {
        probe = new this.SR();
        // 判定中のイベントでコンソールを汚さないよう空ハンドラを付けておく
        probe.onerror = () => {};
        probe.onend = () => settle();
        try {
          probe.start({});           // MediaStreamTrack ではない値をあえて渡す
          // 例外が出なかった＝引数が無視された（未対応）。実際に動き出しているので止める
          started = true;
        } catch (err) {
          supported = (err instanceof TypeError);
        }
      } catch (_) {
        supported = false;
      }

      if (probe && started) {
        try { probe.abort(); } catch (_) { /* noop */ }
        // 未対応環境ではマイクを掴んだ状態なので、完全に解放されるまで待ってから本番を開始する
        await Promise.race([settled, new Promise((r) => window.setTimeout(r, 500))]);
      }

      this.trackInput = supported;
      return supported;
    },

    /**
     * 指定言語のオンデバイス音声認識が即時利用可能かを調べる。
     * 利用できると遅延・プライバシー面で有利だが、未対応環境の方が多いため
     * 「使えたら使う」程度に留める。
     * @param {string} lang
     * @returns {Promise<boolean>}
     */
    async detectOnDevice(lang) {
      this.onDevice = false;
      const SR = this.SR;
      if (!SR || typeof SR.availableOnDevice !== 'function') return false;
      try {
        const status = await SR.availableOnDevice(lang);
        this.onDevice = (status === 'available' || status === true);
      } catch (_) {
        this.onDevice = false;
      }
      return this.onDevice;
    },
  };

  /* =======================================================================
   * DOM 参照
   * ===================================================================== */

  const dom = {
    // ヘッダー
    sessionBadge: $('session-badge'),
    sessionBadgeText: $('session-badge-text'),
    sessionTimer: $('session-timer'),
    // 入力状態
    pillMic: $('pill-mic'), pillMicValue: $('pill-mic-value'),
    selMic: $('sel-mic'),
    pillPc: $('pill-pc'), pillPcValue: $('pill-pc-value'),
    // 操作
    btnStart: $('btn-start'), btnStop: $('btn-stop'),
    btnCopy: $('btn-copy'), btnTxt: $('btn-txt'), btnClear: $('btn-clear'),
    // 表示
    alertArea: $('alert-area'),
    scrollArea: $('scroll-area'),
    entryList: $('entry-list'),
    liveArea: $('live-area'),
    emptyState: $('empty-state'),
    trimNotice: $('trim-notice'),
    btnJump: $('btn-jump'), jumpCount: $('jump-count'),
    statCount: $('stat-count'),
    toastArea: $('toast-area'),
  };

  /**
   * 起動時に DOM の取り違えを検出する（ID 不一致対策）。
   *
   * これが起きる典型例は、index.html だけ新しくなり app.js が
   * ブラウザキャッシュの古いままになったとき（GitHub Pages は 10 分間キャッシュする）。
   * コンソールに出すだけだと画面が無言で死んで「ボタンが効かない」ように見えるため、
   * 必ず画面にも対処方法を表示する。
   */
  function verifyDom() {
    const missing = Object.keys(dom).filter((k) => !dom[k]);
    if (missing.length === 0) return true;

    console.error('[TalkLog] 必要な要素が見つかりません:', missing.join(', '));
    showFatalBanner(
      'ページの読み込みに失敗しました',
      'ブラウザが古いファイルを表示している可能性があります。\n' +
      'Ctrl + Shift + R（強制再読み込み）でページを読み直してください。'
    );
    return false;
  }

  /** dom 参照が使えない状況でも確実に出せる、独立したエラー表示 */
  function showFatalBanner(title, message) {
    const box = document.createElement('div');
    box.setAttribute('role', 'alert');
    box.style.cssText =
      'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:9999;' +
      'max-width:min(560px,92vw);padding:14px 18px;border-radius:8px;' +
      'background:#c4314b;color:#fff;font:14px/1.6 "Segoe UI",system-ui,sans-serif;' +
      'box-shadow:0 8px 24px rgba(0,0,0,.3);white-space:pre-wrap;';

    const strong = document.createElement('div');
    strong.style.fontWeight = '600';
    strong.textContent = title;

    const body = document.createElement('div');
    body.textContent = message;

    box.appendChild(strong);
    box.appendChild(body);
    document.body.appendChild(box);
  }

  /* =======================================================================
   * Toast / Alerts — 通知
   * ===================================================================== */

  const Toast = {
    show(message) {
      const el = document.createElement('div');
      el.className = 'toast';
      el.textContent = message;
      dom.toastArea.appendChild(el);
      window.setTimeout(() => { el.remove(); }, CFG.TOAST_DURATION_MS);
    },
  };

  const Alerts = {
    /** key -> element。同じ key の通知は積み重ねず上書きする */
    _items: new Map(),

    /**
     * @param {string} key    重複防止用キー
     * @param {'info'|'ok'|'warn'|'error'} kind
     * @param {string} title
     * @param {string} [text]
     */
    show(key, kind, title, text) {
      this.dismiss(key);

      const box = document.createElement('div');
      box.className = 'alert';
      box.dataset.kind = kind;

      const body = document.createElement('div');
      body.className = 'alert-body';

      const t = document.createElement('div');
      t.className = 'alert-title';
      t.textContent = title;
      body.appendChild(t);

      if (text) {
        const d = document.createElement('div');
        d.className = 'alert-text';
        d.textContent = text;
        body.appendChild(d);
      }

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'alert-close';
      close.setAttribute('aria-label', '閉じる');
      close.textContent = '×';
      close.addEventListener('click', () => this.dismiss(key));

      box.appendChild(body);
      box.appendChild(close);
      dom.alertArea.appendChild(box);
      this._items.set(key, box);
    },

    dismiss(key) {
      const el = this._items.get(key);
      if (el) { el.remove(); this._items.delete(key); }
    },

    clearAll() {
      for (const el of this._items.values()) el.remove();
      this._items.clear();
    },
  };

  /* =======================================================================
   * StatusView — 状態表示
   * ===================================================================== */

  const StatusView = {
    /** @param {'off'|'ok'|'warn'|'error'} state */
    _set(pill, valueEl, state, text) {
      pill.dataset.state = state;
      valueEl.textContent = text;
    },
    mic(state, text) { this._set(dom.pillMic, dom.pillMicValue, state, text); },
    pc(state, text) { this._set(dom.pillPc, dom.pillPcValue, state, text); },

    /** @param {'idle'|'starting'|'running'} phase */
    session(phase, text) {
      dom.sessionBadge.dataset.state = phase;
      dom.sessionBadgeText.textContent = text;
      dom.sessionTimer.hidden = (phase !== 'running');
    },

    timer(ms) { dom.sessionTimer.textContent = formatDuration(ms); },

    /** すべて初期状態へ戻す */
    reset() {
      this.mic('off', '未接続');
      this.pc('off', '未接続');
      this.session('idle', '待機中');
    },
  };

  /**
   * 認識エンジンの状態 → 入力状態の表示。
   * 入力表示は 1 行に集約したので、認識が動いているかもここで表す。
   */
  const REC_STATE_VIEW = {
    idle:        ['ok', '接続済み'],
    starting:    ['ok', '接続済み'],
    listening:   ['ok', '使用中'],
    restarting:  ['warn', '再接続中'],
    stopped:     ['off', '停止'],
    error:       ['error', 'エラー'],
    unsupported: ['warn', '非対応'],
  };

  /* =======================================================================
   * AudioManager — メディアストリームの取得と解放
   * ===================================================================== */

  const AudioManager = {
    /** @type {MediaStream|null} */ micStream: null,
    /** @type {MediaStream|null} */ shareStream: null,

    /**
     * マイクを取得する。音声認識の品質を優先し、既定の音声処理は有効のまま使う。
     * @param {string} [deviceId] 指定があればそのマイクを使う（未指定なら既定）
     * @returns {Promise<MediaStream>}
     */
    async acquireMicrophone(deviceId) {
      if (!Support.getUserMedia) {
        throw new Error('この環境ではマイク取得 (getUserMedia) が利用できません。');
      }
      const audio = {
        echoCancellation: true,   // スピーカー再生の回り込みを抑える
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      };
      // 指定デバイスが使えない場合に開始ごと失敗しないよう ideal で指定する
      if (deviceId) audio.deviceId = { ideal: deviceId };

      const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      this.micStream = stream;
      return stream;
    },

    /** 選択できるマイクの一覧（ラベルはマイク許可後に埋まる） */
    async listMicrophones() {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') {
        return [];
      }
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter((d) => d.kind === 'audioinput' && d.deviceId);
      } catch (err) {
        console.warn('[TalkLog] マイク一覧を取得できませんでした:', err);
        return [];
      }
    },

    /**
     * 相手の声を取得する。
     *
     * ブラウザはセキュリティ上 PC 内部の再生音へ直接アクセスできないため、
     * タブ／画面の音声共有を経由するしかない。環境に依存せず確実に動く唯一の方法。
     * 利用者の操作（開始ボタン）直後に呼ぶこと（画面共有には操作起点が必要）。
     *
     * 音声認識へ回すため、加工（エコーキャンセル等）は切って原音に近づける。
     * @returns {Promise<MediaStream>}
     */
    async acquireShareAudio() {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
        throw new Error('この環境では画面共有を利用できません。');
      }
      const options = {
        video: { frameRate: { ideal: 5, max: 10 } }, // 映像は使わないので負荷を最小化
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include',        // 画面全体共有時にシステム音声を候補に含める
        selfBrowserSurface: 'exclude', // 自分のタブを候補から外す（音の回り込み防止）
        monitorTypeSurfaces: 'include',
      };
      let stream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia(options);
      } catch (err) {
        // オプションを解釈できない古い実装のときだけ最小構成で再試行する
        if (err && (err.name === 'TypeError' || err.name === 'NotSupportedError')) {
          stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        } else {
          throw err;
        }
      }
      this.shareStream = stream;
      return stream;
    },

    /** すべてのストリームを解放する */
    releaseAll() {
      stopStream(this.micStream);
      stopStream(this.shareStream);
      this.micStream = null;
      this.shareStream = null;
    },

    releaseShare() {
      stopStream(this.shareStream);
      this.shareStream = null;
    },
  };


  /* =======================================================================
   * RecognitionEngine — SpeechRecognition 1 系統分のラッパ
   * ===================================================================== */

  class RecognitionEngine {
    /**
     * @param {object} opts
     * @param {'self'|'remote'} opts.speaker
     * @param {(text:string)=>void} opts.onInterim  暫定結果（空文字なら消去）
     * @param {(text:string)=>void} opts.onFinal    確定結果
     * @param {(state:string)=>void} opts.onState   状態変化
     * @param {(reason:string, message:string)=>void} opts.onFatal 復帰不能な停止
     * @param {(reason:string, title:string, message:string)=>void} [opts.onNotice] 継続中の異常
     */
    constructor(opts) {
      this.speaker = opts.speaker;
      this.onInterim = opts.onInterim;
      this.onFinal = opts.onFinal;
      this.onState = opts.onState;
      this.onFatal = opts.onFatal;
      this.onNotice = opts.onNotice;
      /** 連続したネットワークエラー数（黙って再接続し続けないための計測） */
      this.networkFailures = 0;

      /** @type {SpeechRecognition|null} */
      this.recognition = null;
      /** @type {MediaStreamTrack|null} 入力に使う音声トラック（未使用なら既定マイク） */
      this.track = null;

      this.lang = 'ja-JP';
      this.processLocally = false;

      // --- 稼働状態 ---
      this.enabled = false;    // ユーザーが「動かしたい」と思っている状態
      this.isRunning = false;  // 実際に onstart 済みか
      this.isStopping = false; // 明示的な停止処理中か
      this.state = 'idle';

      // --- 自動再開の制御 ---
      this.restartTimerId = 0;
      this.startWatchdogId = 0;
      this.consecutiveRestarts = 0;
      this.restartHistory = [];  // 直近の再開時刻（暴走検知用）
      this.startedAt = 0;
      this.lastError = '';
    }

    get label() { return SPEAKER_LABEL[this.speaker]; }

    _setState(state) {
      if (this.state === state) return;
      this.state = state;
      if (this.onState) this.onState(state);
    }

    /** 入力する音声トラックを指定する（未指定なら既定のマイク入力） */
    setTrack(track) { this.track = track || null; }

    setLang(lang) { this.lang = lang; }

    setProcessLocally(flag) { this.processLocally = !!flag; }

    /** SpeechRecognition インスタンスを 1 つだけ作り、ハンドラを一度だけ登録する */
    _ensureRecognition() {
      if (this.recognition) return this.recognition;

      const rec = new Support.SR();
      rec.continuous = true;
      rec.interimResults = true;   // 低遅延表示の要
      rec.maxAlternatives = 1;
      rec.lang = this.lang;

      if (this.processLocally && 'processLocally' in rec) {
        try { rec.processLocally = true; } catch (_) { /* 未対応なら無視 */ }
      }

      rec.onstart = () => {
        window.clearTimeout(this.startWatchdogId);
        this.startWatchdogId = 0;
        this.isRunning = true;
        this.startedAt = Date.now();
        this.lastError = '';
        this._setState('listening');
      };

      rec.onresult = (event) => this._handleResult(event);

      rec.onerror = (event) => {
        this.lastError = (event && event.error) ? event.error : 'unknown';
        if (!BENIGN_ERRORS.has(this.lastError)) {
          console.warn(`[TalkLog] 認識エラー (${this.label}):`, this.lastError);
        }
      };

      rec.onend = () => this._handleEnd();

      this.recognition = rec;
      return rec;
    }

    /**
     * 結果イベントの処理。
     * results は累積配列なので resultIndex 以降だけを見る。
     * 暫定分は毎回まとめて渡し、確定だけを履歴へ送る。
     */
    _handleResult(event) {
      if (!event || !event.results) return;

      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const alt = result[0];
        if (!alt) continue;
        const text = alt.transcript || '';

        if (result.isFinal) {
          const trimmed = text.trim();
          if (trimmed) this.onFinal(trimmed);
        } else {
          interim += text;
        }
      }

      // 確定のみのイベントでは interim が空になり、暫定表示が消える
      this.onInterim(interim.trim());

      // 結果が返ってきている＝正常に動作している。バックオフと異常カウンタを解除する
      this.consecutiveRestarts = 0;
      this.networkFailures = 0;
    }

    /** 認識セッション終了時。ユーザーが止めたのでなければ再開する */
    _handleEnd() {
      const ranMs = this.startedAt > 0 ? Date.now() - this.startedAt : 0;
      this.isRunning = false;
      this.startedAt = 0;

      // 暫定表示は持ち越さない
      this.onInterim('');

      if (this.isStopping || !this.enabled) {
        this.isStopping = false;
        this._setState('stopped');
        return;
      }

      // 入力トラックが終了している（デバイス切断など）なら再開しない
      if (this.track && this.track.readyState === 'ended') {
        this.enabled = false;
        this._setState('stopped');
        if (this.onFatal) this.onFatal('track-ended', '共有音声が終了しました。');
        return;
      }

      const err = this.lastError;
      this.lastError = '';

      // 復帰不能なエラー
      if (FATAL_ERRORS.has(err)) {
        this.enabled = false;
        this._setState('error');
        if (this.onFatal) this.onFatal(err, ERROR_MESSAGE[err] || `音声認識が停止しました (${err})`);
        return;
      }

      // 選択言語がオンデバイスモデルに無い場合、クラウド処理へ切り替えて 1 度だけ再試行
      if (err === 'language-not-supported' && this.processLocally) {
        this.processLocally = false;
        this._disposeRecognition();
        Support.onDevice = false;
        this._scheduleRestart(CFG.RESTART_BASE_DELAY_MS);
        return;
      }
      if (err === 'language-not-supported') {
        this.enabled = false;
        this._setState('error');
        if (this.onFatal) this.onFatal(err, ERROR_MESSAGE[err]);
        return;
      }

      // ネットワークエラーが続くと「文字起こし中なのに何も出ない」状態になる。
      // 黙って再接続し続けず、必ず画面へ知らせる。
      if (err === 'network') {
        this.networkFailures++;
        if (this.networkFailures === CFG.NETWORK_FAILURES_BEFORE_NOTICE && this.onNotice) {
          this.onNotice('network', '音声認識サーバーに接続できません',
            'ブラウザの音声認識はインターネット経由で処理されます。ネットワーク接続、または社内プロキシ・ファイアウォールの設定をご確認ください。\n' +
            '（接続を再試行し続けています）');
        }
      } else {
        this.networkFailures = 0;
      }

      // 十分に長く動けていたなら、バックオフをリセットしてよい
      if (ranMs >= CFG.STABLE_RUN_MS) this.consecutiveRestarts = 0;

      const delay = err === 'network'
        ? CFG.RESTART_NETWORK_DELAY_MS
        : Math.min(
            CFG.RESTART_BASE_DELAY_MS * Math.pow(2, this.consecutiveRestarts),
            CFG.RESTART_MAX_DELAY_MS
          );

      this._setState('restarting');
      this._scheduleRestart(delay);
    }

    /** 再開を予約する。時間窓内の再開回数が多すぎる場合は暴走とみなし停止する */
    _scheduleRestart(delay) {
      const now = Date.now();
      this.restartHistory = this.restartHistory.filter((t) => now - t < CFG.RESTART_WINDOW_MS);
      this.restartHistory.push(now);

      if (this.restartHistory.length > CFG.RESTART_MAX_IN_WINDOW) {
        this.enabled = false;
        this._setState('error');
        if (this.onFatal) {
          this.onFatal('restart-loop',
            '音声認識の再接続を繰り返したため停止しました。ページを再読み込みしてお試しください。');
        }
        return;
      }

      this.consecutiveRestarts++;
      window.clearTimeout(this.restartTimerId);
      this.restartTimerId = window.setTimeout(() => {
        if (!this.enabled) return;
        this._invokeStart();
      }, delay);
    }

    /** 実際に start() を呼ぶ。トラック入力に対応していればトラックを渡す */
    _invokeStart() {
      const rec = this._ensureRecognition();
      rec.lang = this.lang;

      try {
        if (this.track && Support.trackInput) {
          rec.start(this.track);
        } else {
          rec.start();
        }
        // start() は成功したが onstart が来ないケースを監視する。
        // 到達しないまま放置すると「開始したのに無反応」になるため、必ず作り直す。
        window.clearTimeout(this.startWatchdogId);
        this.startWatchdogId = window.setTimeout(() => {
          if (!this.enabled || this.isRunning) return;
          console.warn(`[TalkLog] 認識が開始されませんでした。作り直します (${this.label})`);
          this._disposeRecognition();
          this._scheduleRestart(CFG.RESTART_BASE_DELAY_MS);
        }, CFG.START_TIMEOUT_MS);
      } catch (err) {
        // 直前のセッションがまだ終了していない場合。
        // start() が失敗した以上 onend は来ないので、必ず自分で再試行を予約する
        // （ここで return するだけだと永久に停止したままになる）。
        if (err && err.name === 'InvalidStateError') {
          try { rec.abort(); } catch (_) { /* noop */ }
          this._disposeRecognition();
          this._scheduleRestart(CFG.RESTART_BASE_DELAY_MS * 2);
          return;
        }
        this.enabled = false;
        this._setState('error');
        console.error(`[TalkLog] 認識を開始できません (${this.label}):`, err);
        if (this.onFatal) this.onFatal('start-failed', '音声認識を開始できませんでした。');
      }
    }

    /** 認識を開始する */
    start() {
      if (!Support.SR) {
        this._setState('unsupported');
        return;
      }
      if (this.enabled) return;

      this.enabled = true;
      this.isStopping = false;
      this.consecutiveRestarts = 0;
      this.restartHistory = [];
      this._setState('starting');
      this._invokeStart();
    }

    /** 認識を停止する（自動再開しない） */
    stop() {
      this.enabled = false;
      window.clearTimeout(this.restartTimerId);
      window.clearTimeout(this.startWatchdogId);
      this.restartTimerId = 0;
      this.startWatchdogId = 0;
      this.onInterim('');

      if (this.recognition && this.isRunning) {
        this.isStopping = true;
        try { this.recognition.stop(); } catch (_) { /* noop */ }
      }
      this.isRunning = false;
      this._setState('stopped');

      // 次回開始時にクリーンな状態から始めるため破棄する
      window.setTimeout(() => this._disposeRecognition(), 0);
    }

    /** インスタンスを破棄してハンドラを外す（リスナー重複と参照保持の防止） */
    _disposeRecognition() {
      const rec = this.recognition;
      if (!rec) return;
      this.recognition = null;
      rec.onstart = null;
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try { rec.abort(); } catch (_) { /* noop */ }
    }
  }

  /* =======================================================================
   * TranscriptStore — 会話データ（構造化して保持する）
   * ===================================================================== */

  const TranscriptStore = {
    /** @type {Array<{id:string, speaker:'self'|'remote', text:string, timestamp:number}>} */
    entries: [],

    add(speaker, text) {
      const entry = { id: makeId(), speaker, text, timestamp: Date.now() };
      this.entries.push(entry);
      return entry;
    },

    clear() { this.entries = []; },

    get count() { return this.entries.length; },

    /** プレーンテキスト表現 */
    toText() {
      const header = `TalkLog 会話ログ\n書き出し日時: ${formatStamp(Date.now())}\n件数: ${this.entries.length}\n${'-'.repeat(40)}\n\n`;
      const body = this.entries
        .map((e) => `[${formatClock(e.timestamp)}] ${SPEAKER_LABEL[e.speaker]}\n${e.text}`)
        .join('\n\n');
      return header + body + '\n';
    },

  };

  /* =======================================================================
   * TranscriptView — 会話の DOM 描画
   *  - 確定分は 1 件ずつ append（全件再描画しない）
   *  - 暫定分は話者ごとに 1 要素を使い回し、textContent を書き換えるだけ
   *  - 書き込みは rAF で 1 フレーム 1 回にまとめる
   * ===================================================================== */

  const TranscriptView = {
    /** @type {{self:{row:HTMLElement,text:HTMLElement}|null, remote:{row:HTMLElement,text:HTMLElement}|null}} */
    liveNodes: { self: null, remote: null },
    /** 次フレームで反映する暫定テキスト */
    pendingInterim: { self: null, remote: null },
    rafId: 0,
    fallbackId: 0,
    /** 最下部に追従するか */
    pinned: true,
    /** 未読件数（追従していないときに数える） */
    unseen: 0,
    /** DOM 上の確定メッセージ件数 */
    renderedCount: 0,
    trimmed: false,

    init() {
      dom.scrollArea.addEventListener('scroll', () => this._onScroll(), { passive: true });
      dom.btnJump.addEventListener('click', () => this.scrollToBottom());
    },

    _onScroll() {
      const el = dom.scrollArea;
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight <= CFG.SCROLL_BOTTOM_THRESHOLD_PX;
      this.pinned = atBottom;
      if (atBottom) this._clearUnseen();
    },

    _clearUnseen() {
      this.unseen = 0;
      dom.jumpCount.textContent = '';
      dom.btnJump.hidden = true;
    },

    scrollToBottom() {
      dom.scrollArea.scrollTop = dom.scrollArea.scrollHeight;
      this.pinned = true;
      this._clearUnseen();
    },

    /** 話者行の骨組みを作る（テキスト要素を返す） */
    _createRow(speaker, isLive, timestamp) {
      const row = document.createElement('div');
      row.className = `row row-${speaker}` + (isLive ? ' row-live' : ' row-enter');

      const meta = document.createElement('div');
      meta.className = 'row-meta';

      const name = document.createElement('span');
      name.className = 'row-speaker';
      name.textContent = SPEAKER_LABEL[speaker];
      meta.appendChild(name);

      if (isLive) {
        const tag = document.createElement('span');
        tag.className = 'live-tag';
        tag.textContent = '認識中';
        meta.appendChild(tag);
      } else {
        const time = document.createElement('span');
        time.className = 'row-time';
        time.textContent = formatClock(timestamp);
        meta.appendChild(time);
      }

      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      // 認識結果は必ず textContent で流し込む（innerHTML は使わない）
      bubble.textContent = '';

      row.appendChild(meta);
      row.appendChild(bubble);
      return { row, text: bubble };
    },

    /** 確定メッセージを 1 件追加する */
    appendFinal(entry) {
      dom.emptyState.hidden = true;

      const { row } = this._createRowWithText(entry);
      dom.entryList.appendChild(row);
      this.renderedCount++;
      this._trimIfNeeded();

      if (this.pinned) {
        this._scheduleFlush();
      } else {
        this.unseen++;
        dom.jumpCount.textContent = String(this.unseen);
        dom.btnJump.hidden = false;
      }
    },

    _createRowWithText(entry) {
      const built = this._createRow(entry.speaker, false, entry.timestamp);
      built.text.textContent = entry.text;
      return built;
    },

    /** 表示件数が増えすぎたら古い行を DOM から外す（データは保持したまま） */
    _trimIfNeeded() {
      if (this.renderedCount <= CFG.MAX_RENDERED_ENTRIES) return;
      let removed = 0;
      while (removed < CFG.TRIM_CHUNK && dom.entryList.firstElementChild) {
        dom.entryList.removeChild(dom.entryList.firstElementChild);
        removed++;
      }
      this.renderedCount -= removed;
      if (!this.trimmed) {
        this.trimmed = true;
        dom.trimNotice.hidden = false;
      }
    },

    /** 暫定テキストを予約する（実際の書き込みは次フレーム） */
    setInterim(speaker, text) {
      this.pendingInterim[speaker] = text;
      this._scheduleFlush();
    },

    /**
     * 反映を次フレームへ予約する。
     * 背景タブでは requestAnimationFrame が停止するため（このアプリは別タブを
     * 共有して使うのが普通で、自分自身は背景タブになりやすい）、
     * setTimeout のフォールバックを併走させ、先に発火した方で反映する。
     */
    _scheduleFlush() {
      if (this.rafId !== 0 || this.fallbackId !== 0) return;
      this.rafId = window.requestAnimationFrame(() => this._flush());
      this.fallbackId = window.setTimeout(() => this._flush(), CFG.FLUSH_FALLBACK_MS);
    },

    _flush() {
      // どちらの経路で来ても、もう片方の予約は取り消す
      if (this.rafId !== 0) { window.cancelAnimationFrame(this.rafId); this.rafId = 0; }
      if (this.fallbackId !== 0) { window.clearTimeout(this.fallbackId); this.fallbackId = 0; }

      for (const speaker of [SPEAKER.SELF, SPEAKER.REMOTE]) {
        const text = this.pendingInterim[speaker];
        if (text === null) continue;
        this.pendingInterim[speaker] = null;

        if (text) {
          let node = this.liveNodes[speaker];
          if (!node) {
            const built = this._createRow(speaker, true, Date.now());
            // 「自分」が下に来るよう順序を固定する
            if (speaker === SPEAKER.SELF) {
              dom.liveArea.appendChild(built.row);
            } else {
              dom.liveArea.insertBefore(built.row, dom.liveArea.firstChild);
            }
            node = { row: built.row, text: built.text };
            this.liveNodes[speaker] = node;
            dom.emptyState.hidden = true;
          }
          if (node.text.textContent !== text) node.text.textContent = text;
        } else {
          this._removeLive(speaker);
        }
      }

      if (this.pinned) {
        dom.scrollArea.scrollTop = dom.scrollArea.scrollHeight;
      }
    },

    _removeLive(speaker) {
      const node = this.liveNodes[speaker];
      if (!node) return;
      node.row.remove();
      this.liveNodes[speaker] = null;
    },

    /** 暫定表示をすべて消す */
    clearLive() {
      this.pendingInterim.self = null;
      this.pendingInterim.remote = null;
      this._removeLive(SPEAKER.SELF);
      this._removeLive(SPEAKER.REMOTE);
    },

    /** 会話表示を初期化する */
    clearAll() {
      this.clearLive();
      dom.entryList.replaceChildren();
      this.renderedCount = 0;
      this.trimmed = false;
      dom.trimNotice.hidden = true;
      dom.emptyState.hidden = false;
      this._clearUnseen();
      this.pinned = true;
    },
  };

  /* =======================================================================
   * Exporter — コピー / ダウンロード
   * ===================================================================== */

  const Exporter = {
    async copyAll() {
      if (TranscriptStore.count === 0) { Toast.show('コピーする会話がありません'); return; }
      const text = TranscriptStore.toText();
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
        } else {
          this._legacyCopy(text);
        }
        Toast.show(`${TranscriptStore.count} 件をコピーしました`);
      } catch (err) {
        console.warn('[TalkLog] クリップボードへの書き込みに失敗:', err);
        try {
          this._legacyCopy(text);
          Toast.show('コピーしました');
        } catch (_) {
          Alerts.show('copy', 'error', 'コピーできませんでした',
            'ブラウザの権限設定でクリップボードへの書き込みを許可してください。');
        }
      }
    },

    /** clipboard API が使えない場合の代替手段 */
    _legacyCopy(text) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    },

    downloadTxt() {
      if (TranscriptStore.count === 0) { Toast.show('保存する会話がありません'); return; }
      // UTF-8 BOM を付けてメモ帳等での文字化けを防ぐ
      this._download(
        new Blob([BOM + TranscriptStore.toText()], { type: 'text/plain;charset=utf-8' }),
        `talklog-${formatFileStamp(Date.now())}.txt`
      );
      Toast.show('TXT を保存しました');
    },

    _download(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      // オブジェクト URL は必ず解放する
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };

  /* =======================================================================
   * App — 全体制御
   * ===================================================================== */

  const App = {
    /** @type {'idle'|'starting'|'running'} */
    phase: 'idle',
    /** @type {RecognitionEngine|null} */ selfEngine: null,
    /** @type {RecognitionEngine|null} */ remoteEngine: null,
    /** @type {MediaStreamTrack|null} */ remoteTrack: null,
    /** @type {MediaStreamTrack|null} */ micTrack: null,
    startedAt: 0,
    timerId: 0,
    noResultTimerId: 0,
    resultSeen: false,

    init() {
      if (!verifyDom()) return;

      TranscriptView.init();
      StatusView.reset();
      this._bindUi();
      this._checkEnvironment();
      this._updateCount();
      // 既に許可済みならこの時点で実名が並ぶ。未許可なら「既定のマイク」のみ
      this._refreshMicList();
    },

    /* ---------- マイク選択 ---------- */

    /** 前回選んだマイクを読み出す */
    _loadMicChoice() {
      try { return window.localStorage.getItem(MIC_STORAGE_KEY) || ''; }
      catch (_) { return ''; }   // プライベートモード等で localStorage が使えない場合
    },

    _saveMicChoice(deviceId) {
      try {
        if (deviceId) window.localStorage.setItem(MIC_STORAGE_KEY, deviceId);
        else window.localStorage.removeItem(MIC_STORAGE_KEY);
      } catch (_) { /* 保存できなくても動作に支障はない */ }
    },

    /**
     * マイク一覧をセレクトボックスへ反映する。
     * デバイス名はマイク許可後でないと空になるため、許可取得後にも呼び直す。
     */
    async _refreshMicList() {
      const devices = await AudioManager.listMicrophones();
      const wanted = dom.selMic.value || this._loadMicChoice();

      dom.selMic.replaceChildren();

      const defaultOption = document.createElement('option');
      defaultOption.value = '';
      defaultOption.textContent = '既定のマイク';
      dom.selMic.appendChild(defaultOption);

      for (const d of devices) {
        // 「既定 -」「通信 -」は Chrome が付ける別名。実体は下の個別デバイスと同じ
        if (d.deviceId === 'default' || d.deviceId === 'communications') continue;
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || 'マイク';
        dom.selMic.appendChild(opt);
      }

      // 保存済みの選択が今も存在すれば復元する
      const exists = Array.from(dom.selMic.options).some((o) => o.value === wanted);
      dom.selMic.value = exists ? wanted : '';
    },

    /* ---------- 起動時チェック ---------- */

    _checkEnvironment() {
      if (!Support.secure) {
        dom.btnStart.disabled = true;
        Alerts.show('env-secure', 'error', 'HTTPS または localhost で開いてください',
          'マイクの使用にはセキュアな接続が必要です。https:// のURL、もしくは http://localhost でアクセスしてください。');
        return;
      }
      if (!Support.SR) {
        dom.btnStart.disabled = true;
        Alerts.show('env-sr', 'error', 'このブラウザは音声認識に対応していません',
          'Windows 11 + Google Chrome 最新版でご利用ください。（Web Speech API 対応が必要です）');
        return;
      }
      if (!Support.getUserMedia) {
        dom.btnStart.disabled = true;
        Alerts.show('env-media', 'error', 'この環境ではマイクを取得できません',
          'Google Chrome 最新版のご利用を推奨します。');
        return;
      }
      if (!Support.chromium) {
        Alerts.show('env-browser', 'warn', 'Google Chrome 最新版を推奨します',
          '現在のブラウザでは相手の発言の文字起こしが動作しない可能性があります。');
      }
    },

    /* ---------- UI イベント（各要素につき 1 度だけ登録） ---------- */

    _bindUi() {
      dom.btnStart.addEventListener('click', () => { this.start(); });
      dom.btnStop.addEventListener('click', () => { this.stop('user'); });
      dom.btnCopy.addEventListener('click', () => { Exporter.copyAll(); });
      dom.btnTxt.addEventListener('click', () => { Exporter.downloadTxt(); });
      dom.btnClear.addEventListener('click', () => { this.clearLog(); });
      dom.selMic.addEventListener('change', () => { this._saveMicChoice(dom.selMic.value); });

      // マイクの抜き差しに追従する
      if (navigator.mediaDevices && 'ondevicechange' in navigator.mediaDevices) {
        navigator.mediaDevices.addEventListener('devicechange', () => { this._refreshMicList(); });
      }

      // 終了時のリソース解放（ページ離脱でストリームが残らないように）
      window.addEventListener('pagehide', () => { this._teardown(); }, { once: true });

      window.addEventListener('beforeunload', (e) => {
        if (this.phase === 'running' && TranscriptStore.count > 0) {
          e.preventDefault();
          e.returnValue = '';
        }
      });
    },

    _setPhase(phase) {
      this.phase = phase;
      const running = (phase === 'running');
      const busy = (phase !== 'idle');

      dom.btnStart.disabled = busy;
      dom.btnStop.disabled = !running;
      dom.selMic.disabled = busy;   // 動作中の切り替えは混乱のもとなので止めてから

      if (phase === 'idle') StatusView.session('idle', '待機中');
      else if (phase === 'starting') StatusView.session('starting', '準備中…');
      else StatusView.session('running', '文字起こし中');
    },

    /* ---------- 開始フロー ---------- */

    async start() {
      if (this.phase !== 'idle') return;

      Alerts.clearAll();
      this._setPhase('starting');

      const lang = LANG;

      try {
        /* ---- STEP 1: マイク取得 ---- */
        StatusView.mic('warn', '要求中…');
        let micStream;
        try {
          micStream = await AudioManager.acquireMicrophone(dom.selMic.value);
        } catch (err) {
          this._handleMicError(err);
          throw new Error('__handled__');
        }
        this.micTrack = micStream.getAudioTracks()[0] || null;
        if (!this.micTrack) {
          StatusView.mic('error', '取得失敗');
          Alerts.show('mic', 'error', 'マイクの音声トラックを取得できませんでした',
            'PC にマイクが接続されているか確認してください。');
          throw new Error('__handled__');
        }
        StatusView.mic('ok', '接続済み');
        // デバイスが外れた場合に検知する
        this.micTrack.addEventListener('ended', () => this._onMicEnded());
        // 許可が下りたのでデバイス名が読めるようになる。一覧を実名へ更新する
        this._refreshMicList();

        /* ---- STEP 2: 相手音声（タブ／画面の音声共有）の取得 ----
           画面共有は「利用者の操作直後」でないと呼べないため、マイク取得の直後に行う。
           取得できなくても自分側は続行する（開始は中断しない）。 */
        StatusView.pc('warn', '選択待ち…');
        await this._acquireRemoteAudio();

        /* ---- 機能検出（共有取得のあと。ここで待つと操作起点が切れるため後回し） ---- */
        await Support.detectTrackInput();
        await Support.detectOnDevice(lang);

        if (this.remoteTrack && !Support.trackInput) {
          // 音声は取得できたが、このブラウザでは認識へ流し込めない
          this.remoteTrack = null;
          AudioManager.releaseShare();
          StatusView.pc('warn', '非対応');
          Alerts.show('pc', 'warn', 'このブラウザでは相手の発言を文字起こしできません',
            'お使いのブラウザは音声認識への音声トラック指定に対応していません。\n' +
            'Google Chrome を最新版に更新してください。\n' +
            '（現在は自分の発言のみ文字起こししています）');
        }

        /* ---- STEP 3: 音声認識の開始（自分・相手を完全に分離） ---- */
        this._startSelfEngine(lang);
        if (this.remoteTrack) this._startRemoteEngine(lang);

        this._setPhase('running');
        this._startTimer();
        this._startNoResultWatch();

      } catch (err) {
        // 各ステップで案内済みのエラーは黙って後始末する
        if (!err || err.message !== '__handled__') {
          console.error('[TalkLog] 開始処理で予期しないエラー:', err);
          Alerts.show('start', 'error', '文字起こしを開始できませんでした',
            (err && err.message) ? err.message : String(err));
        }
        this._teardown();
        this._setPhase('idle');
        StatusView.reset();
      }
    },

    _startSelfEngine(lang) {
      this.selfEngine = new RecognitionEngine({
        speaker: SPEAKER.SELF,
        onInterim: (text) => {
          if (text) this._markResultSeen();
          TranscriptView.setInterim(SPEAKER.SELF, text);
        },
        onFinal: (text) => this._commit(SPEAKER.SELF, text),
        onState: (state) => {
          const [kind, label] = REC_STATE_VIEW[state] || ['off', state];
          StatusView.mic(kind, label);
        },
        onFatal: (reason, message) => {
          Alerts.show('rec-self', 'error', '自分側の文字起こしが停止しました', message);
          StatusView.mic('error', 'エラー');
        },
        onNotice: (reason, title, message) => {
          Alerts.show(`notice-${reason}`, 'error', title, message);
        },
      });
      this.selfEngine.setLang(lang);
      this.selfEngine.setProcessLocally(Support.onDevice);
      // 自分側は既定のマイク入力をそのまま使う。
      // トラックを渡さない方が実装依存の少ない経路になるため、あえて指定しない。
      this.selfEngine.start();
    },

    _startRemoteEngine(lang) {
      this.remoteEngine = new RecognitionEngine({
        speaker: SPEAKER.REMOTE,
        onInterim: (text) => {
          if (text) this._markResultSeen();
          TranscriptView.setInterim(SPEAKER.REMOTE, text);
        },
        onFinal: (text) => this._commit(SPEAKER.REMOTE, text),
        onState: (state) => {
          const [kind, label] = REC_STATE_VIEW[state] || ['off', state];
          StatusView.pc(kind, label);
        },
        onFatal: (reason, message) => {
          if (reason === 'track-ended') return; // 入力終了時は別途案内する
          Alerts.show('rec-remote', 'error', '相手側の文字起こしが停止しました', message);
        },
        onNotice: (reason, title, message) => {
          Alerts.show(`notice-${reason}`, 'error', title, message);
        },
      });
      this.remoteEngine.setLang(lang);
      this.remoteEngine.setProcessLocally(Support.onDevice);
      this.remoteEngine.setTrack(this.remoteTrack);
      this.remoteEngine.start();
    },

    /* ---------- エラー案内 ---------- */

    _handleMicError(err) {
      const name = err && err.name ? err.name : '';
      StatusView.mic('error', name === 'NotAllowedError' ? '許可なし' : '取得失敗');

      if (name === 'NotAllowedError' || name === 'SecurityError') {
        Alerts.show('mic', 'error', 'マイクへのアクセスが許可されていません。',
          'アドレスバー右側のアイコンからマイクを「許可」に変更し、もう一度お試しください。');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        Alerts.show('mic', 'error', 'マイクが見つかりませんでした',
          'PC にマイクが接続されているか、Windows のサウンド設定を確認してください。');
      } else if (name === 'NotReadableError') {
        Alerts.show('mic', 'error', 'マイクを使用できませんでした',
          '他のアプリ（会議ソフトなど）がマイクを占有している可能性があります。');
      } else {
        Alerts.show('mic', 'error', 'マイクを取得できませんでした',
          (err && err.message) ? err.message : String(err));
      }
    },

    /* ---------- 相手音声の取得 ---------- */

    /**
     * タブ／画面の音声共有から相手の声を取り出す。
     * 失敗しても例外を投げず、自分側だけで開始を続行できるようにしている。
     */
    async _acquireRemoteAudio() {
      // 事前に userActivation を判定すると、実際には呼べる場面まで弾いてしまう。
      // まず呼んでみて、操作起点切れ（InvalidStateError）は下で個別に案内する。
      let stream;
      try {
        stream = await AudioManager.acquireShareAudio();
      } catch (err) {
        const name = err && err.name ? err.name : '';
        StatusView.pc('warn', '未共有');
        if (name === 'NotAllowedError') {
          Alerts.show('pc', 'warn', '相手の音声は共有されませんでした',
            '共有をキャンセルしたため、相手の発言は文字起こしされません。\n' +
            '（自分の発言のみ文字起こししています）');
        } else if (name === 'InvalidStateError') {
          Alerts.show('pc', 'warn', '相手の音声を取り込めませんでした',
            'もう一度「文字起こし開始」を押してください。',);
        } else {
          console.warn('[TalkLog] 相手音声を取得できませんでした:', err);
          Alerts.show('pc', 'warn', '相手の音声を取り込めませんでした',
            (err && err.message) ? err.message : String(err));
        }
        return;
      }

      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        // 音声なしで共有された場合（「ウィンドウ」選択や音声共有OFF）
        AudioManager.releaseShare();
        StatusView.pc('warn', '音声なし');
        Alerts.show('pc', 'warn', '共有した画面・タブの音声が取得できませんでした',
          '共有ダイアログの左下にある「タブの音声を共有」または「システム音声を共有」を ON にしてください。\n' +
          '※「ウィンドウ」を選ぶと音声は共有できません。「Chrome のタブ」か「画面全体」を選んでください。\n' +
          '（このままでも自分の発言は文字起こしされます）');
        return;
      }

      this.remoteTrack = audioTracks[0];
      StatusView.pc('ok', '接続済み');
      // 共有停止（Chrome の「共有を停止」バー）を検知する
      this.remoteTrack.addEventListener('ended', () => this._onRemoteTrackEnded());
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) videoTrack.addEventListener('ended', () => this._onRemoteTrackEnded());
    },

    /* ---------- トラック終了の検知 ---------- */

    _onRemoteTrackEnded() {
      if (this.phase !== 'running') return;
      if (!this.remoteTrack) return;

      this.remoteTrack = null;
      if (this.remoteEngine) {
        this.remoteEngine.stop();
        this.remoteEngine = null;
      }
      AudioManager.releaseShare();

      StatusView.pc('warn', '共有停止');
      TranscriptView.setInterim(SPEAKER.REMOTE, '');
      Alerts.show('pc', 'warn', '画面共有が停止しました',
        '相手側の文字起こしのみ停止しました。自分側の文字起こしは継続しています。');
    },

    _onMicEnded() {
      if (this.phase !== 'running') return;
      this.micTrack = null;
      if (this.selfEngine) {
        this.selfEngine.stop();
        this.selfEngine = null;
      }
      StatusView.mic('error', '切断');
      TranscriptView.setInterim(SPEAKER.SELF, '');
      Alerts.show('mic', 'error', 'マイクが切断されました',
        'マイクが取り外されたか、他のアプリに奪われた可能性があります。');
    },

    /* ---------- 確定テキストの登録 ---------- */

    _commit(speaker, text) {
      this._markResultSeen();
      const entry = TranscriptStore.add(speaker, text);
      TranscriptView.appendFinal(entry);
      this._updateCount();
    },

    /** 何らかの認識結果が届いたことを記録し、ヒント表示を取り消す */
    _markResultSeen() {
      if (this.resultSeen) return;
      this.resultSeen = true;
      window.clearTimeout(this.noResultTimerId);
      this.noResultTimerId = 0;
      Alerts.dismiss('no-result');
    },

    /**
     * 一定時間まったく認識結果が無い場合にヒントを出す。
     * 「開始したのに何も起きない」ときに、利用者が原因を自力で切り分けられるようにする。
     */
    _startNoResultWatch() {
      this.resultSeen = false;
      window.clearTimeout(this.noResultTimerId);
      this.noResultTimerId = window.setTimeout(() => {
        if (this.resultSeen || this.phase !== 'running') return;
        Alerts.show('no-result', 'warn', 'まだ音声を認識できていません',
          '次をご確認ください。\n' +
          '・Windows の設定で、使用中のマイクの入力音量が上がっているか\n' +
          '・アドレスバー左の🎤アイコンでマイクが「許可」になっているか\n' +
          '・インターネットに接続されているか（音声認識はサーバー経由で処理されます）\n' +
          '・少し大きめの声で話してみてください');
      }, CFG.NO_RESULT_HINT_MS);
    },

    _updateCount() {
      dom.statCount.textContent = `${TranscriptStore.count} 件`;
    },

    /* ---------- セッション時間 ---------- */

    _startTimer() {
      this.startedAt = Date.now();
      StatusView.timer(0);
      window.clearInterval(this.timerId);
      this.timerId = window.setInterval(() => {
        StatusView.timer(Date.now() - this.startedAt);
      }, CFG.TIMER_INTERVAL_MS);
    },

    _stopTimer() {
      window.clearInterval(this.timerId);
      this.timerId = 0;
      window.clearTimeout(this.noResultTimerId);
      this.noResultTimerId = 0;
    },

    /* ---------- 停止 ---------- */

    stop(reason) {
      if (this.phase === 'idle') return;
      this._teardown();
      this._setPhase('idle');
      StatusView.reset();
      if (reason === 'user') Toast.show('文字起こしを停止しました');
    },

    /** すべてのリソースを解放し、再開始できる状態へ戻す */
    _teardown() {
      this._stopTimer();

      if (this.selfEngine) { this.selfEngine.stop(); this.selfEngine = null; }
      if (this.remoteEngine) { this.remoteEngine.stop(); this.remoteEngine = null; }

      TranscriptView.clearLive();
      AudioManager.releaseAll();

      this.micTrack = null;
      this.remoteTrack = null;
    },

    /* ---------- ログのクリア ---------- */

    clearLog() {
      if (TranscriptStore.count === 0) { Toast.show('会話ログは空です'); return; }
      const ok = window.confirm(
        `会話ログ ${TranscriptStore.count} 件をすべて削除します。よろしいですか？\n（この操作は取り消せません）`
      );
      if (!ok) return;
      TranscriptStore.clear();
      TranscriptView.clearAll();
      this._updateCount();
      Toast.show('会話ログをクリアしました');
    },
  };

  /* =======================================================================
   * 起動
   * ===================================================================== */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => App.init(), { once: true });
  } else {
    App.init();
  }

})();
