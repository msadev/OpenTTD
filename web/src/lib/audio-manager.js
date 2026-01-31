/**
 * Web Audio API Manager for OpenTTD
 * Handles audio context initialization and browser autoplay restrictions
 */

class AudioManager {
  constructor() {
    this.audioContext = null;
    this.isUnlocked = false;
    this.onUnlock = null;
  }

  /**
   * Initialize the audio context (call early, but won't work until user interaction)
   */
  init() {
    if (this.audioContext) return;

    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioContext();

      // Check if already running (some browsers allow this)
      if (this.audioContext.state === 'running') {
        this.isUnlocked = true;
      }
    } catch (e) {
      console.warn('[Audio] Web Audio API not supported:', e);
    }
  }

  /**
   * Attempt to unlock audio (must be called from user interaction)
   * @returns {Promise<boolean>}
   */
  async unlock() {
    if (this.isUnlocked) return true;
    if (!this.audioContext) this.init();
    if (!this.audioContext) return false;

    try {
      // Resume the audio context
      await this.audioContext.resume();

      // Play a silent sound to fully unlock on iOS
      const buffer = this.audioContext.createBuffer(1, 1, 22050);
      const source = this.audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(this.audioContext.destination);
      source.start(0);

      this.isUnlocked = true;
      this.onUnlock?.();
      console.log('[Audio] Audio context unlocked');
      return true;
    } catch (e) {
      console.error('[Audio] Failed to unlock audio:', e);
      return false;
    }
  }

  /**
   * Get the sample rate for Emscripten audio
   * @returns {number}
   */
  getSampleRate() {
    return this.audioContext?.sampleRate || 44100;
  }

  /**
   * Check if audio is available and unlocked
   * @returns {boolean}
   */
  isReady() {
    return this.isUnlocked && this.audioContext?.state === 'running';
  }

  /**
   * Suspend audio (for when game is paused/hidden)
   */
  suspend() {
    this.audioContext?.suspend();
  }

  /**
   * Resume audio
   */
  resume() {
    if (this.isUnlocked) {
      this.audioContext?.resume();
    }
  }
}

export const audioManager = new AudioManager();
