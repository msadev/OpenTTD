# OpenTTD Web

Port web d'OpenTTD utilisant Emscripten (WebAssembly) et Parcel.

## Prérequis

- Node.js 18+
- Docker (pour compiler le WASM)

## Installation

```bash
cd web
npm install
```

## Compilation du WASM

Le script de build utilise Docker pour compiler OpenTTD en WebAssembly :

```bash
npm run build:wasm
```

Cela va :
1. Construire l'image Docker avec Emscripten
2. Compiler les outils hôtes
3. Compiler OpenTTD en WASM
4. Copier les fichiers dans `src/`

## Développement

```bash
npm run dev
```

Ouvre http://localhost:3000

**Note** : Les fichiers WASM doivent être compilés d'abord (`npm run build:wasm`).

## Production

```bash
npm run build
```

Les fichiers sont générés dans `dist/`.

## Structure

```
web/
├── src/
│   ├── index.html      # Page principale
│   ├── main.js         # Point d'entrée JS
│   ├── styles/
│   │   └── main.css    # Styles
│   └── lib/
│       ├── emscripten-module.js  # Config Emscripten
│       ├── audio-manager.js      # Web Audio API
│       └── storage.js            # IndexedDB
├── scripts/
│   └── build-wasm.js   # Script de compilation WASM
├── public/
│   └── manifest.json   # PWA manifest
└── package.json
```

## Fonctionnalités

- WebGL pour le rendu
- Web Audio API pour le son
- IndexedDB pour les sauvegardes persistantes
- WebSocket pour le multijoueur
- Support plein écran
- Compatible mobile (tactile)
