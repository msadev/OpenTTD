/*
 * This file is part of OpenTTD.
 * OpenTTD is free software; you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, version 2.
 * OpenTTD is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU General Public License for more details. You should have received a copy of the GNU General Public License along with OpenTTD. If not, see <http://www.gnu.org/licenses/>.
 */

/** @file emscripten_m.h Music driver for Emscripten/WebAssembly using Web MIDI. */

#ifndef MUSIC_EMSCRIPTEN_H
#define MUSIC_EMSCRIPTEN_H

#include "music_driver.hpp"

/** Music driver for Emscripten that calls JavaScript for MIDI playback. */
class MusicDriver_Emscripten : public MusicDriver {
private:
	bool playing = false;
	uint8_t volume = 127;

public:
	std::optional<std::string_view> Start(const StringList &param) override;
	void Stop() override;
	void PlaySong(const MusicSongInfo &song) override;
	void StopSong() override;
	bool IsSongPlaying() override;
	void SetVolume(uint8_t vol) override;
	std::string_view GetName() const override { return "emscripten"; }
};

/** Factory for the Emscripten music driver. */
class FMusicDriver_Emscripten : public DriverFactoryBase {
public:
	FMusicDriver_Emscripten() : DriverFactoryBase(Driver::DT_MUSIC, 10, "emscripten", "Emscripten Music Driver (Web MIDI)") {}
	std::unique_ptr<Driver> CreateInstance() const override { return std::make_unique<MusicDriver_Emscripten>(); }
};

#endif /* MUSIC_EMSCRIPTEN_H */
