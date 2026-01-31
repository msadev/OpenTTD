/**
 * OpenTTD Web - Main Entry Point
 */

import { createModule, initFileSystem, setupWebSocket, setupGlobalFunctions, patchSocketFS } from './lib/emscripten-module.js';
import { audioManager } from './lib/audio-manager.js';

// WASM assets are served from /static folder via parcel-reporter-static-files-copy
const openttdJsUrl = '/openttd.js';
const openttdWasmUrl = '/openttd.wasm';
const openttdDataUrl = '/openttd.data';

// DOM Elements
const loadingScreen = document.getElementById('loading-screen');
const audioUnlockScreen = document.getElementById('audio-unlock-screen');
const errorScreen = document.getElementById('error-screen');
const canvas = document.getElementById('canvas');
const progressFill = document.getElementById('progress-fill');
const loadingStatus = document.getElementById('loading-status');
const loadingDetails = document.getElementById('loading-details');
const startButton = document.getElementById('start-button');
const fullscreenButton = document.getElementById('fullscreen-button');
const errorTitle = document.getElementById('error-title');
const errorMessage = document.getElementById('error-message');

let Module = null;

/**
 * Update the loading progress UI
 */
function updateProgress(current, total, status) {
  const percent = Math.min((current / total) * 100, 100);
  progressFill.style.width = `${percent}%`;
  loadingStatus.textContent = status;
  loadingDetails.textContent = `${Math.round(percent)}%`;
}

/**
 * Show a specific screen
 */
function showScreen(screen) {
  loadingScreen.classList.remove('active');
  audioUnlockScreen.classList.remove('active');
  errorScreen.classList.remove('active');

  if (screen) {
    screen.classList.add('active');
  }
}

/**
 * Show error screen
 */
function showError(title, message) {
  errorTitle.textContent = title;
  errorMessage.textContent = message;
  showScreen(errorScreen);
}

/**
 * Initialize and start the game
 */
async function startGame() {
  try {
    // Unlock audio
    await audioManager.unlock();

    // Hide screens, show canvas
    showScreen(null);
    canvas.focus();

    // Show fullscreen button
    fullscreenButton.classList.remove('hidden');

    console.log('[OpenTTD] Game started');
  } catch (e) {
    console.error('[OpenTTD] Failed to start game:', e);
    showError('Failed to Start', e.message);
  }
}

/**
 * Initialize the Emscripten module
 */
async function initModule() {
  updateProgress(0, 100, 'Initializing...');

  // Create module configuration
  Module = createModule({
    canvas,

    onProgress: (current, total, status) => {
      updateProgress(current, total, status);
    },

    onReady: () => {
      console.log('[OpenTTD] Module ready');
      updateProgress(100, 100, 'Ready!');

      // Show audio unlock screen
      showScreen(audioUnlockScreen);
    },

    onError: (error) => {
      console.error('[OpenTTD] Module error:', error);
      showError('Error', error.message);
    },

    onExit: () => {
      showScreen(null);
      document.body.innerHTML = `
        <div style="display:flex;justify-content:center;align-items:center;height:100vh;background:#1a1a2e;color:white;font-family:sans-serif;flex-direction:column;">
          <h1>Thanks for playing!</h1>
          <p>Reload the page to play again.</p>
          <button onclick="location.reload()" style="margin-top:20px;padding:10px 20px;font-size:16px;cursor:pointer;">Reload</button>
        </div>
      `;
    },

    locateFile: (path) => {
      // Map Emscripten file requests to our imported URLs
      if (path.endsWith('.wasm')) {
        return openttdWasmUrl;
      }
      if (path.endsWith('.data')) {
        return openttdDataUrl;
      }
      return path;
    }
  });

  // Setup filesystem
  initFileSystem(Module);

  // Setup WebSocket for networking
  setupWebSocket(Module);

  // Setup global functions
  setupGlobalFunctions(Module);

  // Patch SOCKFS
  patchSocketFS(Module);

  // Initialize audio early
  audioManager.init();

  return Module;
}

/**
 * Load the WASM module script
 */
async function loadWasmScript() {
  return new Promise((resolve, reject) => {
    updateProgress(10, 100, 'Loading WebAssembly...');

    const script = document.createElement('script');
    script.src = openttdJsUrl;
    script.async = true;

    script.onload = () => {
      updateProgress(30, 100, 'WebAssembly loaded');
      resolve();
    };

    script.onerror = () => {
      reject(new Error('Failed to load OpenTTD. Make sure openttd.js and openttd.wasm are in the dist folder.'));
    };

    document.body.appendChild(script);
  });
}

/**
 * Setup event listeners
 */
function setupEventListeners() {
  // Start button
  startButton.addEventListener('click', startGame);

  // Also allow clicking anywhere on audio unlock screen
  audioUnlockScreen.addEventListener('click', (e) => {
    if (e.target !== startButton) {
      startGame();
    }
  });

  // Fullscreen button
  fullscreenButton.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen();
    }
  });

  // Handle visibility change (pause audio when hidden)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      audioManager.suspend();
    } else {
      audioManager.resume();
    }
  });

  // Handle canvas resize
  window.addEventListener('resize', () => {
    if (Module && Module._emscripten_set_canvas_element_size) {
      Module._emscripten_set_canvas_element_size(
        '#canvas',
        window.innerWidth,
        window.innerHeight
      );
    }
  });

  // Prevent context menu on canvas
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // Handle keyboard events
  canvas.addEventListener('keydown', (e) => {
    // Prevent default for game keys
    if (['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
    }
  });
}

/**
 * Check browser compatibility
 */
function checkCompatibility() {
  const issues = [];

  if (!window.WebAssembly) {
    issues.push('WebAssembly is not supported');
  }

  if (!window.indexedDB) {
    issues.push('IndexedDB is not supported (saves may not persist)');
  }

  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) {
    issues.push('Web Audio API is not supported');
  }

  if (issues.length > 0) {
    console.warn('[OpenTTD] Compatibility issues:', issues);
  }

  return issues.length === 0 || window.WebAssembly; // Only block if no WASM
}

/**
 * Main entry point
 */
async function main() {
  console.log('[OpenTTD] Starting OpenTTD Web...');

  // Check compatibility
  if (!checkCompatibility()) {
    showError(
      'Browser Not Supported',
      'Your browser does not support WebAssembly. Please use a modern browser like Chrome, Firefox, Safari, or Edge.'
    );
    return;
  }

  setupEventListeners();

  try {
    // Initialize module first (sets up window.Module)
    await initModule();

    // Load the WASM script
    await loadWasmScript();
  } catch (e) {
    console.error('[OpenTTD] Failed to initialize:', e);
    showError('Initialization Failed', e.message);
  }
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
