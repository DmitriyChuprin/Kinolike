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

pool.on('error', (err) => {
  console.error('Ошибка соединения PostgreSQL:', err.message);
});

// Инициализируем схему при старте
async function initSchema() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(schema);
  console.log('PostgreSQL схема инициализирована');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Применяем миграции
  const migrationsDir = path.join(__dirname, 'migrations');
  if (fs.existsSync(migrationsDir)) {
    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
      const migrationPath = path.join(migrationsDir, file);
      const migration = fs.readFileSync(migrationPath, 'utf8');
      const { rows } = await pool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
      if (rows.length > 0) continue;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`Миграция применена: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`Ошибка миграции ${file}:`, err.message);
        throw err;
      } finally {
        client.release();
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
