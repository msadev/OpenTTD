/**
 * OpenTTD Web - Touch/Mobile Input Handler
 *
 * Provides mobile-friendly touch controls:
 * - Hides the in-game cursor on touch devices
 * - Pinch-to-zoom (two fingers)
 * - Single-finger drag to pan camera (when no construction tool is active)
 * - Normal touch-as-click when a construction tool is active
 *
 * Click detection strategy:
 * OpenTTD detects a left-click when _left_button_down is true and
 * _left_button_clicked is false (see window.cpp HandleMouseEvents).
 * So we must send mousedown on touchstart so the button stays pressed
 * for at least one game loop tick. If the finger moves (drag), we
 * cancel the left-click and switch to right-click-drag (camera pan)
 * or keep it as left-drag (construction tool).
 */

/** Minimum pixel distance change to trigger a zoom step. */
const PINCH_THRESHOLD = 20;

/** Minimum pixel movement before a touch is considered a drag (not a tap). */
const DRAG_THRESHOLD = 8;

/**
 * Compute distance between two Touch objects.
 */
function touchDistance(a, b) {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Compute midpoint between two Touch objects.
 */
function touchMidpoint(a, b) {
  return {
    x: (a.clientX + b.clientX) / 2,
    y: (a.clientY + b.clientY) / 2,
  };
}

/**
 * Dispatch a synthetic MouseEvent on the canvas.
 */
function sendMouse(canvas, type, x, y, button = 0) {
  canvas.dispatchEvent(new MouseEvent(type, {
    clientX: x,
    clientY: y,
    button,
    buttons: button === 2 ? 2 : (button === 0 ? 1 : 0),
    bubbles: true,
    cancelable: true,
  }));
}

/**
 * Dispatch a synthetic WheelEvent on the canvas.
 */
function sendWheel(canvas, x, y, deltaY) {
  canvas.dispatchEvent(new WheelEvent('wheel', {
    clientX: x,
    clientY: y,
    deltaY,
    deltaMode: 0, // pixels
    bubbles: true,
    cancelable: true,
  }));
}

/**
 * Initialize touch handling on the game canvas.
 * @param {HTMLCanvasElement} canvas - The game canvas element.
 * @param {object} Module - The Emscripten Module object.
 */
export function initTouchHandler(canvas, Module) {
  // Only activate on touch-capable devices
  if (!('ontouchstart' in window)) return;

  let gestureType = null; // 'tap' | 'pan' | 'pinch' | 'tool' | null
  let startTouch = null;  // { x, y } of initial single-finger touch
  let lastPinchDist = 0;
  let cursorHidden = false;

  /**
   * Check if a construction/placement tool is currently active.
   */
  function isPlacing() {
    try {
      return Module._em_openttd_is_placing() !== 0;
    } catch {
      return false;
    }
  }

  /**
   * Hide the in-game drawn cursor via exported C++ function.
   */
  function hideCursor() {
    if (cursorHidden) return;
    cursorHidden = true;
    try {
      Module._em_openttd_set_cursor_visible(0);
    } catch {
      // Function not available yet, ignore
    }
  }

  /**
   * Restore cursor visibility when switching back to mouse input.
   */
  function showCursor() {
    if (!cursorHidden) return;
    cursorHidden = false;
    try {
      Module._em_openttd_set_cursor_visible(1);
    } catch {
      // Function not available yet, ignore
    }
  }

  // Restore cursor if user switches to mouse
  canvas.addEventListener('mousemove', (e) => {
    if (e.isTrusted && (e.movementX !== 0 || e.movementY !== 0)) {
      showCursor();
    }
  });

  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    hideCursor();

    if (e.touches.length === 2) {
      // Cancel any ongoing single-finger gesture
      if (gestureType === 'tap') {
        sendMouse(canvas, 'mouseup', startTouch.x, startTouch.y, 0);
      } else if (gestureType === 'pan') {
        sendMouse(canvas, 'mouseup', startTouch.x, startTouch.y, 2);
      } else if (gestureType === 'tool') {
        sendMouse(canvas, 'mouseup', startTouch.x, startTouch.y, 0);
      }
      // Start pinch gesture
      gestureType = 'pinch';
      lastPinchDist = touchDistance(e.touches[0], e.touches[1]);
    } else if (e.touches.length === 1) {
      startTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      gestureType = 'tap';
      // Send mousedown immediately so the game sees _left_button_down = true
      // for at least one game loop tick. This is how OpenTTD detects clicks.
      sendMouse(canvas, 'mousemove', startTouch.x, startTouch.y, 0);
      sendMouse(canvas, 'mousedown', startTouch.x, startTouch.y, 0);
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();

    if (e.touches.length === 2 && gestureType === 'pinch') {
      // Pinch-to-zoom
      const dist = touchDistance(e.touches[0], e.touches[1]);
      const delta = dist - lastPinchDist;

      if (Math.abs(delta) > PINCH_THRESHOLD) {
        const mid = touchMidpoint(e.touches[0], e.touches[1]);
        sendWheel(canvas, mid.x, mid.y, delta > 0 ? -100 : 100);
        lastPinchDist = dist;
      }
      return;
    }

    if (e.touches.length !== 1) return;

    const x = e.touches[0].clientX;
    const y = e.touches[0].clientY;

    if (gestureType === 'tap' && startTouch) {
      // Check if finger moved enough to become a drag
      const dx = x - startTouch.x;
      const dy = y - startTouch.y;
      if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
        if (isPlacing()) {
          // Construction mode: keep the left-click drag going
          gestureType = 'tool';
        } else {
          // Normal mode: cancel left-click, switch to right-click drag (pan)
          sendMouse(canvas, 'mouseup', startTouch.x, startTouch.y, 0);
          gestureType = 'pan';
          sendMouse(canvas, 'mousemove', startTouch.x, startTouch.y, 2);
          sendMouse(canvas, 'mousedown', startTouch.x, startTouch.y, 2);
        }
      }
    }

    if (gestureType === 'pan') {
      sendMouse(canvas, 'mousemove', x, y, 2);
    } else if (gestureType === 'tool') {
      sendMouse(canvas, 'mousemove', x, y, 0);
    }
  }, { passive: false });

  function onTouchEnd(e) {
    e.preventDefault();

    if (e.touches.length === 0) {
      const last = e.changedTouches[0];
      const lx = last.clientX;
      const ly = last.clientY;

      if (gestureType === 'tap') {
        // Simple tap: release left button
        sendMouse(canvas, 'mouseup', lx, ly, 0);
      } else if (gestureType === 'pan') {
        sendMouse(canvas, 'mouseup', lx, ly, 2);
      } else if (gestureType === 'tool') {
        sendMouse(canvas, 'mouseup', lx, ly, 0);
      }

      gestureType = null;
      startTouch = null;
    } else if (e.touches.length === 1 && gestureType === 'pinch') {
      // Transitioned from pinch to single finger - start fresh
      startTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      gestureType = 'tap';
      sendMouse(canvas, 'mousemove', startTouch.x, startTouch.y, 0);
      sendMouse(canvas, 'mousedown', startTouch.x, startTouch.y, 0);
    }
  }

  canvas.addEventListener('touchend', onTouchEnd, { passive: false });
  canvas.addEventListener('touchcancel', onTouchEnd, { passive: false });

  console.log('[OpenTTD] Touch handler initialized');
}
