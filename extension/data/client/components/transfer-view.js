// transfer-view.js — the bottom panel holding the file transfers, styled
// after FileZilla: a tab strip (Queued files / Failed transfers /
// Successful transfers — empty tabs hidden) over the rows of the current
// tab. Live rows show name, byte counter, a progress bar with percent
// and, while it can still be stopped, a Cancel button wired to the
// queue's Transfer.cancel(); once a transfer settles it shrinks to name
// and bytes (a failed one keeps the red error text). The queue itself
// runs in fs/transfers.js; this component only paints it. The panel
// stays hidden until the first transfer is queued, like the real client.

import {transfers, onTransfer, fmtBytes} from '../fs/transfers.js'

const TABS = [
  {id: 'queued', label: 'Queued files'},
  {id: 'failed', label: 'Failed transfers'},
  {id: 'done', label: 'Successful transfers'}
]

function statusText(t) {
  if (t.state === 'queued') {
    return 'queued'
  }
  if (t.state === 'running') {
    return t.kind === 'upload' ? 'uploading' : 'downloading'
  }
  if (t.state === 'failed') {
    return t.error || 'failed'
  }
  return '' // done: paints nothing — the row is just name + bytes
}

// "bytes / total" counter shared by live refills and settled rows
function sizeText(t) {
  return fmtBytes(t.transferred) +
    (t.size !== undefined ? ' / ' + fmtBytes(t.size) : '')
}

class TransferView extends HTMLElement {
  connectedCallback() {
    this.tab = 'queued'
    this.rows = new Map() // transfer id -> {fill, pct, size} live refs
    this.hidden = true // stays away until the first transfer is queued
    onTransfer((item, kind) => this.sync(item, kind))
  }

  // transfers shown per tab: queued/running live under "Queued files",
  // then settle into Failed/Successful exactly like FileZilla
  visible(tab) {
    return transfers.items.filter((t) =>
      tab === 'queued' ? t.state === 'queued' || t.state === 'running'
      : tab === 'failed' ? t.state === 'failed'
      : t.state === 'done')
  }

  // keep the active tab useful: when it empties, jump to a non-empty one;
  // when nothing qualifies, the caller hides the whole panel
  pickTab() {
    if (this.visible(this.tab).length) {
      return
    }
    for (const {id} of TABS) {
      if (id !== this.tab && this.visible(id).length) {
        this.tab = id
        return
      }
    }
    this.hidden = true
  }

  // queue notifications: progress events repaint the live row refs in
  // place, anything structural (added/steady-state change) rebuilds
  sync(item, kind) {
    if (kind === 'progress') {
      const refs = this.rows.get(item.id)
      if (refs) {
        this.refill(refs, item)
      }
      return
    }
    this.hidden = !transfers.items.length
    if (this.hidden) {
      return
    }
    this.pickTab()
    this.render()
  }

  refill(refs, t) {
    const pct = t.size ? Math.min(100, Math.round(t.transferred / t.size * 100)) : 0
    refs.fill.style.width = pct + '%'
    refs.pct.textContent = t.size ? pct + '%' : ''
    refs.size.textContent = sizeText(t)
  }

  // settled rows skip the live columns: fill the byte counter and, for
  // failures, carry the red error text as the row's tail column
  decorate(row, size, t) {
    size.textContent = sizeText(t)
    if (t.state === 'failed') {
      const status = document.createElement('span')
      status.className = 'tf-status'
      status.textContent = statusText(t)
      row.appendChild(status)
    }
  }

  // one transfer row: name | bytes, then (live rows only) progress bar |
  // percent | status (+ Cancel) — settled transfers shrink to the file
  // name and its byte counter
  row(t) {
    const row = document.createElement('div')
    row.className = 'tf-row'
    if (t.state === 'done') {
      row.classList.add('tf-done')
    }
    if (t.state === 'failed') {
      row.classList.add('tf-failed')
    }
    const name = document.createElement('span')
    name.className = 'tf-name'
    name.textContent = t.name
    if (t.from || t.to) {
      name.title = t.from + ' -> ' + t.to
    }
    const size = document.createElement('span')
    size.className = 'tf-size'
    row.append(name, size)
    const settled = t.state === 'done' || t.state === 'failed'
    if (settled) {
      this.decorate(row, size, t)
      return row
    }
    const bar = document.createElement('div')
    bar.className = 'tf-bar'
    const fill = document.createElement('div')
    fill.className = 'tf-fill'
    bar.appendChild(fill)
    const pct = document.createElement('span')
    pct.className = 'tf-pct'
    const status = document.createElement('span')
    status.className = 'tf-status'
    status.textContent = statusText(t)
    row.append(bar, pct, status)
    if (t.state === 'queued' || t.state === 'running') {
      const cancel = document.createElement('button')
      cancel.className = 'tf-cancel'
      cancel.textContent = 'Cancel'
      cancel.title = 'abort this transfer'
      cancel.onclick = () => t.cancel()
      row.appendChild(cancel)
    }
    const refs = {fill, pct, size}
    this.rows.set(t.id, refs)
    this.refill(refs, t)
    return row
  }

  render() {
    this.textContent = ''
    this.rows.clear()
    // tab strip: Queued stays put, Failed/Successful hidden while empty
    const tabs = document.createElement('div')
    tabs.className = 'tf-tabs'
    for (const {id, label} of TABS) {
      const tab = document.createElement('button')
      tab.className = 'tf-tab' + (this.tab === id ? ' tf-tab-on' : '')
      tab.textContent = label
      tab.hidden = id !== 'queued' && !this.visible(id).length
      tab.onclick = () => {
        this.tab = id
        this.render()
      }
      tabs.appendChild(tab)
    }
    this.appendChild(tabs)
    const list = document.createElement('div')
    list.className = 'tf-list'
    for (const t of this.visible(this.tab)) {
      list.appendChild(this.row(t))
    }
    this.appendChild(list)
  }
}

customElements.define('transfer-view', TransferView)
