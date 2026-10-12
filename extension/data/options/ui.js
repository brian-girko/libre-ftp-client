// ui.js — small DOM builders shared by the options views. The field layout
// mirrors the connect dialog of the client: grey label left, input right.

// one labelled input row; the caller keeps the input (type, placeholder, ...)
function field(label, input) {
  input.className = 'op-input'
  const row = document.createElement('label')
  row.className = 'op-field'
  const span = document.createElement('span')
  span.className = 'op-label'
  span.textContent = label
  row.append(span, input)
  return row
}

// bold section heading
function title(text) {
  const el = document.createElement('div')
  el.className = 'op-section'
  el.textContent = text
  return el
}

// grey explanatory line below a heading
function note(text) {
  const el = document.createElement('div')
  el.className = 'op-note'
  el.textContent = text
  return el
}

// right aligned button row closing a form
function footer(...buttons) {
  const el = document.createElement('div')
  el.className = 'op-footer'
  el.append(...buttons)
  return el
}

// standalone button in the toolbar style
function button(text, onclick) {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'op-button'
  el.textContent = text
  el.onclick = onclick
  return el
}

// the status line below a form, created on demand — views rebuild their
// forms when the state changes, so it cannot be kept between renders
function statusLine(form) {
  let el = form.querySelector('.op-status')
  if (!el) {
    el = document.createElement('div')
    el.className = 'op-status'
    form.querySelector('.op-footer').before(el)
  }
  return el
}

// success message into the form's status line
function say(form, msg) {
  const el = statusLine(form)
  el.textContent = msg
  el.classList.remove('op-error')
}

// error message into the form's status line
function fail(form, msg) {
  const el = statusLine(form)
  el.textContent = msg
  el.classList.add('op-error')
}

// run fn with every button in the form disabled; an uncaught error lands in
// the status line instead of vanishing in the console. fn may rebuild the
// form (after a state change) — the finally re-enables the current buttons.
async function run(form, fn) {
  for (const b of form.querySelectorAll('button')) {
    b.disabled = true
  }
  try {
    await fn()
  }
  catch (e) {
    fail(form, e.message || String(e))
  }
  finally {
    for (const b of form.querySelectorAll('button')) {
      b.disabled = false
    }
  }
}

export {field, title, note, footer, button, statusLine, say, fail, run};
