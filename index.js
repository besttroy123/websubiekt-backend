const express = require('express');
const cors = require('cors');
require('dotenv').config();
const db = require('./db'); // Importowanie modułu db.js

// Import routes
const pingRoutes = require('./routes/ping');
const inventoryRoutes = require('./routes/inventory');
const salesReportRouter = require('./routes/sales-report');
const apiSettingsRouter = require('./routes/api-settings');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Register API routes
app.use('/api/ping', pingRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/sales-report', salesReportRouter);
app.use('/api-settings', apiSettingsRouter);

// Testowanie połączenia z bazą danych przed uruchomieniem serwera
db.testConnection()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Nie można uruchomić serwera z powodu błędu bazy danych:', err);
  });
