import logger from '../utils/logger.js';

const errorHandler = (err, req, res, next) => {
  logger.error('Error handler caught exception', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method
  });

  // Don't leak error details in production
  const isDev = process.env.NODE_ENV !== 'production';

  res.status(err.status || 500).json({
    error: err.name || 'Internal Server Error',
    message: isDev ? err.message : 'An error occurred',
    ...(isDev && { stack: err.stack })
  });
};

export default errorHandler;
