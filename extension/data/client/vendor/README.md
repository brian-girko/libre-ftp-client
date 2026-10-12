# codemirror.mjs — vendored CodeMirror 6 bundle

`codemirror.mjs` is a single-file ES bundle built from the npm packages
below so the client (and the `editor-view` component) can highlight code
completely offline: no CDN, no runtime eval, fine under the MV3 page CSP.

Included languages (curated): JavaScript/TypeScript/JSX, JSON, HTML, CSS,
Python, Markdown, XML, plus stream parsers for YAML, shell, TOML and
ini/properties. Files without a curated parser open as plain text.

## Rebuild

From any scratch directory:

```
npm init -y
npm install codemirror @codemirror/state @codemirror/language \
  @codemirror/legacy-modes \
  @codemirror/lang-javascript @codemirror/lang-json \
  @codemirror/lang-html @codemirror/lang-css \
  @codemirror/lang-python @codemirror/lang-markdown \
  @codemirror/lang-xml esbuild
```

Then copy this repo's `vendor-entry.mjs` snippet (the export list below)
into the scratch dir as `entry.mjs` and build:

```
npx esbuild entry.mjs --bundle --minify --format=esm \
  --target=es2020 --outfile=codemirror.mjs
```

Copy the result over this directory's `codemirror.mjs`.

## Exports

The bundle re-exports exactly what editor-view.js imports:

- `EditorView`, `keymap` (from @codemirror/view)
- `EditorState` (from @codemirror/state)
- `basicSetup` (from codemirror)
- `StreamLanguage` (from @codemirror/language)
- `javascript`, `json`, `html`, `css`, `python`, `markdown`, `xml`
  (from the @codemirror/lang-* packages)
- `yaml`, `shell`, `toml`, `properties`
  (stream parsers from @codemirror/legacy-modes)
