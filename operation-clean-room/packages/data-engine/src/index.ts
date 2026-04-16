import express from 'express';
import cors from 'cors';
import { registerRoutes } from './routes/index.js';
import { getData } from './data/singleton.js';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(
  cors({
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
    credentials: true,
  }),
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------------------
// Request logging (lightweight, no external dependency)
// ---------------------------------------------------------------------------

app.use((req, _res, next) => {
  const start = Date.now();
  _res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${_res.statusCode} ${duration}ms`,
    );
  });
  next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

registerRoutes(app);

// Eagerly load data at startup
getData()
  .then(() => {
    console.log('[startup] Data loaded, server fully ready');
  })
  .catch((err) => {
    console.error('[startup] Failed to load data:', err);
  });

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error('[ERROR]', err.message, err.stack);
    res.status(500).json({
      error: 'Internal Server Error',
      message:
        process.env.NODE_ENV === 'production'
          ? 'An unexpected error occurred'
          : err.message,
    });
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`
  ┌─────────────────────────────────────────┐
  │  @clean-room/data-engine                │
  │  Server running on http://localhost:${PORT} │
  │  Environment: ${process.env.NODE_ENV ?? 'development'}              │
  └─────────────────────────────────────────┘
  `);
});

export { app };
