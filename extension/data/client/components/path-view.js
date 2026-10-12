// path-view.js — breadcrumb bar synced to a sibling dir-view pane.
//
// Sits in the .pathbar row above one <dir-view> (same .pane wrapper) and
// follows it via the pane's bubbled "pathchange" events (fired on every
// rendered state change: connect, navigate, detach, error). Every crumb
// except the current segment navigates the pane via goto(); the bar stays
// empty (and CSS-hidden) whenever the pane has no attached fs.

class PathView extends HTMLElement {
  connectedCallback() {
    // the pane may still be an unupgraded element when events first fly;
    // match by identity, the sibling is only needed for crumb navigation
    const pane = this.closest('.pane')
    if (!pane) {
      return // no pane to mirror
    }
    pane.addEventListener('pathchange', (e) => {
      if (this.sibling() === e.target) {
        this.render(e.detail)
      }
    })
  }

  // the pane this bar mirrors: the <dir-view> sharing the same .pane
  sibling() {
    const pane = this.closest('.pane')
    return pane ? pane.querySelector('dir-view') : null
  }

  // rebuild the crumbs from one pathchange event; detail carries the
  // pane's cwd ("" at the root) and its fs label ("" when detached)
  render(detail) {
    this.textContent = ''
    const label = String(detail.label || '')
    if (!label) {
      return // detached: stay empty so CSS keeps the bar hidden
    }
    const pane = this.sibling()
    const parts = String(detail.path || '').split('/').filter(Boolean)
    this.crumb(pane, label, '', parts.length === 0)
    for (let i = 0; i < parts.length; i++) {
      this.crumb(pane, parts[i], parts.slice(0, i + 1).join('/'),
        i === parts.length - 1)
    }
    // keep the current segment in view on long paths
    this.scrollLeft = this.scrollWidth
  }

  // one crumb; every but the current segment jumps to its target path
  crumb(pane, name, target, current) {
    if (this.children.length) {
      const sep = document.createElement('span')
      sep.className = 'pv-sep'
      sep.textContent = '/'
      this.appendChild(sep)
    }
    const span = document.createElement('span')
    span.className = 'pv-crumb' + (current ? ' pv-current' : '')
    if (!current) {
      span.onclick = () => {
        if (pane) {
          pane.goto(target)
        }
      }
    }
    span.textContent = name
    this.appendChild(span)
  }
}

customElements.define('path-view', PathView)
