const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { apiTokenAuth } = require('../middleware/apiTokenAuth');
const { ApiError, sendError, asyncRoute, notFoundHandler, errorHandler } = require('../api/errors');

// v1 sub-routers (recommendations, search, media, watchlist, watched, profile)
const v1Recommendations = require('./v1/recommendations');
const v1Search = require('./v1/search');
const v1Media = require('./v1/media');
const v1Watchlist = require('./v1/watchlist');
const v1Watched = require('./v1/watched');
const v1Profile = require('./v1/profile');

const router = express.Router();
const maxRequests = Math.max(1, Number(process.env.KINOLIKE_API_RATE_LIMIT) || 120);
const windowMs = Math.max(1000, Number(process.env.KINOLIKE_API_RATE_WINDOW_MS) || 60_000);
const rateLimitHandler = (req, res) => sendError(res, 429, 'RATE_LIMITED', 'Too many requests; retry later');

router.use(rateLimit({
  windowMs,
  max: maxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
}));

router.get('/openapi.json', (req, res) => res.sendFile(path.join(__dirname, '..', '..', 'docs', 'openapi.v1.json')));

router.get('/docs', (req, res, next) => {
  const enabled = process.env.NODE_ENV !== 'production' || process.env.KINOLIKE_API_DOCS === 'true';
  if (!enabled) return next();
  res.type('html').send(`<!doctype html><html><head><title>KinoLike API</title><link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:'/api/v1/openapi.json',dom_id:'#swagger-ui',persistAuthorization:false})</script></body></html>`);
});

router.use(apiTokenAuth);

// Mount v1 sub-routers
router.use('/recommendations', v1Recommendations);
router.use('/search', v1Search);
router.use('/media', v1Media);
router.use('/watchlist', v1Watchlist);
router.use('/watched', v1Watched);
router.use('/profile', v1Profile);

// Inline handlers kept for backward-compatible test access (handlers.X)
const handlers = {
  recommendations: async (req, res) => {
    const service = require('../services/hermesApi');
    res.json(await service.recommendations(req.user.id, req.body || {}));
  },
  preferences: async (req, res) => {
    const service = require('../services/hermesApi');
    res.json(await service.preferences(req.user.id));
  },
  search: async (req, res) => {
    const service = require('../services/hermesApi');
    if (!req.query.q) throw new ApiError(422, 'VALIDATION_ERROR', 'q is required');
    res.json(await service.search(req.user.id, req.query));
  },
  media: async (req, res) => {
    const service = require('../services/hermesApi');
    res.json(await service.getMedia(req.user.id, req.params.id));
  },
  watchlist: async (req, res) => {
    const service = require('../services/hermesApi');
    res.json({ items: await service.getWatchlist(req.user.id) });
  },
  addWatchlist: async (req, res) => {
    const service = require('../services/hermesApi');
    res.status(201).json({ item: await service.addWatchlist(req.user.id, req.body || {}) });
  },
  removeWatchlist: async (req, res) => {
    const service = require('../services/hermesApi');
    await service.removeWatchlist(req.user.id, req.params.id);
    res.status(204).end();
  },
  watched: async (req, res) => {
    const service = require('../services/hermesApi');
    res.json({ item: await service.markWatched(req.user.id, req.body || {}) });
  },
};

router.use(notFoundHandler);
router.use(errorHandler);

module.exports = router;
module.exports.handlers = handlers;
module.exports.rateLimitHandler = rateLimitHandler;
