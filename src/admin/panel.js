/**
 * 流量面板的前端（規格 §9）。原生 JS，無 build step。
 * 認證靠 ldt_admin cookie（開 /admin/network?token=<t> 設一次）。
 */
'use strict';

var selected = [];
var rows = [];

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value).replace(
    /[&<>"]/g,
    function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char];
    },
  );
}

function statusClass(status) {
  if (!status) return 'muted';
  return 's' + String(status)[0];
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function api(path, options) {
  return fetch(path, options || {}).then(function (response) {
    if (response.status === 204) return null;
    return response.json().then(function (data) {
      if (!response.ok) throw new Error(data && data.error ? data.error : 'HTTP ' + response.status);
      return data;
    });
  });
}

function toIso(value) {
  if (!value) return '';
  var date = new Date(value);
  return isNaN(date.getTime()) ? '' : date.toISOString();
}

function currentFilters() {
  var params = new URLSearchParams();
  var map = {
    method: $('f-method').value,
    status: $('f-status').value,
    source: $('f-source').value,
    urlContains: $('f-url').value,
    contentType: $('f-ctype').value,
    sessionId: $('f-session').value,
    since: toIso($('f-since').value),
    until: toIso($('f-until').value),
  };
  Object.keys(map).forEach(function (key) {
    if (map[key]) params.set(key, map[key]);
  });
  params.set('limit', '300');
  return params.toString();
}

function renderRows(list) {
  rows = list;
  $('rows').innerHTML = list
    .map(function (row) {
      return (
        '<tr data-id="' + escapeHtml(row.id) + '">' +
        '<td title="' + escapeHtml(row.ts) + '">' +
        escapeHtml(new Date(row.ts).toLocaleTimeString()) + '</td>' +
        '<td>' + escapeHtml(row.method) + '</td>' +
        '<td title="' + escapeHtml(row.host) + '">' + escapeHtml(row.host) + '</td>' +
        '<td title="' + escapeHtml(row.path) + '">' + escapeHtml(row.path) + '</td>' +
        '<td class="' + statusClass(row.status) + '">' + escapeHtml(row.status) + '</td>' +
        '<td>' + escapeHtml(row.contentType) + '</td>' +
        '<td>' + escapeHtml(formatBytes(row.resBytes)) + '</td>' +
        '<td>' + escapeHtml(row.durationMs) + '</td>' +
        '<td><span class="src">' + escapeHtml(row.source) + '</span></td>' +
        '</tr>'
      );
    })
    .join('');

  Array.prototype.forEach.call($('rows').querySelectorAll('tr'), function (tr) {
    tr.addEventListener('click', function () {
      toggleSelection(tr);
      showDetail(tr.getAttribute('data-id'));
    });
  });
}

function toggleSelection(tr) {
  var id = tr.getAttribute('data-id');
  var index = selected.indexOf(id);
  if (index === -1) {
    selected.push(id);
    if (selected.length > 2) selected.shift();
  } else {
    selected.splice(index, 1);
  }
  Array.prototype.forEach.call($('rows').querySelectorAll('tr'), function (row) {
    row.classList.toggle('selected', selected.indexOf(row.getAttribute('data-id')) !== -1);
  });
}

function prettyBody(body, contentType) {
  if (body === null || body === undefined) {
    return '<p class="muted">（未擷取 —— binary 類型只記 metadata，不存 body）</p>';
  }
  var text = body;
  if (contentType && contentType.indexOf('json') !== -1) {
    try {
      text = JSON.stringify(JSON.parse(body), null, 2);
    } catch (error) {
      // 可能是被截斷的 JSON，原樣顯示即可。
      text = body;
    }
  }
  return '<pre>' + escapeHtml(text) + '</pre>';
}

function headerBlock(title, headers) {
  var entries = Object.keys(headers || {});
  if (entries.length === 0) return '';
  return (
    '<details><summary>' + escapeHtml(title) + '（' + entries.length + '）</summary><dl>' +
    entries
      .map(function (name) {
        var value = headers[name];
        return '<dt>' + escapeHtml(name) + '</dt><dd>' +
          escapeHtml(Array.isArray(value) ? value.join('\n') : value) + '</dd>';
      })
      .join('') +
    '</dl></details>'
  );
}

function showDetail(id) {
  api('/admin/api/requests/' + encodeURIComponent(id))
    .then(function (row) {
      var truncatedNote = row.bodyTruncated
        ? '<div class="warnbox">body 超過上限已被截斷（body_truncated=1）。</div>'
        : '';

      $('detail').innerHTML =
        '<h3>概要</h3><dl>' +
        '<dt>url</dt><dd>' + escapeHtml(row.url) + '</dd>' +
        '<dt>method</dt><dd>' + escapeHtml(row.method) + '</dd>' +
        '<dt>status</dt><dd>' + escapeHtml(row.status) + '</dd>' +
        '<dt>時間</dt><dd>' + escapeHtml(row.ts) + '</dd>' +
        '<dt title="Node 發出請求到取得回應標頭的時間，不是瀏覽器完整載入時間">上游回應</dt>' +
        '<dd>' + escapeHtml(row.durationMs) + ' ms</dd>' +
        '<dt>來源</dt><dd>' + escapeHtml(row.source) + '</dd>' +
        '<dt title="觀察到的授權形狀；憑證本身沒有被保存">auth_shape</dt><dd>' +
        escapeHtml(row.authShape || '（無授權跡象）') + '</dd>' +
        '<dt title="由注入的 inspector.js 產生，用來把元素操作與請求關聯起來">corr_id</dt>' +
        '<dd>' + escapeHtml(row.corrId || '') + '</dd>' +
        (row.replayOf ? '<dt>replay_of</dt><dd>' + escapeHtml(row.replayOf) + '</dd>' : '') +
        '</dl>' +
        truncatedNote +
        '<h3>Header</h3>' +
        headerBlock('請求 header', row.reqHeaders) +
        headerBlock('回應 header', row.resHeaders) +
        '<h3>請求 body</h3>' + prettyBody(row.reqBody, '') +
        '<h3>回應 body</h3>' + prettyBody(row.resBody, row.contentType) +
        '<h3>動作</h3>' +
        '<button id="do-trace">追查這個 URL 是誰給的</button> ' +
        '<button id="do-replay">重送這筆</button>' +
        '<div id="action-result"></div>';

      $('do-trace').addEventListener('click', function () {
        runTrace(row.url);
      });
      $('do-replay').addEventListener('click', function () {
        runReplay(row);
      });
    })
    .catch(function (error) {
      $('detail').innerHTML = '<div class="badbox">載入詳情失敗：' + escapeHtml(error.message) + '</div>';
    });
}

function renderEvidence(title, items, cssClass) {
  if (!items || items.length === 0) {
    return '<p class="muted">' + escapeHtml(title) + '：（無）</p>';
  }
  return (
    '<div class="' + cssClass + '"><strong>' + escapeHtml(title) + '</strong>' +
    items
      .map(function (item) {
        return '<div>' + escapeHtml(item.method) + ' ' + escapeHtml(item.url) +
          ' <span class="muted">' + escapeHtml(item.evidence) + '</span></div>';
      })
      .join('') +
    '</div>'
  );
}

function runTrace(url) {
  $('action-result').innerHTML = '<p class="muted">追查中…</p>';
  api('/admin/api/trace', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: url }),
  })
    .then(function (data) {
      $('action-result').innerHTML =
        renderEvidence('已證實（回應內容裡真的找到）', data.confirmed, 'okbox') +
        renderEvidence('疑似（只是時間相近，不是證據）', data.likely, 'warnbox') +
        '<p class="muted">試過的搜尋片段：' + escapeHtml((data.needlesTried || []).join(' / ')) + '</p>';
    })
    .catch(function (error) {
      $('action-result').innerHTML = '<div class="badbox">追查失敗：' + escapeHtml(error.message) + '</div>';
    });
}

