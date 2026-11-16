/**
 * LocalDevTool inspector — 注入到被代理頁面的右鍵挖掘腳本（規格 §7.1）。
 *
 * 鐵則：**絕不能弄壞被代理的原站。**
 *  - 全部包在 IIFE 裡，只掛一個 window.__LDT__
 *  - 包裝 fetch / XHR 時完全透明：回傳值、例外、Response 物件都不改
 *  - 任何自身錯誤都吞掉並 console.warn，不往上拋
 *
 * 另一條鐵則：**admin token 絕不出現在這支腳本裡。** 被代理的頁面會跑原站的
 * 第三方 JS，拿到 token 就等於拿到整個觀測資料庫。所以面板走 /__ldt/* 這組
 * 同源受限端點（只回摘要、不回 body），完整詳情要到 /admin/network 看。
 */
(function () {
  'use strict';

  if (window.__LDT__) return;

  var SCRIPT = document.currentScript;
  var SITE_ID = (SCRIPT && SCRIPT.getAttribute('data-ldt-site')) || '';
  var EVENTS_URL = '/__ldt/events';
  var TRACE_URL = '/__ldt/trace';
  var ASSOCIATION_WINDOW_MS = 1500;
  var MAX_TRACKED = 300;
  var FLUSH_INTERVAL_MS = 2000;
  var FLUSH_THRESHOLD = 20;

  // 一開始就抓住原生 fetch：上報自己也要用它，否則會被我們的包裝再記錄一次（無限遞迴）。
  var nativeFetch = window.fetch;

  var state = {
    lastInteraction: null,
    requests: [],
    media: [],
    drm: [],
    queue: [],
    flushTimer: null,
  };

  function warn(where, error) {
    try {
      console.warn('[LocalDevTool] inspector 內部錯誤 @' + where, error);
    } catch (ignored) {
      /* console 也壞掉的話就真的沒辦法了，但絕不能往上拋 */
    }
  }

  /** 包一層：出錯只記 log，不影響呼叫端。 */
  function guard(where, fn) {
    return function () {
      try {
        return fn.apply(this, arguments);
      } catch (error) {
        warn(where, error);
        return undefined;
      }
    };
  }

  function makeId() {
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    } catch (ignored) {
      /* 非安全上下文沒有 randomUUID，退回時間戳 */
    }
    return 'c-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function cap(list) {
    if (list.length > MAX_TRACKED) list.splice(0, list.length - MAX_TRACKED);
    return list;
  }

  function describeElement(element) {
    if (!element || !element.tagName) return '(unknown)';
    var text = element.tagName.toLowerCase();
    if (element.id) text += '#' + element.id;
    if (element.className && typeof element.className === 'string') {
      text += '.' + element.className.trim().split(/\s+/).slice(0, 3).join('.');
    }
    return text;
  }

  // ---------------------------------------------------------------- 上報（批次 + 節流）

  function flush() {
    if (state.queue.length === 0) return;
    var payload = JSON.stringify({ siteId: SITE_ID, events: state.queue.splice(0) });

    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([payload], { type: 'application/json' });
        if (navigator.sendBeacon(EVENTS_URL, blob)) return;
      }
    } catch (error) {
      warn('sendBeacon', error);
    }
    try {
      // 用原生 fetch，否則會被自己的包裝再記錄一次（無限遞迴）。
      nativeFetch.call(window, EVENTS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
        keepalive: true,
      })['catch'](function () {
        /* 上報失敗就算了，不能影響頁面 */
      });
    } catch (error) {
      warn('flush-fetch', error);
    }
  }

  function report(event) {
    state.queue.push(event);
    if (state.queue.length >= FLUSH_THRESHOLD) {
      flush();
      return;
    }
    if (state.flushTimer === null) {
      state.flushTimer = window.setTimeout(function () {
        state.flushTimer = null;
        flush();
      }, FLUSH_INTERVAL_MS);
    }
  }

  // ---------------------------------------------------------------- 互動元素追蹤

  function noteInteraction(event) {
    state.lastInteraction = { element: event.target, at: Date.now() };
  }

  ['pointerdown', 'click', 'contextmenu'].forEach(function (type) {
    // capture phase：原站如果 stopPropagation 我們還是看得到。
    document.addEventListener(type, guard('interaction', noteInteraction), true);
  });

  /** 請求發生時，若距最後互動很近，就建立「元素 ↔ 請求」的關聯。 */
  function currentTrigger() {
    var last = state.lastInteraction;
    if (!last) return null;
    if (Date.now() - last.at > ASSOCIATION_WINDOW_MS) return null;
    return last;
  }

  // ---------------------------------------------------------------- 請求攔截

  function trackRequest(method, url, corrId, stack) {
    var trigger = currentTrigger();
    var entry = {
      corrId: corrId,
      method: method,
      url: String(url),
      at: Date.now(),
      status: null,
      stack: stack,
      triggerElement: trigger ? trigger.element : null,
      triggerDescription: trigger ? describeElement(trigger.element) : null,
    };
    cap(state.requests).push(entry);

    report({
      kind: 'request',
      corrId: corrId,
      method: method,
      url: entry.url,
      at: entry.at,
      stack: stack,
      trigger: entry.triggerDescription,
    });
    return entry;
  }

  function callerStack() {
    try {
      var stack = new Error().stack || '';
      // 前幾行是我們自己的包裝，對使用者沒意義。
      return stack.split('\n').slice(3, 9).join('\n');
    } catch (error) {
      return null;
    }
  }

  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      var corrId = makeId();
      var patchedInit = init;
      var method = 'GET';
      var url = '';

      try {
        var isRequestObject =
          typeof Request !== 'undefined' && input instanceof Request;
        url = isRequestObject ? input.url : String(input);
        method = (init && init.method) || (isRequestObject && input.method) || 'GET';

        // Request 物件的 header 不好安全地改（body 可能是 stream），
        // 所以只有「字串 URL + 普通 init」才注入關聯 header，其餘只觀察。
        if (!isRequestObject) {
          var headers = new Headers((init && init.headers) || {});
          headers.set('x-ldt-corr', corrId);
          patchedInit = Object.assign({}, init, { headers: headers });
        }
      } catch (error) {
        warn('fetch-prepare', error);
        patchedInit = init;
      }

      // 真正的呼叫 —— 同步例外必須原樣往外拋，不能被我們攔住。
      var promise = nativeFetch.call(this, input, patchedInit);

      try {
        var entry = trackRequest(String(method).toUpperCase(), url, corrId, callerStack());
        promise.then(
          function (response) {
            try {
              entry.status = response.status;
            } catch (error) {
              warn('fetch-status', error);
            }
          },
          function () {
            /* 失敗由原站處理，我們不介入；這個 handler 只為了不產生 unhandled rejection */
          },
        );
      } catch (error) {
        warn('fetch-track', error);
      }

      // 回傳原始 promise，不是衍生的 —— 行為必須完全一致。
      return promise;
    };
  }

  if (typeof XMLHttpRequest === 'function') {
    var nativeOpen = XMLHttpRequest.prototype.open;
    var nativeSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        this.__ldt = { method: String(method || 'GET').toUpperCase(), url: String(url || '') };
      } catch (error) {
        warn('xhr-open', error);
      }
      return nativeOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function () {
      var self = this;
      try {
        var info = this.__ldt || { method: 'GET', url: '' };
        var corrId = makeId();
        info.corrId = corrId;
        try {
          this.setRequestHeader('x-ldt-corr', corrId);
        } catch (error) {
          /* 某些狀態下不准設 header，不是錯誤 */
        }
        var entry = trackRequest(info.method, info.url, corrId, callerStack());
        this.addEventListener('load', function () {
          try {
            entry.status = self.status;
          } catch (error) {
            warn('xhr-status', error);
          }
        });
      } catch (error) {
        warn('xhr-send', error);
      }
      return nativeSend.apply(this, arguments);
    };
  }

  // ---------------------------------------------------------------- 媒體與 DRM 觀測

  function noteMedia(element, value, how) {
    if (!value) return;
    var source = String(value);
    var entry = {
      kind: 'media',
      how: how,
      url: source,
      isBlob: source.indexOf('blob:') === 0,
      element: describeElement(element),
      at: Date.now(),
    };
    cap(state.media).push(entry);
    report(entry);
  }

  try {
    var mediaDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (mediaDescriptor && typeof mediaDescriptor.set === 'function') {
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        configurable: true,
        enumerable: mediaDescriptor.enumerable,
        get: mediaDescriptor.get,
        set: function (value) {
          try {
            noteMedia(this, value, 'src-setter');
          } catch (error) {
            warn('media-setter', error);
          }
          return mediaDescriptor.set.call(this, value);
        },
      });
    }

    var nativeLoad = HTMLMediaElement.prototype.load;
    HTMLMediaElement.prototype.load = function () {
      try {
        noteMedia(this, this.currentSrc || this.src, 'load()');
      } catch (error) {
        warn('media-load', error);
      }
      return nativeLoad.apply(this, arguments);
    };
  } catch (error) {
    warn('media-hook', error);
  }

  try {
    if (navigator.requestMediaKeySystemAccess) {
      var nativeEme = navigator.requestMediaKeySystemAccess.bind(navigator);
      navigator.requestMediaKeySystemAccess = function (keySystem) {
        try {
          var entry = { kind: 'drm', keySystem: String(keySystem), at: Date.now() };
          cap(state.drm).push(entry);
          report(entry);
        } catch (error) {
          warn('eme-track', error);
        }
        return nativeEme.apply(null, arguments);
      };
    }
  } catch (error) {
    warn('eme-hook', error);
  }

  try {
    var observer = new MutationObserver(
      guard('mutation', function (records) {
        for (var i = 0; i < records.length; i += 1) {
          var record = records[i];
          if (record.type !== 'attributes') continue;
          var target = record.target;
          var tag = target.tagName && target.tagName.toLowerCase();
          if (tag !== 'video' && tag !== 'audio' && tag !== 'source') continue;
          noteMedia(target, target.getAttribute(record.attributeName), 'attr:' + record.attributeName);
        }
      }),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      subtree: true,
      attributeFilter: ['src', 'poster'],
    });
  } catch (error) {
    warn('observer', error);
  }

  // ---------------------------------------------------------------- Overlay 面板

  function elementResources(element) {
    var found = [];
    var attributes = ['src', 'srcset', 'poster', 'href', 'data-src'];
    for (var i = 0; i < attributes.length; i += 1) {
      var value = element.getAttribute && element.getAttribute(attributes[i]);
      if (value) found.push({ label: attributes[i], value: value });
    }
    if (element.currentSrc) found.push({ label: 'currentSrc', value: element.currentSrc });

    try {
      var background = window.getComputedStyle(element).backgroundImage;
      if (background && background !== 'none') found.push({ label: 'background-image', value: background });
    } catch (error) {
      warn('computed-style', error);
    }
    try {
      var sources = element.querySelectorAll ? element.querySelectorAll('source') : [];
      for (var j = 0; j < sources.length; j += 1) {
        var sourceValue = sources[j].getAttribute('src') || sources[j].getAttribute('srcset');
        if (sourceValue) found.push({ label: '<source>', value: sourceValue });
      }
    } catch (error) {
      warn('sources', error);
    }
    return found;
  }

  function relatedRequests(element) {
    return state.requests.filter(function (entry) {
      return entry.triggerElement === element;
    });
  }

  var ui = null;

  function buildUi() {
    var host = document.createElement('div');
    // all: initial + shadow DOM 雙重隔離，避免被原站 CSS 汙染（規格 §7.1）。
    host.style.cssText = 'all: initial; position: fixed; inset: auto 16px 16px auto; z-index: 2147483647;';
    var shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

    var style = document.createElement('style');
    style.textContent =
      ':host{all:initial}' +
      '*{box-sizing:border-box;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}' +
      '.panel{width:min(460px,92vw);max-height:72vh;overflow:auto;background:#14161a;color:#e6e6e6;' +
      'border:1px solid #3a3f47;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.45)}' +
      '.head{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;' +
      'background:#1d2026;position:sticky;top:0}' +
      '.head strong{color:#9ad}' +
      'button{background:#2a2f37;color:#e6e6e6;border:1px solid #444b55;border-radius:4px;' +
      'padding:3px 8px;cursor:pointer}' +
      'button:hover{background:#343a44}' +
      'section{padding:8px 10px;border-top:1px solid #272b31}' +
      'h4{margin:0 0 6px;color:#8fb9d9;font-weight:600}' +
      '.row{word-break:break-all;margin:3px 0;padding-left:8px;border-left:2px solid #333}' +
      '.k{color:#7fb37f}.muted{color:#888}.warn{color:#d9a05b}' +
      '.toggle{position:fixed;right:16px;bottom:16px;z-index:2147483647}';
    shadow.appendChild(style);

    var panel = document.createElement('div');
    panel.className = 'panel';
    shadow.appendChild(panel);

    document.documentElement.appendChild(host);
    return { host: host, shadow: shadow, panel: panel };
  }

  function renderRows(items, renderer) {
    if (items.length === 0) return '<div class="muted">（無）</div>';
    return items.map(renderer).join('');
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"]/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char];
    });
  }

  function openPanel(element) {
    if (ui === null) ui = buildUi();
    ui.host.style.display = 'block';

    var resources = elementResources(element);
    var requests = relatedRequests(element);

    ui.panel.innerHTML =
      '<div class="head"><strong>LocalDevTool</strong>' +
      '<span class="muted">' + escapeHtml(describeElement(element)) + '</span>' +
      '<button data-ldt-close>關閉</button></div>' +
      '<section><h4>1. 這個元素本身的資源</h4>' +
      renderRows(resources, function (item) {
        return '<div class="row"><span class="k">' + escapeHtml(item.label) + '</span> ' +
          escapeHtml(item.value) + '</div>';
      }) +
      '</section>' +
      '<section><h4>2. 它觸發的請求（' + ASSOCIATION_WINDOW_MS + 'ms 時間窗內）</h4>' +
      renderRows(requests, function (item) {
        return '<div class="row"><span class="k">' + escapeHtml(item.method) + '</span> ' +
          escapeHtml(item.url) + ' <span class="muted">' +
          (item.status === null ? '進行中' : item.status) + '</span></div>';
      }) +
      '</section>' +
      '<section><h4>3. 追查：這個網址是誰給的？</h4>' +
      renderRows(resources.concat(requests.map(function (r) { return { label: r.method, value: r.url }; })),
        function (item) {
          return '<div class="row"><button data-ldt-trace="' + escapeHtml(item.value) + '">追這個</button> ' +
            '<span class="muted">' + escapeHtml(item.value.slice(0, 90)) + '</span></div>';
        }) +
      '<div data-ldt-result></div>' +
      '</section>' +
      '<section class="muted">面板只顯示摘要。完整的 header / body 要到 ' +
      '<span class="k">/admin/network</span>（需要 admin token）看 —— ' +
      '刻意不把 token 放進被代理的頁面。</section>';

    ui.panel.querySelector('[data-ldt-close]').addEventListener('click', function () {
      ui.host.style.display = 'none';
    });
    var traceButtons = ui.panel.querySelectorAll('[data-ldt-trace]');
    for (var i = 0; i < traceButtons.length; i += 1) {
      traceButtons[i].addEventListener('click', guard('trace-click', function (event) {
        runTrace(event.currentTarget.getAttribute('data-ldt-trace'));
      }));
    }
  }

  function runTrace(needle) {
    var box = ui.panel.querySelector('[data-ldt-result]');
    box.innerHTML = '<div class="muted">追查中…</div>';

    nativeFetch
      .call(window, TRACE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: needle, siteId: SITE_ID }),
      })
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        var confirmed = (data && data.confirmed) || [];
        var likely = (data && data.likely) || [];
        box.innerHTML =
          '<div class="row"><span class="k">已證實</span>（body 裡真的找到這個網址）' +
          renderRows(confirmed, function (item) {
            return '<div class="row">' + escapeHtml(item.method) + ' ' + escapeHtml(item.url) +
              ' <span class="muted">' + escapeHtml(item.authShape || '無授權跡象') + '</span></div>';
          }) + '</div>' +
          '<div class="row"><span class="warn">疑似</span>（只是時間相近，不是證據）' +
          renderRows(likely, function (item) {
            return '<div class="row">' + escapeHtml(item.method) + ' ' + escapeHtml(item.url) + '</div>';
          }) + '</div>';
      })
      ['catch'](function (error) {
        box.innerHTML = '<div class="warn">追查失敗：' + escapeHtml(error.message) + '</div>';
      });
  }

  // Alt + 點擊任何元素 → 開面板。選 Alt 是因為它最不容易跟原站的操作撞到。
  document.addEventListener(
    'click',
    guard('alt-click', function (event) {
      if (!event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      openPanel(event.target);
    }),
    true,
  );

  // 右鍵時記下元素，並顯示一顆小浮動按鈕（不搶原生選單）。
  document.addEventListener(
    'contextmenu',
    guard('contextmenu', function (event) {
      var target = event.target;
      if (ui === null) ui = buildUi();
      var toggle = ui.shadow.querySelector('.toggle');
      if (!toggle) {
        toggle = document.createElement('button');
        toggle.className = 'toggle';
        toggle.textContent = '🔍 LDT';
        ui.shadow.appendChild(toggle);
      }
      toggle.onclick = guard('toggle-click', function () {
        openPanel(target);
      });
    }),
    true,
  );

  window.addEventListener('pagehide', guard('pagehide', flush));
  window.addEventListener('beforeunload', guard('beforeunload', flush));

  window.__LDT__ = {
    version: '0.1.0',
    siteId: SITE_ID,
    state: state,
    open: guard('api-open', openPanel),
    flush: guard('api-flush', flush),
  };
})();
