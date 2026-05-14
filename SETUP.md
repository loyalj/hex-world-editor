# hex-world-editor — Project Setup

This is a map editor and generator app built on the `hex-world` library.
The library lives at `d:\Coding\hex-world` and is consumed via `npm link`.

---

## Prerequisites

`hex-world` must be built and registered before this project can install it.

```powershell
cd d:\Coding\hex-world
npm run build
npm link
```

---

## Scaffold this project

Run these commands from `d:\Coding\hex-world-editor\`:

```powershell
npm create vite@latest . -- --template vanilla-ts
npm install
npm install three @types/three
npm link hex-world
```

---

## Verify the link

Replace the contents of `src/main.ts` with:

```ts
import { HexMap, FbmPlugin } from 'hex-world';
const map = new HexMap({ width: 10, height: 10, featureLayerCount: 1 });
FbmPlugin.generate(map, FbmPlugin.defaultConfig, Date.now());
console.log('map ready', map.width, map.height);
```

Start the dev server (`npm run dev`) and confirm no import errors in the browser console.

---

## Ongoing workflow

- When `hex-world` changes, run `npm run build` there. The link picks up the new `dist/` automatically — no re-linking needed.
- Never `npm install three` inside `hex-world`. It is a peer dependency; the editor project owns the Three.js instance.

---

## What this project is

A browser-based tool for:
- Generating hex maps using the built-in generators (FbmPlugin, ChunkPlugin) or custom ones
- Editing terrain, elevation, rivers, and roads cell by cell
- Saving and loading maps via `serializeMap` / `deserializeMap` (binary `.hexmap` files) or `serializeMapJSON` / `deserializeMapJSON` (JSON clipboard)

Refer to `d:\Coding\hex-world\QUICKSTART.md` for the full library API reference.