function hasRedactedCredentials(row) {
  var headers = row.reqHeaders || {};
  return Object.keys(headers).some(function (name) {
    return headers[name] === '[REDACTED]';
  });
}

function runReplay(row) {
  var isSafe = row.method === 'GET' || row.method === 'HEAD';
  var notes = [];

  if (!isSafe) {
    notes.push('這是 ' + row.method + ' 請求 —— 重送可能在目標網站產生真實副作用（重複下單、重複發文）。');
  }
  if (hasRedactedCredentials(row)) {
    notes.push('此請求的憑證已遮蔽，值已經不在資料庫裡 —— replay 會以未授權狀態送出，目標很可能回 401/403。');
  }

  if (notes.length > 0 && !window.confirm(notes.join('\n\n') + '\n\n確定要送出嗎？')) {
    $('action-result').innerHTML = '<p class="muted">已取消。</p>';
    return;
  }

  $('action-result').innerHTML = '<p class="muted">重送中…</p>';
  api('/admin/api/replay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: row.id, confirm: true }),
  })
    .then(function (data) {
      $('action-result').innerHTML =
        '<div class="okbox">重送完成：status ' + escapeHtml(data.status) +
        '，新紀錄 ' + escapeHtml(data.requestId) + '</div>' +
        (data.warnings || [])
          .map(function (warning) {
            return '<div class="warnbox">' + escapeHtml(warning) + '</div>';
          })
          .join('');
      load();
    })
    .catch(function (error) {
      $('action-result').innerHTML = '<div class="badbox">重送失敗：' + escapeHtml(error.message) + '</div>';
    });
}

