export type JellyfinDeviceProfile = Record<string, unknown>;

export type BrowserCapabilities = {
  name: 'Firefox' | 'Chrome/Chromium' | 'Safari' | 'iPhone/iOS' | 'Other';
  h264: boolean;
  hevc: boolean;
  vp8: boolean;
  vp9: boolean;
  av1: boolean;
  aac: boolean;
  mp3: boolean;
  opus: boolean;
  vorbis: boolean;
  flac: boolean;
  ac3: boolean;
  eac3: boolean;
  dts: false;
  mp4: boolean;
  webm: boolean;
  mkv: boolean;
  nativeHls: boolean;
};

function supported(element: HTMLMediaElement, type: string) {
  return Boolean(element.canPlayType(type).replace(/no/i, ''));
}

async function decodingSupported(contentType: string, fallback: boolean) {
  if (!fallback || !navigator.mediaCapabilities?.decodingInfo) return fallback;
  try {
    const result = await navigator.mediaCapabilities.decodingInfo({
      type: 'file',
      video: { contentType, width: 1920, height: 1080, bitrate: 12_000_000, framerate: 30 },
    });
    return result.supported;
  } catch {
    return fallback;
  }
}

export async function detectBrowserCapabilities(): Promise<BrowserCapabilities> {
  const video = document.createElement('video');
  const audio = document.createElement('audio');
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const firefox = /Firefox\//i.test(ua) || /FxiOS\//i.test(ua);
  const chromium = /Chrome|Chromium|CriOS|Edg\//i.test(ua) && !firefox;
  const safari = /Safari\//i.test(ua) && !chromium && !/Android/i.test(ua);
  const name = ios ? 'iPhone/iOS' : firefox ? 'Firefox' : safari ? 'Safari' : chromium ? 'Chrome/Chromium' : 'Other';
  const h264Probe = supported(video, 'video/mp4; codecs="avc1.42E01E"');
  const hevcProbe = supported(video, 'video/mp4; codecs="hvc1.1.6.L120"') || supported(video, 'video/mp4; codecs="hev1.1.6.L120"');
  const h264 = await decodingSupported('video/mp4; codecs="avc1.42E01E"', h264Probe);
  const hevc = await decodingSupported('video/mp4; codecs="hvc1.1.6.L120"', hevcProbe);
  const ac3Probe = supported(audio, 'audio/mp4; codecs="ac-3"');
  const eac3Probe = supported(audio, 'audio/mp4; codecs="ec-3"');

  return {
    name,
    h264,
    hevc,
    vp8: supported(video, 'video/webm; codecs="vp8"'),
    vp9: supported(video, 'video/webm; codecs="vp9"'),
    av1: supported(video, 'video/mp4; codecs="av01.0.08M.08"'),
    aac: supported(audio, 'audio/mp4; codecs="mp4a.40.2"'),
    mp3: supported(audio, 'audio/mpeg'),
    opus: supported(audio, 'audio/ogg; codecs="opus"') || supported(audio, 'audio/webm; codecs="opus"'),
    vorbis: supported(audio, 'audio/ogg; codecs="vorbis"'),
    flac: supported(audio, 'audio/flac'),
    // Firefox is deliberately conservative here. Platform decoders differ,
    // while a false positive produces the exact "video without sound" bug.
    ac3: firefox ? false : ac3Probe,
    eac3: firefox ? false : eac3Probe,
    dts: false,
    mp4: h264 || hevc,
    webm: supported(video, 'video/webm'),
    // Firefox MKV streaming currently has known preload/seek issues. Other
    // engines may opt in only when canPlayType explicitly confirms support.
    mkv: !firefox && !ios && supported(video, 'video/x-matroska'),
    nativeHls: supported(video, 'application/vnd.apple.mpegurl') || supported(video, 'application/x-mpegURL'),
  };
}

