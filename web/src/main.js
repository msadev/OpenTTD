/**
 * OpenTTD Web - Main Entry Point
 */

import { createModule, initFileSystem, setupWebSocket, setupGlobalFunctions, patchSocketFS } from './lib/emscripten-module.js';
import { audioManager } from './lib/audio-manager.js';
import { setupMusicGlobals } from './lib/midi-player.js';

// Configure WebSocket proxy for multiplayer support
// Change this to your proxy server URL for production
window.openttd_websocket_proxy = 'wss://openwebports.org/ports/openttd/proxy';

// WASM assets are served next to index.html (dist root). Use relative paths
// so it works under sub-paths like /ports/openttd/dist without hardcoding.
const openttdJsUrl = './openttd.js';
const openttdWasmUrl = './openttd.wasm';
const openttdDataUrl = './openttd.data';

// DOM Elements
const loadingScreen = document.getElementById('loading-screen');
const errorScreen = document.getElementById('error-screen');
const canvas = document.getElementById('canvas');
const progressFill = document.getElementById('progress-fill');
const loadingStatus = document.getElementById('loading-status');
const loadingDetails = document.getElementById('loading-details');
const progressSection = document.getElementById('progress-section');
const startSection = document.getElementById('start-section');
const startButton = document.getElementById('start-button');
const errorTitle = document.getElementById('error-title');
const errorMessage = document.getElementById('error-message');
const legalModal = document.getElementById('legal-modal');
const legalLink = document.getElementById('legal-link');
const legalClose = document.getElementById('legal-close');
const legalOk = document.getElementById('legal-ok');

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
  errorScreen.classList.remove('active');

  if (screen) {
    screen.classList.add('active');
  }
}

/**
 * Show the start button (hides progress bar)
 */
function showStartButton() {
  progressSection.classList.add('hidden');
  startSection.classList.remove('hidden');
}

/**
 * Show the progress bar (hides start button)
 */
function showProgressBar() {
  startSection.classList.add('hidden');
  progressSection.classList.remove('hidden');
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
 * Called when user clicks Start Game - unlocks audio and loads WASM
 */
async function onStartClick() {
  try {
    // Unlock audio (user interaction)
    await audioManager.unlock();

    // Show progress bar, hide start button
    showProgressBar();

    // Initialize audio
    audioManager.init();

    // Setup MIDI music player globals
    setupMusicGlobals();

    // Initialize module (sets up window.Module)
    await initModule();

    // Load the WASM script
    await loadWasmScript();
  } catch (e) {
    console.error('[OpenTTD] Failed to start game:', e);
    showError('Failed to Start', e.message);
  }
}

/**
 * Called when WASM is ready - show the game canvas
 */
function showGame() {
  // Hide screens, show canvas
  showScreen(null);
  canvas.focus();
  console.log('[OpenTTD] Game started');
}

/**
 * Initialize the Emscripten module
 */
async function initModule() {
  // Create module configuration
  Module = createModule({
    canvas,

    onProgress: (current, total, status) => {
      // Skip "Running" status to keep progress at 100%
      if (status === 'Running' || (current === 0 && total === 0)) {
        return;
      }
      updateProgress(current, total, status);
    },

    onReady: () => {
      console.log('[OpenTTD] Module ready');
      updateProgress(100, 100, 'Ready!');

      // Show the game canvas
      showGame();
    },

    onError: (error) => {
      console.error('[OpenTTD] Module error:', error);
      showError('Error', error.message);
    },

    onExit: () => {
      // Simply reload the page to restart the game
      location.reload();
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
  // Start button - triggers WASM loading
  startButton.addEventListener('click', onStartClick);

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

  // Legal modal
  if (legalLink) {
    legalLink.addEventListener('click', (e) => {
      e.preventDefault();
      legalModal.classList.remove('hidden');
    });
  }

  const closeLegalModal = () => {
    legalModal.classList.add('hidden');
  };

  if (legalClose) {
    legalClose.addEventListener('click', closeLegalModal);
  }

  if (legalOk) {
    legalOk.addEventListener('click', closeLegalModal);
  }

  // Close modal when clicking backdrop
  legalModal?.querySelector('.modal-backdrop')?.addEventListener('click', closeLegalModal);

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

  // Show start button and wait for user click
  // WASM loading will be triggered by onStartClick
  showStartButton();
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
