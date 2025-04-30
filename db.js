const { Pool } = require('pg');
require('dotenv').config();

// Utworzenie puli połączeń do bazy danych PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Nasłuchiwanie na błędy połączenia
pool.on('error', (err) => {
  console.error('Nieoczekiwany błąd w puli połączeń PostgreSQL', err);
  process.exit(-1);
});

// Funkcja testująca połączenie
const testConnection = async () => {
  try {
    const client = await pool.connect();
    console.log('Połączenie z bazą danych PostgreSQL zostało ustanowione pomyślnie');
    client.release();
    return true;
  } catch (err) {
    console.error('Błąd podczas łączenia z bazą danych PostgreSQL:', err);
    return false;
  }
};

// Eksport puli połączeń i funkcji pomocniczych
module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  testConnection
};