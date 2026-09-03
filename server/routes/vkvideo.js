// VkMovie API routes — search and stream via VK API (direct MP4 URLs)
const express = require('express');
const { spawn } = require('child_process');
const vkvideo = require('../services/vkvideo');

const router = express.Router();

/**
 * POST /api/vkvideo/search
 */
router.post('/search', async (req, res) => {
  try {
    const { title, year } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    console.log(`[VkMovie] search: "${title}" (${year || '?'})`);
    const results = await vkvideo.search(title, year || new Date().getFullYear());
    console.log(`[VkMovie] found ${results.length} results`);
    res.json({ results });
  } catch (err) {
    console.error('[VkMovie] search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/vkvideo/proxy
 * Proxy MP4 via curl (VK CDN blocks Node.js TLS fingerprint)
 */
router.get('/proxy', (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'url is required' });

    console.log(`[VkMovie Proxy] ${url.substring(0, 100)}...`);

    const args = [
      '-sS', '-D', '-',
      '-H', 'Referer: https://vk.com/',
      '-H', 'User-Agent: Mozilla/5.0',
      '--max-time', '60',
    ];

    const range = req.headers.range;
    if (range) args.push('-H', `Range: ${range}`);

    args.push(url);

    const curl = spawn('curl', args);
    let headersParsed = false;
    let headerBuf = '';

    curl.stdout.on('data', (chunk) => {
      if (headersParsed) {
        if (!res.headersSent) res.writeHead(200);
        res.write(chunk);
        return;
      }

      // Accumulate headers until \r\n\r\n
      headerBuf += chunk.toString();
      const splitIdx = headerBuf.indexOf('\r\n\r\n');
      if (splitIdx === -1) return;

      headersParsed = true;
      const headerSection = headerBuf.substring(0, splitIdx);
      const remaining = headerBuf.substring(splitIdx + 4);

      const lines = headerSection.split('\r\n');
      const statusLine = lines[0];
      const statusMatch = statusLine.match(/HTTP\/[\d.]+ (\d+)/);
      const status = statusMatch ? parseInt(statusMatch[1]) : 200;

      const fwdHeaders = { 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes' };
      for (let i = 1; i < lines.length; i++) {
        const [key, ...valParts] = lines[i].split(':');
        const val = valParts.join(':').trim();
        const k = key.toLowerCase();
        if (k === 'content-type') fwdHeaders['Content-Type'] = val;
        else if (k === 'content-length') fwdHeaders['Content-Length'] = val;
        else if (k === 'content-range') fwdHeaders['Content-Range'] = val;
        else if (k === 'accept-ranges') fwdHeaders['Accept-Ranges'] = val;
      }

      console.log(`[VkMovie Proxy] ← ${status} ct=${fwdHeaders['Content-Type']} len=${fwdHeaders['Content-Length'] || 'streaming'}`);
      res.writeHead(status, fwdHeaders);
      if (remaining.length > 0) res.write(remaining);
    });

    curl.stderr.on('data', () => {});
    curl.on('close', () => {
      if (!headersParsed) {
        console.error('[VkMovie Proxy] No headers received from curl');
        if (!res.headersSent) res.status(502).json({ error: 'CDN returned no headers' });
        return;
      }
      res.end();
    });
    curl.on('error', (err) => {
      console.error('[VkMovie Proxy] curl error:', err.message);
      if (!res.headersSent) res.status(502).json({ error: err.message });
    });

    req.on('close', () => { curl.kill(); });
  } catch (err) {
    console.error('[VkMovie proxy] Error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

module.exports = router;
