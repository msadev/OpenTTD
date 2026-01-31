/*
 * This file is part of OpenTTD.
 * OpenTTD is free software; you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, version 2.
 * OpenTTD is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU General Public License for more details. You should have received a copy of the GNU General Public License along with OpenTTD. If not, see <http://www.gnu.org/licenses/>.
 */

/** @file emscripten_m.cpp Music driver for Emscripten/WebAssembly. */

#ifdef __EMSCRIPTEN__

#include "../stdafx.h"
#include "../debug.h"
#include "emscripten_m.h"
#include "midifile.hpp"
#include "../base_media_base.h"

#include <emscripten.h>

#include "../safeguards.h"

/** Factory for the Emscripten music driver. */
static FMusicDriver_Emscripten iFMusicDriver_Emscripten;

std::optional<std::string_view> MusicDriver_Emscripten::Start(const StringList &)
{
	Debug(driver, 1, "emscripten music driver: starting");

	// Check if JavaScript MIDI player is available
	bool available = EM_ASM_INT({
		return typeof window.openttd_music_init === 'function' ? 1 : 0;
	});

	if (available) {
		EM_ASM({
			window.openttd_music_init();
		});
	} else {
		Debug(driver, 1, "emscripten music driver: JS music player not available, music will be silent");
	}

	return std::nullopt;
}

void MusicDriver_Emscripten::Stop()
{
	Debug(driver, 1, "emscripten music driver: stopping");
	this->StopSong();
}

void MusicDriver_Emscripten::PlaySong(const MusicSongInfo &song)
{
	std::string filename = MidiFile::GetSMFFile(song);

	if (filename.empty()) {
		Debug(driver, 1, "emscripten music driver: no MIDI file for song");
		return;
	}

	Debug(driver, 1, "emscripten music driver: playing {}", filename);

	this->playing = true;

	EM_ASM({
		if (typeof window.openttd_music_play === 'function') {
			window.openttd_music_play(UTF8ToString($0));
		}
	}, filename.c_str());
}

void MusicDriver_Emscripten::StopSong()
{
	this->playing = false;

	EM_ASM({
		if (typeof window.openttd_music_stop === 'function') {
			window.openttd_music_stop();
		}
	});
}

bool MusicDriver_Emscripten::IsSongPlaying()
{
	if (!this->playing) return false;

	// Check with JavaScript if song is still playing
	bool still_playing = EM_ASM_INT({
		if (typeof window.openttd_music_is_playing === 'function') {
			return window.openttd_music_is_playing() ? 1 : 0;
		}
		return 0;
	});

	this->playing = still_playing;
	return this->playing;
}

void MusicDriver_Emscripten::SetVolume(uint8_t vol)
{
	this->volume = vol;

	EM_ASM({
		if (typeof window.openttd_music_set_volume === 'function') {
			window.openttd_music_set_volume($0 / 127.0);
		}
	}, vol);
}

#endif /* __EMSCRIPTEN__ */