export function buildDeviceProfile(capabilities: BrowserCapabilities): JellyfinDeviceProfile {
  const videoCodecs = [capabilities.h264 && 'h264', capabilities.hevc && 'hevc', capabilities.vp9 && 'vp9', capabilities.av1 && 'av1'].filter(Boolean) as string[];
  const webmVideoCodecs = [capabilities.vp8 && 'vp8', capabilities.vp9 && 'vp9', capabilities.av1 && 'av1'].filter(Boolean) as string[];
  const audioCodecs = [capabilities.aac && 'aac', capabilities.mp3 && 'mp3', capabilities.ac3 && 'ac3', capabilities.eac3 && 'eac3', capabilities.opus && 'opus', capabilities.flac && 'flac', capabilities.vorbis && 'vorbis'].filter(Boolean) as string[];
  const directPlayProfiles: Record<string, string>[] = [];
  if (capabilities.mp4 && videoCodecs.length) directPlayProfiles.push({ Container: 'mp4,m4v,mov', Type: 'Video', VideoCodec: videoCodecs.join(','), AudioCodec: audioCodecs.join(',') });
  if (capabilities.webm && webmVideoCodecs.length) directPlayProfiles.push({ Container: 'webm', Type: 'Video', VideoCodec: webmVideoCodecs.join(','), AudioCodec: [capabilities.opus && 'opus', capabilities.vorbis && 'vorbis'].filter(Boolean).join(',') });
  if (capabilities.mkv && videoCodecs.length) directPlayProfiles.push({ Container: 'mkv', Type: 'Video', VideoCodec: videoCodecs.join(','), AudioCodec: audioCodecs.join(',') });
  directPlayProfiles.push({ Container: 'hls', Type: 'Video', VideoCodec: videoCodecs.join(','), AudioCodec: 'aac' });

  const codecProfiles: Record<string, unknown>[] = [];
  if (capabilities.h264) codecProfiles.push({ Type: 'Video', Codec: 'h264', Conditions: [{ Condition: 'EqualsAny', Property: 'VideoProfile', Value: 'baseline|constrained baseline|main|high', IsRequired: false }, { Condition: 'LessThanEqual', Property: 'VideoLevel', Value: '52', IsRequired: false }] });
  if (capabilities.hevc) codecProfiles.push({ Type: 'Video', Codec: 'hevc', Conditions: [{ Condition: 'EqualsAny', Property: 'VideoProfile', Value: 'main|main 10', IsRequired: false }, { Condition: 'LessThanEqual', Property: 'VideoLevel', Value: '153', IsRequired: false }] });

  return {
    Name: `KinoLike ${capabilities.name}`,
    MaxStreamingBitrate: 120_000_000,
    MaxStaticBitrate: 120_000_000,
    DirectPlayProfiles: directPlayProfiles,
    // AAC is first and intentionally the only HLS output audio codec. Thus an
    // incompatible DTS/AC3/E-AC3 track is converted without forcing video encode.
    TranscodingProfiles: [{
      Container: 'mp4', Type: 'Video', VideoCodec: videoCodecs.join(',') || 'h264', AudioCodec: 'aac',
      Context: 'Streaming', Protocol: 'hls', MaxAudioChannels: '6', MinSegments: capabilities.nativeHls ? '2' : '1', BreakOnNonKeyFrames: true,
    }],
    ContainerProfiles: [],
    CodecProfiles: codecProfiles,
    SubtitleProfiles: [
      { Format: 'vtt', Method: 'External' },
      { Format: 'srt', Method: 'External' },
      { Format: 'ass', Method: 'External' },
      { Format: 'ssa', Method: 'External' },
      { Format: 'subrip', Method: 'External' },
      { Format: 'pgssub', Method: 'Encode' },
      { Format: 'pgs', Method: 'Encode' },
      { Format: 'dvdsub', Method: 'Encode' },
      { Format: 'dvbsub', Method: 'Encode' },
    ],
  };
}

export function getDeviceId() {
  const key = 'kinolike-jellyfin-device-id';
  let id = localStorage.getItem(key);
  if (!id) {
    id = `kinolike-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
    localStorage.setItem(key, id);
  }
  return id;
}
