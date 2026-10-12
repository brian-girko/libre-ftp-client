// index.mjs — page-level wiring.
//
// Drag events are swallowed globally: a file or directory dropped anywhere
// outside the local dir view would otherwise trigger the browser's default
// file-drop navigation (the tab "opens" the dropped entry and the client is
// gone). The local dir-view has its own drop listener, and element
// listeners run before the document-level one receives the event, so
// dropping a directory on the local pane still opens it — every drop
// beyond that (remote pane, toolbar, log, crumbs) is inert.

'use strict';

const eatDrag = (e) => e.preventDefault()
document.addEventListener('dragover', eatDrag)
document.addEventListener('drop', eatDrag)
