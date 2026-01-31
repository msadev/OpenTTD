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
    arguments: ['-mnull', '-snull', '-vsdl'],
    preRun: [],
    postRun: [],

    print(text) {
      console.log('[OpenTTD]', text);
    },

    printErr(text) {
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
    }
  };

  // Attach to window for Emscripten's internal use
  window.Module = Module;

  return Module;
}

/**
 * Initializes the filesystem with IDBFS for persistent storage
 * @param {Object} Module
 */
export function initFileSystem(Module) {
  Module.preRun.push(() => {
    const personalDir = '/home/web_user/.openttd';

    try {
      // Create personal directory
      Module.FS.mkdir(personalDir);

      // Mount IDBFS for persistent storage
      Module.FS.mount(Module.IDBFS, {}, personalDir);

      // Sync from IndexedDB to virtual filesystem
      Module.addRunDependency('syncfs');
      Module.FS.syncfs(true, (err) => {
        Module.removeRunDependency('syncfs');
        if (err) {
          console.error('[OpenTTD] Failed to sync filesystem:', err);
        }
      });
    } catch (e) {
      console.error('[OpenTTD] Failed to init filesystem:', e);
    }
  });

  // Setup global sync function
  window.openttd_syncfs = (callback) => {
    Module.FS.syncfs(false, (err) => {
      if (err) {
        console.error('[OpenTTD] Failed to save to IndexedDB:', err);
      }
      callback?.();
    });
  };

  window.openttd_syncfs_shown_warning = false;
}

/**
 * Sets up WebSocket configuration for network play
 * @param {Object} Module
 */
export function setupWebSocket(Module) {
  Module.websocket = {
    url: (host, port, proto) => {
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
 */
export function patchSocketFS(Module) {
  Module.preRun.push(() => {
    // Patch SOCKFS to use custom WebSocket URL function
    if (typeof SOCKFS !== 'undefined') {
      SOCKFS.websocket_sock_ops.createPeer_ = SOCKFS.websocket_sock_ops.createPeer;
      SOCKFS.websocket_sock_ops.createPeer = function(sock, addr, port) {
        const func = Module.websocket.url;
        Module.websocket.url = func(addr, port, sock.type === 2 ? 'udp' : 'tcp');
        const ret = SOCKFS.websocket_sock_ops.createPeer_(sock, addr, port);
        Module.websocket.url = func;
        return ret;
      };
    }
  });
}
