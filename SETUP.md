# hex-world-editor — Project Setup

This is a map editor and generator app built on the `@loyalj/hex-world` library
(published on npm).

```powershell
npm install
npm run dev
```

That's it — the published library comes down with `npm install` like any other
dependency.

---

## Developing against library HEAD (optional)

If the library repo is cloned as a **sibling directory** (`../hex-world`), the
editor automatically consumes the library's *source* instead of the npm package:

- `vite.config.ts` aliases `@loyalj/hex-world` → `../hex-world/src/index.ts`
  when that path exists. Library edits hot-reload in the editor instantly — no
  library build step needed.
- `tsconfig.json` has a matching `paths` entry, so typechecking also runs
  against library HEAD (the editor doubles as the library's integration test).

Both fall back to the installed npm package when the sibling repo is absent, so
nothing in `package.json` changes and fresh clones just work.

The dev server prints `[hex-world-editor] using local library source` on
startup when the alias is active.

---

## Ongoing workflow

- Never `npm install three` inside `hex-world`. It is a peer dependency; the
  editor project owns the Three.js instance (`resolve.dedupe` in
  `vite.config.ts` enforces a single copy).
- When publishing a new library version, bump the `@loyalj/hex-world` range in
  `package.json` so cloners without the sibling repo get the same version the
  editor was developed against.

---

## What this project is

A browser-based tool for:
- Generating hex maps using the built-in generators (FbmPlugin, ChunkPlugin) or custom ones
- Editing terrain, elevation, rivers, and roads cell by cell
- Saving and loading maps via `serializeMap` / `deserializeMap` (binary `.hexmap` files) or `serializeMapJSON` / `deserializeMapJSON` (JSON clipboard)

Refer to `d:\Coding\hex-world\QUICKSTART.md` for the full library API reference.
