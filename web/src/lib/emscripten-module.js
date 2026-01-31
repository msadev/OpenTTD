/**
 * OpenTTD Emscripten Module Configuration
 * Handles WASM loading and Emscripten runtime setup
 */

/**
 * Creates and configures the Emscripten Module object
 * @param {Object} config
 * @param {HTMLCanvasElement} config.canvas
 * @param {Function} [config.onProgress]
 * @param {Function} [config.onReady]
 * @param {Function} [config.onError]
 * @param {Function} [config.onExit]
 * @param {Function} [config.locateFile]
 */
export function createModule(config) {
  const { canvas, onProgress, onReady, onError, onExit, locateFile } = config;

  let totalDependencies = 42;
  let doneDependencies = 0;
  let lastDependencies = 1;

  const Module = {
    canvas,
    arguments: ['-memscripten', '-vsdl'],
    preRun: [],
    postRun: [],

    print(text) {
      console.log('[OpenTTD]', text);
    },

    printErr(text) {
      // Filter out harmless warnings that don't affect functionality
      if (text.includes('reuse-port mode failed')) return;
      console.error('[OpenTTD Error]', text);
    },

    locateFile: locateFile || ((path) => path),

    setStatus(text) {
      if (!text) return;

      // Parse Emscripten status format: "Message (current/total)"
      const match = text.match(/^([^(]+)\((\d+(\.\d+)?)\/(\d+)\)$/);
      if (match) {
        const current = parseFloat(match[2]);
        const total = parseFloat(match[4]);
        onProgress?.(current, total, match[1].trim());
      } else {
        onProgress?.(0, 100, text);
      }
    },

    monitorRunDependencies(left) {
      if (left < lastDependencies) {
        doneDependencies += 1;
      }
      lastDependencies = left;

      const doing = Math.min(doneDependencies + 1, totalDependencies);
      onProgress?.(doing, totalDependencies, 'Loading dependencies...');
    },

    onRuntimeInitialized() {
      console.log('[OpenTTD] Runtime initialized');
      onReady?.();
    },

    // OpenTTD-specific callbacks
    onBootstrap(current, total) {
      onProgress?.(current, total, 'Downloading base graphics...');
    },

    onBootstrapFailed() {
      onError?.(new Error('Failed to download base graphics. Check your internet connection.'));
    },

    onBootstrapReload() {
      onProgress?.(100, 100, 'Base graphics downloaded. Reloading...');
      setTimeout(() => location.reload(), 1000);
    },

    onExit() {
      console.log('[OpenTTD] Game exited');
      onExit?.();
    },

    onAbort() {
      onError?.(new Error('The game crashed unexpectedly.'));
    },

    onWarningFs() {
      console.warn('[OpenTTD] Savegames are stored in browser IndexedDB and may be deleted by the browser.');
    },

    // WebSocket configuration must be set up here, before openttd.js loads
    // Emscripten's SOCKFS expects Module.websocket.on to be a function
    websocket: createWebSocketConfig()
  };

  // Attach to window for Emscripten's internal use
  window.Module = Module;

  return Module;
}

/**
 * Creates WebSocket configuration object
 * Must be available before Emscripten initializes SOCKFS
 *
 * IMPORTANT: The OpenTTD pre.js patches SOCKFS to call Module.websocket.url
 * as a FUNCTION, not use it as a string. See os/emscripten/pre.js lines 117-125.
 */
function createWebSocketConfig() {
  return {
    // URL must be a function that returns the WebSocket URL for a given connection
    url(host, port, proto) {
      // OpenTTD content service
      if (host === 'content.openttd.org' && port === 3978 && proto === 'tcp') {
        return 'wss://bananas-server.openttd.org/';
      }

      // Force secure WebSocket over HTTPS
      if (location.protocol === 'https:') {
        return 'wss://';
      }

      // Default: let Emscripten handle it
      return null;
    }
  };
}

/**
 * Initializes the filesystem with IDBFS for persistent storage
 * @param {Object} Module
 * @deprecated Filesystem initialization is already done in os/emscripten/pre.js
 */
export function initFileSystem(Module) {
  // No-op: Filesystem setup (mkdir, IDBFS mount, syncfs) is already handled
  // by pre.js which is compiled into openttd.js
  // See os/emscripten/pre.js lines 23-49
}

/**
 * Sets up WebSocket URL resolver for network play
 * @param {Object} Module
 * @deprecated WebSocket config is now handled in createWebSocketConfig()
 */
export function setupWebSocket(Module) {
  // No-op: WebSocket URL resolver is now in createWebSocketConfig()
  // This function is kept for backwards compatibility with main.js
}

/**
 * Sets up global OpenTTD functions expected by the WASM module
 * @param {Object} Module
 */
export function setupGlobalFunctions(Module) {
  window.openttd_exit = () => {
    window.openttd_syncfs(() => Module.onExit?.());
  };

  window.openttd_abort = () => {
    window.openttd_syncfs(() => Module.onAbort?.());
  };

  window.openttd_bootstrap = (current, total) => {
    Module.onBootstrap?.(current, total);
  };

  window.openttd_bootstrap_failed = () => {
    Module.onBootstrapFailed?.();
  };

  window.openttd_bootstrap_reload = () => {
    window.openttd_syncfs(() => {
      Module.onBootstrapReload?.();
    });
  };

  window.openttd_server_list = () => {
    // Add custom servers here if needed
    // const addServer = Module.cwrap('em_openttd_add_server', null, ['string']);
    // addServer('localhost:3979');
  };

  // Handle URL opening with mouse button tracking
  let leftButtonDown = false;
  document.addEventListener('mousedown', (e) => {
    if (e.button === 0) leftButtonDown = true;
  });
  document.addEventListener('mouseup', (e) => {
    if (e.button === 0) leftButtonDown = false;
  });

  window.openttd_open_url = (urlPtr, urlLen) => {
    const urlString = Module.UTF8ToString(urlPtr, urlLen);

    function openWindow() {
      document.removeEventListener('mouseup', openWindow);
      window.open(urlString, '_blank');
    }

    if (leftButtonDown) {
      document.addEventListener('mouseup', openWindow);
    } else {
      openWindow();
    }
  };
}

/**
 * Patches SOCKFS for proper WebSocket URL handling
 * @param {Object} Module
 * @deprecated SOCKFS patching is already done in os/emscripten/pre.js which is compiled into openttd.js
 */
export function patchSocketFS(Module) {
  // No-op: SOCKFS is already patched by pre.js in the compiled openttd.js
  // The patch uses Module.websocket.url as a function (set in createWebSocketConfig)
}
