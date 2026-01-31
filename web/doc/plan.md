Plan de Portage OpenTTD vers Web/JS/WebGL
État actuel
OpenTTD dispose déjà de :

Support Emscripten dans CMakeLists.txt (lignes 362-414)
Fichiers web dans os/emscripten/ (pre.js, shell.html)
Architecture modulaire avec drivers abstraits
Support WebSocket pour le réseau
Phase 1 : Configuration Build Emscripten
Objectif : Compiler OpenTTD en WebAssembly

Installer Emscripten SDK (emsdk)
Configurer CMake pour Emscripten :

emcmake cmake -B build-web -S . -DCMAKE_BUILD_TYPE=Release
emmake make -C build-web
Résoudre les dépendances :
Compiler zlib, liblzma pour WASM
Désactiver FluidSynth (pas supporté)
Utiliser les ports Emscripten (SDL2, etc.)
Phase 2 : Driver Vidéo WebGL
Fichiers à créer/modifier : src/video/webgl_v.cpp, webgl_v.h

Créer VideoDriver_WebGL héritant de VideoDriver
Implémenter :
MainLoop() → utiliser emscripten_set_main_loop()
Paint() → rendu WebGL 2.0 (basé sur le backend OpenGL existant)
PollEvent() → événements canvas via callbacks Emscripten
Adapter les shaders GLSL pour WebGL 2.0 / OpenGL ES 3.0
Gérer le redimensionnement du canvas et le scaling DPI
Phase 3 : Driver Audio Web Audio API
Fichiers à créer : src/sound/webaudio_s.cpp, webaudio_s.h

Créer SoundDriver_WebAudio
Implémenter :
AudioWorklet ou ScriptProcessorNode pour le mixing
Intégration avec le mixer existant (MxMixSamples)
Gestion de l'autoplay (activation utilisateur requise)
Musique : Décoder Opus via Web Audio API ou désactiver MIDI
Phase 4 : Gestion des Entrées
Fichiers à modifier : os/emscripten/pre.js, driver vidéo

Événements clavier : emscripten_set_keydown_callback()
Événements souris : position, clics, scroll sur canvas
Support tactile : adapter pour mobile
Gamepad API (optionnel) : pour contrôleurs
Phase 5 : Système de Fichiers et Assets
Objectif : Charger les données de jeu

Preloading assets :
Baseset (graphiques, sons) via --preload-file
Fichiers de langue
Stockage persistant :
IDBFS pour sauvegardes (déjà configuré)
Synchronisation périodique (EM_ASM(FS.syncfs))
Téléchargement NewGRF :
Adapter le content downloader pour fetch API
Phase 6 : Réseau Multijoueur
Fichiers existants : os/emscripten/pre.js (lignes 35-127)

WebSocket proxy déjà implémenté pour TCP
Tester la connexion aux serveurs OpenTTD
Adapter si nécessaire pour CORS et certificats
Phase 7 : Optimisations Performance
Mémoire :
Augmenter INITIAL_MEMORY si nécessaire (32MB par défaut)
Activer ALLOW_MEMORY_GROWTH
Threading :
Mode mono-thread (is_game_threaded = false) ou
SharedArrayBuffer si disponible
Compression : Brotli pour les assets WASM
Lazy loading : Charger assets à la demande
Phase 8 : Interface Web et Distribution
Améliorer shell.html :
UI de chargement
Plein écran, contrôles audio
Gestion des erreurs
Progressive Web App (optionnel) :
Service Worker pour mode hors-ligne
Manifest pour installation
Hébergement :
Serveur avec headers CORS appropriés
Compression gzip/brotli
Défis Techniques Majeurs
Défi	Solution
Taille du WASM (~15-30MB)	Compression Brotli, streaming instantiation
Autoplay audio	Bouton "Activer le son" au démarrage
Performances mobiles	Mode graphique simplifié, throttling
Sauvegardes	IDBFS + export/import manuel
NewGRF téléchargement	Fetch API avec CORS proxy si nécessaire
Estimation de Complexité
Phase	Complexité	Dépendances
1. Build	Moyenne	Aucune
2. Vidéo WebGL	Élevée	Phase 1
3. Audio	Moyenne	Phase 1
4. Entrées	Faible	Phase 2
5. Fichiers	Moyenne	Phase 1
6. Réseau	Faible	Phase 1 (déjà fait)
7. Optimisation	Moyenne	Phases 2-6
8. Distribution	Faible	Phase 7