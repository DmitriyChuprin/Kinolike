// VkMovie service — VK API video search with direct MP4 URLs
// Based on Lampac VkMovie module
const fetch = require('node-fetch');

const VK_CLIENT_ID = 52461373;
const VK_API_VERSION = '5.264';

let accessToken = null;
let tokenExpires = 0;

/**
 * Get anonymous VK token
 */
async function ensureToken() {
  if (accessToken && Date.now() < tokenExpires) return accessToken;

  const url = 'https://login.vk.com/?act=get_anonym_token';
  const body = `client_secret=o557NLIkAErNhakXrQ7A&client_id=${VK_CLIENT_ID}&scopes=audio_anonymous%2Cvideo_anonymous%2Cphotos_anonymous%2Cprofile_anonymous&isApiOauthAnonymEnabled=false&version=1&app_id=6287487`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });
    const json = await resp.json();
    const data = json.data;
    if (!data || !data.access_token) {
      throw new Error('No access_token in response');
    }
    accessToken = data.access_token;
    // Token expires in ~10 hours
    tokenExpires = Date.now() + 9 * 60 * 60 * 1000;
    console.log('[VkMovie] Token obtained');
    return accessToken;
  } catch (err) {
    console.error('[VkMovie] Token error:', err.message);
    throw err;
  }
}

/**
 * Search videos on VK
 * @param {string} title - movie title
 * @param {number} year - release year
 * @returns {Array} list of video results with MP4 URLs
 */
async function search(title, year) {
  const token = await ensureToken();

  const url = `https://api.vk.com/method/catalog.getVideoSearchWeb2?v=${VK_API_VERSION}&client_id=${VK_CLIENT_ID}`;
  const data = `screen_ref=search_video_service&input_method=keyboard_search_button&q=${encodeURIComponent(`${title} ${year}`)}&access_token=${token}`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      body: data,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });
    const json = await resp.json();

    if (json.error) {
      throw new Error(`VK API error: ${json.error.error_msg}`);
    }

    const catalogVideos = json.response?.catalog_videos;
    if (!catalogVideos || catalogVideos.length === 0) {
      return [];
    }

    const searchTitle = title.toLowerCase().trim();
    const results = [];

    for (const item of catalogVideos) {
      const video = item.video;
      if (!video || !video.files) continue;

      const videoTitle = (video.title || '').toLowerCase().trim();
      if (!videoTitle.includes(searchTitle)) continue;

      // Check year match (±1 year)
      const yearMatch = videoTitle.includes(String(year)) ||
                        videoTitle.includes(String(year + 1)) ||
                        videoTitle.includes(String(year - 1));
      if (!yearMatch) continue;

      // Skip short videos (trailers, etc.)
      if (video.duration < 3000) continue;

      // Skip trailers, reviews, etc.
      const skipWords = ['трейлер', 'trailer', 'премьера', 'обзор', 'сезон', 'сериал', 'серия', 'серий'];
      if (skipWords.some(w => videoTitle.includes(w))) continue;

      // Build quality list
      const qualities = [];
      const files = video.files;

      const addQuality = (url, q) => {
        if (url && typeof url === 'string') qualities.push({ quality: q, url });
      };

      addQuality(files.mp4_2160, '2160p');
      addQuality(files.mp4_1440, '1440p');
      addQuality(files.mp4_1080, '1080p');
      addQuality(files.mp4_720, '720p');
      addQuality(files.mp4_480, '480p');
      addQuality(files.mp4_360, '360p');
      addQuality(files.mp4_240, '240p');
      addQuality(files.mp4_144, '144p');

      if (qualities.length === 0) continue;

      // Get subtitles
      const subtitles = [];
      if (video.subtitles && video.subtitles.length > 0) {
        for (const sub of video.subtitles) {
          if (!sub || !sub.url) continue;
          const label = sub.manifest_name || sub.title || sub.lang || 'Unknown';
          subtitles.push({ label, url: sub.url });
        }
      }

      results.push({
        id: `${video.owner_id}_${video.id}`,
        title: video.title,
        duration: video.duration,
        qualities,
        subtitles,
      });
    }

    return results;
  } catch (err) {
    console.error('[VkMovie] Search error:', err.message);
    throw err;
  }
}

module.exports = { search, ensureToken };
