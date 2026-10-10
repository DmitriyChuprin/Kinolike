const assert = require('assert');
const { playbackDiagnostics, fallbackItemMatches, itemHasFile, normalizeTitle, sortEpisodesForAutoplay, secondsToTicks, buildPlaybackEvent, buildPlaybackStopEvent } = require('../services/jellyfin');

function diagnostic({ container, video, audio, transcoding = false, reasons = [], targetAudio = 'aac', targetVideo = 'h264' }) {
  return playbackDiagnostics(
    'Test item',
    'Firefox',
    { Container: container, TranscodingUrl: transcoding ? `/Videos/test/master.m3u8?AudioCodec=${targetAudio}&VideoCodec=${targetVideo}` : null, TranscodingReasons: reasons },
    { Codec: audio },
    { Codec: video }
  );
}

const mp4 = diagnostic({ container: 'mp4', video: 'h264', audio: 'aac' });
assert.strictEqual(mp4.videoMode, 'Direct Play / Copy');
assert.strictEqual(mp4.audioMode, 'Direct Play / Copy');

const dts = diagnostic({ container: 'mkv', video: 'h264', audio: 'dts', transcoding: true, reasons: ['ContainerNotSupported', 'AudioCodecNotSupported'] });
assert.strictEqual(dts.videoMode, 'Direct Stream / Copy');
assert.strictEqual(dts.audioMode, 'Transcode DTS → AAC');
assert.strictEqual(dts.protocol, 'HLS');

const ac3 = diagnostic({ container: 'mkv', video: 'h264', audio: 'ac3', transcoding: true, reasons: ['ContainerNotSupported'], targetAudio: 'ac3' });
assert.strictEqual(ac3.videoMode, 'Direct Stream / Copy');
assert.strictEqual(ac3.audioMode, 'Copy');

const unsupportedHevc = diagnostic({ container: 'mkv', video: 'hevc', audio: 'dts', transcoding: true, reasons: ['VideoCodecNotSupported', 'AudioCodecNotSupported'] });
assert.strictEqual(unsupportedHevc.videoMode, 'Transcode HEVC → H264');
assert.strictEqual(unsupportedHevc.audioMode, 'Transcode DTS → AAC');

const supportedHevc = diagnostic({ container: 'mkv', video: 'hevc', audio: 'dts', transcoding: true, reasons: ['ContainerNotSupported', 'AudioCodecNotSupported'], targetVideo: 'hevc' });
assert.strictEqual(supportedHevc.videoMode, 'Direct Stream / Copy');
assert.strictEqual(supportedHevc.audioMode, 'Transcode DTS → AAC');

assert.strictEqual(normalizeTitle('  Ёлки: Новые! '), 'ёлки новые');
assert.strictEqual(fallbackItemMatches(
  { Type: 'Movie', Name: 'The Thing', OriginalTitle: 'The Thing', ProductionYear: 1982 },
  { mediaType: 'movie', title: 'Нечто', originalTitle: 'The Thing', year: 1982 }
), true);
assert.strictEqual(fallbackItemMatches(
  { Type: 'Movie', Name: 'The Thing', ProductionYear: 2011 },
  { mediaType: 'movie', title: 'The Thing', year: 1982 }
), false);
assert.strictEqual(fallbackItemMatches(
  { Type: 'Movie', Name: 'The Thing' },
  { mediaType: 'movie', title: 'The Thing', year: 1982 }
), false);
assert.strictEqual(fallbackItemMatches(
  { Type: 'Series', Name: 'Office Space', ProductionYear: 1999 },
  { mediaType: 'tv', title: 'The Office', year: 2005 }
), false);
assert.strictEqual(itemHasFile({ IsVirtualItem: false, MediaSources: [{ Id: 'source' }] }), true);
assert.strictEqual(itemHasFile({ IsVirtualItem: true, Path: '/media/episode.mkv' }), false);

const autoplayEpisodes = sortEpisodesForAutoplay([
  { id: 's2e1', season: 2, episode: 1 },
  { id: 'special', season: 0, episode: 1 },
  { id: 's1e4', season: 1, episode: 4 },
  { id: 's1e2', season: 1, episode: 2 },
]);
assert.deepStrictEqual(autoplayEpisodes.map((episode) => episode.id), ['s1e2', 's1e4', 's2e1']);

assert.strictEqual(secondsToTicks(72 * 60 + 37), 43570000000);
assert.strictEqual(secondsToTicks(600), 6000000000, 'Jellyfin uses 10,000,000 ticks per second');
assert.deepStrictEqual(buildPlaybackEvent({
  jellyfin_item_id: 'item', media_source_id: 'source', play_session_id: 'play',
  play_method: 'Transcode', audio_stream_index: 2, subtitle_stream_index: -1,
}, { positionSeconds: 12.5, isPaused: true }), {
  ItemId: 'item', MediaSourceId: 'source', PlaySessionId: 'play', PositionTicks: 125000000,
  PlayMethod: 'Transcode', CanSeek: true, IsPaused: true,
  AudioStreamIndex: 2, SubtitleStreamIndex: -1,
});
assert.deepStrictEqual(buildPlaybackStopEvent({
  jellyfin_item_id: 'item', media_source_id: 'source', play_session_id: 'play',
}, { positionSeconds: 12.5 }), {
  ItemId: 'item', MediaSourceId: 'source', PlaySessionId: 'play', PositionTicks: 125000000, Failed: false,
});

console.log('✓ Jellyfin lookup, episode ordering and playback mode diagnostics');
