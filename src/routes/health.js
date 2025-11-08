import express from 'express';
import logger from '../utils/logger.js';
import { getMetrics } from '../middleware/metrics.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const metrics = getMetrics();
    const platform = process.platform;

    res.json({
      status: 'healthy',
      service: 'screen-intelligence',
      version: '1.0.0',
      uptime: process.uptime(),
      platform,
      metrics,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Health check failed', { error: error.message });
    res.status(503).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

export default router;
