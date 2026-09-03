const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  host: process.env.PGHOST || 'db',
  port: parseInt(process.env.PGPORT) || 5432,
  database: process.env.PGDATABASE || 'kinolike',
  user: process.env.PGUSER || 'kinolike',
  password: process.env.PGPASSWORD || 'kinolike_secret',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Инициализируем схему при старте
async function initSchema() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(schema);
  console.log('PostgreSQL схема инициализирована');

  // Применяем миграции
  const migrationsDir = path.join(__dirname, 'migrations');
  if (fs.existsSync(migrationsDir)) {
    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
      const migrationPath = path.join(migrationsDir, file);
      const migration = fs.readFileSync(migrationPath, 'utf8');
      try {
        await pool.query(migration);
        console.log(`Миграция применена: ${file}`);
      } catch (err) {
        console.error(`Ошибка миграции ${file}:`, err.message);
      }
    }
  }
}

// Обёртка для экспорта — pool с методом query
const db = {
  query: (text, params) => pool.query(text, params),
  connect: () => pool.connect(),
  pool,
  initSchema,
};

module.exports = db;
