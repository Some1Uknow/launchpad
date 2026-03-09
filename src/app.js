const express = require('express');

const healthRoutes = require('./routes/health');
const authRoutes = require('./routes/auth');
const launchesRoutes = require('./routes/launches');

const app = express();

app.use(express.json());

app.use('/api', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/launches', launchesRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  console.error(error);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
