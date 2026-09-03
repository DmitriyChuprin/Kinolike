// Quick syntax check for backend files
const fs = require('fs');
const path = require('path');

const files = [
  'server/models/user.js',
  'server/models/listItem.js',
  'server/models/recommendation.js',
  'server/middleware/auth.js',
  'server/utils/helpers.js',
  'server/services/tmdb.js',
  'server/services/ai.js',
  'server/routes/auth.js',
  'server/routes/lists.js',
  'server/routes/watched.js',
  'server/routes/tmdb.js',
  'server/routes/recommendations.js',
  'server/routes/stats.js',
  'server/index.js',
];

let ok = 0;
let fail = 0;

for (const file of files) {
  try {
    const code = fs.readFileSync(file, 'utf8');
    new Function(code); // syntax check only
    console.log('OK:', file);
    ok++;
  } catch (e) {
    console.error('ERROR:', file, '-', e.message);
    fail++;
  }
}

console.log(`\n${ok} OK, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
