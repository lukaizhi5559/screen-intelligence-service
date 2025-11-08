import logger from '../utils/logger.js';

const metrics = {
  requestCount: 0,
  errorCount: 0,
  totalResponseTime: 0,
  requestsByAction: {}
};

const metricsMiddleware = (req, res, next) => {
  const startTime = Date.now();
  
  metrics.requestCount++;

  // Capture response
  const originalSend = res.send;
  res.send = function (data) {
    const responseTime = Date.now() - startTime;
    metrics.totalResponseTime += responseTime;

    // Track by action
    const action = req.body?.action || req.path;
    if (!metrics.requestsByAction[action]) {
      metrics.requestsByAction[action] = { count: 0, totalTime: 0 };
    }
    metrics.requestsByAction[action].count++;
    metrics.requestsByAction[action].totalTime += responseTime;

    // Track errors
    if (res.statusCode >= 400) {
      metrics.errorCount++;
    }

    logger.debug('Request completed', {
      method: req.method,
      path: req.path,
      action,
      statusCode: res.statusCode,
      responseTime: `${responseTime}ms`
    });

    originalSend.call(this, data);
  };

  next();
};

export const getMetrics = () => {
  return {
    requestCount: metrics.requestCount,
    errorCount: metrics.errorCount,
    errorRate: metrics.requestCount > 0 
      ? (metrics.errorCount / metrics.requestCount * 100).toFixed(2) + '%'
      : '0%',
    avgResponseTime: metrics.requestCount > 0
      ? Math.round(metrics.totalResponseTime / metrics.requestCount)
      : 0,
    requestsByAction: metrics.requestsByAction
  };
};

export default metricsMiddleware;
