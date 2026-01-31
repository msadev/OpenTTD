/**
 * OpenTTD Web MIDI Player
 * Plays MIDI files from the virtual filesystem using JZZ + JZZ.synth.Tiny
 */

import JZZ from 'jzz';
import Tiny from 'jzz-synth-tiny';
import SMF from 'jzz-midi-smf';

// Initialize JZZ plugins
Tiny(JZZ);
SMF(JZZ);

let synth = null;
let midiOut = null;
let currentPlayer = null;
let currentVolume = 1.0;
let isPlaying = false;
let initPromise = null;

/**
 * Initialize the MIDI synthesizer
 */
async function initSynth() {
  if (synth) return synth;

  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      // Initialize JZZ without requesting MIDI access (we only use the software synth)
      await JZZ({ sysex: false, engine: 'none' });

      // Create the Tiny synth (General MIDI software synthesizer)
      synth = JZZ.synth.Tiny();
      midiOut = synth;

      return synth;
    } catch (e) {
      initPromise = null;
      throw e;
    }
  })();

  return initPromise;
}

/**
 * Play a MIDI file from the virtual filesystem
 * @param {string} filename - Path to the MIDI file in the virtual FS
 */
export async function playMidiFile(filename) {
  try {
    await initSynth();

    // Read the MIDI file from the virtual filesystem
    const FS = window.FS;
    if (!FS) return;

    // Check if file exists
    let data;
    try {
      data = FS.readFile(filename);
    } catch (e) {
      return;
    }

    // Stop any currently playing song
    stopMidiPlayback();

    // Parse the MIDI file
    const smf = new JZZ.MIDI.SMF(data);

    // Create a player for this SMF
    currentPlayer = smf.player();

    // Connect to our synth
    currentPlayer.connect(midiOut);

    // Set up end callback
    currentPlayer.onEnd = () => {
      isPlaying = false;
    };

    // Apply current volume
    applyVolume();

    // Start playing
    currentPlayer.play();
    isPlaying = true;

  } catch (e) {
    isPlaying = false;
  }
}

/**
 * Stop MIDI playback
 */
export function stopMidiPlayback() {
  if (currentPlayer) {
    try {
      currentPlayer.stop();
      currentPlayer.disconnect();
    } catch (e) {
      // Ignore errors when stopping
    }
    currentPlayer = null;
  }

  // Send all notes off to all channels
  if (midiOut) {
    for (let ch = 0; ch < 16; ch++) {
      try {
        midiOut.send([0xB0 + ch, 123, 0]); // All notes off
        midiOut.send([0xB0 + ch, 121, 0]); // Reset all controllers
      } catch (e) {
        // Ignore
      }
    }
  }

  isPlaying = false;
}

/**
 * Check if a song is currently playing
 * @returns {boolean}
 */
export function isMidiPlaying() {
  return isPlaying;
}

/**
 * Apply volume to all channels
 */
function applyVolume() {
  if (!midiOut) return;

  // Set volume on all 16 MIDI channels using CC7 (Volume)
  const volumeValue = Math.floor(currentVolume * 127);
  for (let ch = 0; ch < 16; ch++) {
    try {
      midiOut.send([0xB0 + ch, 7, volumeValue]);
    } catch (e) {
      // Ignore
    }
  }
}

/**
 * Set the music volume
 * @param {number} volume - Volume from 0.0 to 1.0
 */
export function setMidiVolume(volume) {
  currentVolume = Math.max(0, Math.min(1, volume));
  applyVolume();
}

/**
 * Initialize the MIDI player (called from C++)
 */
export function initMidiPlayer() {
  initSynth().catch(() => {});
}

/**
 * Setup global functions for the WASM module to call
 */
export function setupMusicGlobals() {
  window.openttd_music_init = () => {
    initMidiPlayer();
  };

  window.openttd_music_play = (filename) => {
    playMidiFile(filename);
  };

  window.openttd_music_stop = () => {
    stopMidiPlayback();
  };

  window.openttd_music_is_playing = () => {
    return isMidiPlaying();
  };

  window.openttd_music_set_volume = (volume) => {
    setMidiVolume(volume);
  };
}
