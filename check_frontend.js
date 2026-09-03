// Quick syntax check for frontend JS files
const fs = require('fs');

const files = [
  'client/js/api.js',
  'client/js/ui.js',
  'client/js/auth.js',
  'client/js/movies.js',
  'client/js/lists.js',
  'client/js/detail.js',
  'client/js/watched.js',
  'client/js/recommendations.js',
  'client/js/stats.js',
  'client/js/search.js',
  'client/js/app.js',
];

let ok = 0;
let fail = 0;

for (const file of files) {
  try {
    const code = fs.readFileSync(file, 'utf8');
    // We can't use new Function for modules with DOM access,
    // but we can check for basic syntax with acorn or eval
    // For a quick check, let's just try to parse it
    try {
      require('vm').compileFunction(code, [], { parsingContext: require('vm').createContext({}) });
      console.log('OK:', file);
      ok++;
    } catch (e) {
      // Some files use DOM APIs, try simpler check
      try {
        new Function(code);
        console.log('OK:', file, '(wrapped)');
        ok++;
      } catch (e2) {
        console.error('ERROR:', file, '-', e2.message);
        fail++;
      }
    }
  } catch (e) {
    console.error('ERROR:', file, '-', e.message);
    fail++;
  }
}

console.log(`\n${ok} OK, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