function runCompare() {
  if (selected.length !== 2) {
    window.alert('請先點選兩筆紀錄（點一下選取，再點一下取消）。');
    return;
  }
  api('/admin/api/compare?a=' + encodeURIComponent(selected[0]) + '&b=' + encodeURIComponent(selected[1]))
    .then(function (data) {
      var warning = data.sameUrl
        ? ''
        : '<div class="warnbox">這兩筆的 URL 不同，diff 的意義有限。</div>';
      $('detail').innerHTML =
        '<h3>比較</h3>' + warning +
        '<dl><dt>A</dt><dd>' + escapeHtml(data.a.ts) + ' ' + escapeHtml(data.a.url) + '</dd>' +
        '<dt>B</dt><dd>' + escapeHtml(data.b.ts) + ' ' + escapeHtml(data.b.url) + '</dd></dl>' +
        '<pre>' +
        data.diff
          .map(function (part) {
            var marker = part.type === 'add' ? '+' : part.type === 'del' ? '-' : ' ';
            return '<span class="diff-' + part.type + '">' + escapeHtml(marker + part.text) + '</span>';
          })
          .join('\n') +
        '</pre>';
    })
    .catch(function (error) {
      $('detail').innerHTML = '<div class="badbox">比較失敗：' + escapeHtml(error.message) + '</div>';
    });
}

function load() {
  api('/admin/api/requests?' + currentFilters())
    .then(function (data) {
      renderRows(data.rows);
      $('count').textContent = '共 ' + data.total + ' 筆，顯示 ' + data.rows.length + ' 筆';
    })
    .catch(function (error) {
      $('count').textContent = '載入失敗：' + error.message;
    });
}

function runSearch() {
  var query = $('q').value;
  if (!query) {
    load();
    return;
  }
  api('/admin/api/search?q=' + encodeURIComponent(query))
    .then(function (data) {
      renderRows(data.rows);
      $('count').textContent =
        '搜尋「' + query + '」命中 ' + data.rows.length + ' 筆' +
        (data.ftsAvailable ? '（FTS5）' : '（LIKE 退路）');
    })
    .catch(function (error) {
      $('count').textContent = '搜尋失敗：' + error.message;
    });
}

function loadSessions() {
  api('/admin/api/sessions')
    .then(function (data) {
      data.rows.forEach(function (session) {
        var option = document.createElement('option');
        option.value = session.id;
        option.textContent = (session.label || session.id) + ' — ' + session.started_at;
        $('f-session').appendChild(option);
      });
    })
    .catch(function () {
      /* session 是選用功能，載不到不影響主要流程 */
    });
}

$('apply').addEventListener('click', load);
$('search').addEventListener('click', runSearch);
$('compare').addEventListener('click', runCompare);
$('q').addEventListener('keydown', function (event) {
  if (event.key === 'Enter') runSearch();
});

api('/admin/api/search?q=')
  .then(function (data) {
    $('fts-state').textContent = data.ftsAvailable ? 'FTS5 可用' : 'FTS5 不可用，搜尋走 LIKE';
  })
  .catch(function () {
    $('fts-state').textContent = '';
  });

loadSessions();
load();
