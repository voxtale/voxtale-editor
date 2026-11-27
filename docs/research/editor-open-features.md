# Editor: open features

Date: 2026-11-27. What the editor still lacks or only partly has, after the
W22 merge (EditDoc v10, skill v30).

Sizes: S = a day or less, M = a few days, L = a week or more.

## Missing or partial

| Feature | Ours | Our file | Size | Worth it |
|---|---|---|---|---|
| Relink offline media: find a moved or renamed source (by hand or by name search), relink others from the same folder | Missing (`project.json` keeps absolute paths; a moved file breaks render; previews still play from proxies) | `src/video/editor/local-mcp/project.ts` | S | Yes. Footage on an external SSD moves often. `relink` tool + check at `resume` that lists missing files |
| Read briefs: PDF, Word, RTF, Excel, text to plain text for the agent | Missing (the host agent reads PDFs itself, not Word or Excel, and Codex reads none) | — | S | Yes. Cheap (`textutil` for doc/docx/rtf on Mac, `pdftotext`/PDFKit, unzip for xlsx); client briefs arrive as these. Text also costs fewer tokens than PDF pages |
| Reference vs ours side by side (still from the reference left, our render right) | Missing (`learn_style` makes contact sheets of the reference only) | `src/video/editor/styles/learn.ts` | S | Yes, when re-creating a reference look; cheap with `frames` |
| Measure motion in a reference (per-frame box and opacity, duration, overshoot, matching ease curve) | Missing (`analyse.py` measures cuts, zooms, flashes, captions, sound, look; not element motion) | `voxtale_native/analyse.py` | M | Maybe. Real numbers for title entrances instead of guesses; only for style learning |
| Folder watcher: a folder (OBS, camera card, Dropbox) gets new files → `open` runs (transcribe, labels, first cut) so the agent `resume`s ready work; nothing exported without the user | Missing | — | M | Partial fit: an MCP server cannot start an agent turn, but it can have the work ready |
| Windows platform layer (Trash, Terminal, file search; Parakeet on CPU) | Partial (README covers Windows install; no Windows-tested path) | `README.md` | M | Later; untested by us |

## Skipped: no fit for a local MCP with no app UI

- Dictation / voice input: the host app owns voice input.
- Style thumbnails for a style list: no list to show them in.
- Export folder picker: `render` takes an output path.
- Live reload when a disk is plugged or ejected: relink covers the real need.
- Remote access relay: our HTTP MCP is already the remote surface.
- Inspector UI for fixed effects: `list_scenes` lists scene props.

## Build order

1. A free test of Parakeet on our test clips for fillers and word timing.
2. Relink + missing-file check at `resume` (S).
3. Read briefs (S).
4. Then compare stills, motion measure, folder watcher, Windows layer.
