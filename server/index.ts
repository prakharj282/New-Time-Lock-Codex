import express from 'express';
import path from 'path';
import app, { ensureDatabaseInitialized } from './app';

const distPath = path.resolve(__dirname, '..', 'dist');
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.static(distPath));
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

ensureDatabaseInitialized()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize server:', err);
    process.exit(1);
  });
