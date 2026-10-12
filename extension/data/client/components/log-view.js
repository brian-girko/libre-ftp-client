// log-view.js — scrolling feed of fs activity (local and remote panes).
//
// fs/log-fs.js wraps every fs call with one log line and publishes it
// through fs/logs.js; this element subscribes and renders the lines as
// "hh:mm:ss [type:label] msg" rows, newest visible at the bottom,
// capped at MAX_LINES. Errors show red.

import {onFSLog, offFSLog} from '../fs/logs.js'

const MAX_LINES = 500

class LogView extends HTMLElement {
  connectedCallback() {
    this.rowCount = 0
    const label = document.createElement('span')
    label.className = 'lg-title'
    label.textContent = 'log'
    const clear = document.createElement('button')
    clear.textContent = 'Clear'
    clear.title = 'erase the log'
    clear.onclick = () => {
      this.rows.textContent = ''
      this.rowCount = 0
    }
    this.rows = document.createElement('div')
    this.rows.className = 'lg-rows'
    this.textContent = ''
    this.append(label, clear, this.rows)
    this.hook = (event) => {
      this.appendLine(event)
    }
    onFSLog(this.hook)
  }

  disconnectedCallback() {
    offFSLog(this.hook)
  }

  // one rendered line: time, source, message (red row for errors)
  appendLine(event) {
    const row = document.createElement('div')
    row.className = 'lg-row' + (event.error ? ' lg-error' : '')
    const time = document.createElement('span')
    time.className = 'lg-time'
    time.textContent = event.time.toTimeString().slice(0, 8)
    const tag = document.createElement('span')
    tag.className = 'lg-tag'
    tag.textContent = '[' + event.type + (event.label ? ':' + event.label : '') + ']'
    const msg = document.createElement('span')
    msg.className = 'lg-msg'
    msg.textContent = event.msg
    row.append(time, tag, msg)
    // keep the newest line in view only when the user has not scrolled up
    const nearBottom = this.rows.scrollHeight - this.rows.scrollTop <=
      this.rows.clientHeight + 20
    this.rows.appendChild(row)
    if (++this.rowCount > MAX_LINES) {
      this.rows.firstChild.remove()
      this.rowCount--
    }
    if (nearBottom) {
      this.rows.scrollTop = this.rows.scrollHeight
    }
  }
}

customElements.define('log-view', LogView)
