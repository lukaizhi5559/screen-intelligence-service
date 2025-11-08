import logger from '../utils/logger.js';

export const validatePayloadSize = (req, res, next) => {
  const maxSize = 1024 * 1024; // 1MB
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);

  if (contentLength > maxSize) {
    logger.warn('Payload too large', {
      size: contentLength,
      maxSize,
      ip: req.ip
    });
    return res.status(413).json({
      error: 'Payload too large',
      message: `Maximum payload size is ${maxSize} bytes`
    });
  }

  next();
};

export const validateMCPRequest = (req, res, next) => {
  const { action, params } = req.body;

  if (!action) {
    return res.status(400).json({
      error: 'Bad request',
      message: 'Action is required'
    });
  }

  if (params && typeof params !== 'object') {
    return res.status(400).json({
      error: 'Bad request',
      message: 'Params must be an object'
    });
  }

  next();
};
