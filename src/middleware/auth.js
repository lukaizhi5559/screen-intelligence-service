import logger from '../utils/logger.js';

const authMiddleware = (req, res, next) => {
  console.log('🔐 [AUTH] Middleware hit:', req.method, req.path);
  logger.info('🔐 [AUTH] Middleware hit:', { path: req.path, method: req.method });
  try {
    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    console.log('🔐 [AUTH] API key present:', !!apiKey);
    logger.info('🔐 [AUTH] API key present:', !!apiKey);
    
    if (!apiKey) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'API key required'
      });
    }

    // Validate API key
    const validApiKey = process.env.API_KEY || 'dev-api-key-screen-intelligence';
    
    if (apiKey !== validApiKey) {
      logger.warn('Invalid API key attempt', {
        ip: req.ip,
        path: req.path
      });
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid API key'
      });
    }

    next();
  } catch (error) {
    logger.error('Auth middleware error', { error: error.message });
    res.status(500).json({
      error: 'Internal server error',
      message: 'Authentication failed'
    });
  }
};

export default authMiddleware;
