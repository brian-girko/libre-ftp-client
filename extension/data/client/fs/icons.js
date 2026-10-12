// icons.js — file/folder icon resolution.
//
// The SVGs live in ../icons (document-relative "icons/..." since dir-view
// renders plain <img> tags into index.html). They are vendored from
// vscode-material-icon-theme (MIT), pinned commit dd1547b — see
// ../icons/README.md.

const EXTENSIONS = new Map([
  // markup / styles / data
  ['html', 'html'], ['htm', 'html'], ['xhtml', 'html'],
  ['css', 'css'], ['scss', 'sass'], ['sass', 'sass'], ['less', 'less'],
  ['json', 'json'], ['jsonc', 'json'], ['json5', 'json'],
  ['xml', 'xml'], ['yml', 'yaml'], ['yaml', 'yaml'],
  ['toml', 'document'], ['ini', 'document'], ['cfg', 'document'],
  ['conf', 'document'], ['env', 'document'],
  ['md', 'markdown'], ['markdown', 'markdown'], ['rst', 'markdown'],
  ['txt', 'document'], ['log', 'log'], ['csv', 'table'], ['tsv', 'table'],
  ['sql', 'database'], ['pdf', 'pdf'],
  // languages
  ['js', 'javascript'], ['mjs', 'javascript'], ['cjs', 'javascript'],
  ['jsx', 'react'], ['ts', 'typescript'], ['tsx', 'react'],
  ['py', 'python'], ['rb', 'ruby'], ['php', 'php'], ['java', 'java'],
  ['c', 'c'], ['h', 'c'],
  ['cpp', 'cpp'], ['cc', 'cpp'], ['cxx', 'cpp'], ['hpp', 'cpp'],
  ['hh', 'cpp'],
  ['cs', 'csharp'], ['go', 'go'], ['rs', 'rust'], ['swift', 'swift'],
  ['kt', 'kotlin'], ['kts', 'kotlin'], ['vue', 'vue'],
  ['sh', 'console'], ['bash', 'console'], ['zsh', 'console'],
  ['ps1', 'powershell'], ['psm1', 'powershell'],
  // media / archives / fonts / binaries
  ['png', 'image'], ['jpg', 'image'], ['jpeg', 'image'], ['gif', 'image'],
  ['bmp', 'image'], ['ico', 'image'], ['webp', 'image'], ['svg', 'image'],
  ['zip', 'zip'], ['tar', 'zip'], ['gz', 'zip'], ['bz2', 'zip'],
  ['xz', 'zip'], ['7z', 'zip'], ['rar', 'zip'],
  ['mp3', 'audio'], ['wav', 'audio'], ['flac', 'audio'], ['ogg', 'audio'],
  ['m4a', 'audio'],
  ['mp4', 'video'], ['mkv', 'video'], ['avi', 'video'], ['webm', 'video'],
  ['mov', 'video'],
  ['ttf', 'font'], ['otf', 'font'], ['woff', 'font'], ['woff2', 'font'],
  ['eot', 'font'],
  ['exe', 'exe'], ['dll', 'exe'], ['bin', 'exe'], ['iso', 'exe'],
  ['dmg', 'exe']
])

// whole-file names (lowercase) whose "extension" is not meaningful
const FILENAMES = new Map([
  ['dockerfile', 'docker'],
  ['makefile', 'makefile'],
  ['.gitignore', 'git'],
  ['.gitattributes', 'git'],
  ['.env', 'document'],
  ['license', 'document'],
  ['readme', 'markdown']
])

const ICONS_DIR = 'icons/'

// -> document-relative url of the 16x16 icon for a listing entry
export function iconPath(name, type) {
  if (type === 'dir') {
    return ICONS_DIR + 'folder.svg'
  }
  const lower = String(name).toLowerCase()
  const byName = FILENAMES.get(lower)
  if (byName) {
    return ICONS_DIR + byName + '.svg'
  }
  const dot = lower.lastIndexOf('.')
  const ext = dot > 0 ? lower.slice(dot + 1) : ''
  return ICONS_DIR + (EXTENSIONS.get(ext) || 'file') + '.svg'
}

// open-folder variant, used for the ".." row
export function parentIconPath() {
  return ICONS_DIR + 'folder-open.svg'
}
