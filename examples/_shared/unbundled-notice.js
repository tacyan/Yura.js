// Shown only when an example is opened WITHOUT the Bun bundler — double-
// clicking index.html (file://), or a plain static server / editor preview.
// Browsers can't run the TypeScript entry or resolve the bare 'yura' import
// on their own, so instead of a silent black screen the page explains how to
// open it. Detection needs no timers or globals: Bun (dev server and
// `bun build`) rewrites `<script src="./main.ts">` to a .js bundle, so an
// entry that still ends in .ts means nothing bundled this page.
;(function () {
  var TS_ENTRY = /\.tsx?(?:[?#].*)?$/

  function show() {
    var entry = Array.prototype.find.call(document.querySelectorAll('script[type="module"][src]'), function (s) {
      return TS_ENTRY.test(s.getAttribute('src') || '')
    })
    if (!entry) return // bundled — the example runs normally

    // The example folder, read from this page's own path (never hardcoded).
    var parts = decodeURIComponent(location.pathname).split('/').filter(Boolean)
    if (/\.html?$/i.test(parts[parts.length - 1] || '')) parts.pop()
    var dir = parts[parts.length - 1] || '<example>'
    var command = 'bun ./examples/' + dir + '/index.html'

    var box = document.createElement('div')
    box.setAttribute('role', 'alert')
    box.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px;' +
      'background:#07070c;color:#e2e8f0;font:14px/1.7 ui-sans-serif,system-ui,sans-serif'
    var card = document.createElement('div')
    card.style.cssText = 'max-width:560px;border:1px solid #1d2230;border-radius:12px;padding:24px 28px;background:#0d1019'
    var lines = [
      ['h', 'このページはビルドしてから開く必要があります'],
      ['p', 'examples は TypeScript と yura パッケージを使うため、index.html を直接開いたり、静的サーバーで配信しただけでは動きません。リポジトリのルートで次を実行し、表示された URL を開いてください。'],
      ['c', 'bun install\n' + command],
      ['p', 'This example must be served through Bun: run the commands above from the repository root, then open the printed URL.'],
    ]
    lines.forEach(function (l) {
      var el = document.createElement(l[0] === 'h' ? 'h2' : l[0] === 'c' ? 'pre' : 'p')
      el.textContent = l[1]
      if (l[0] === 'h') el.style.cssText = 'font-size:17px;margin:0 0 12px;color:#67e8f9'
      if (l[0] === 'p') el.style.cssText = 'margin:0 0 12px;color:#94a3b8'
      if (l[0] === 'c') el.style.cssText = 'margin:0 0 12px;padding:12px 14px;border-radius:8px;background:#05060a;color:#f0abfc;font:13px/1.6 ui-monospace,Menlo,monospace;white-space:pre-wrap'
      card.appendChild(el)
    })
    box.appendChild(card)
    document.body.appendChild(box)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show)
  else show()
})()
