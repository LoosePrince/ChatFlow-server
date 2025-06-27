const utils = require('../utils');
const userService = require('../services/userService');

// JWT身份验证中间件
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json(utils.errorResponse('访问令牌不存在'));
    }

    const decoded = utils.verifyToken(token);
    if (!decoded) {
      return res.status(403).json(utils.errorResponse('无效的访问令牌'));
    }

    // 验证用户是否仍然存在且有效
    try {
      if (decoded.type === 'user') {
        const userInfo = await userService.getUserInfo(decoded.uid);
        req.user = {
          ...userInfo,
          type: 'user'
        };
      } else if (decoded.type === 'anonymous') {
        const anonymousInfo = await userService.getAnonymousUserInfo(decoded.uid);
        // 检查匿名用户禁言状态
        const now = Date.now();
        const isMuted = anonymousInfo.muteUntil && now < anonymousInfo.muteUntil;
        
        req.user = {
          ...anonymousInfo,
          type: 'anonymous',
          isMuted,
          muteUntil: anonymousInfo.muteUntil
        };
      } else {
        return res.status(403).json(utils.errorResponse('无效的用户类型'));
      }
    } catch (error) {
      return res.status(403).json(utils.errorResponse('用户不存在或已过期'));
    }

    next();
  } catch (error) {
    console.error('身份验证错误:', error);
    res.status(500).json(utils.errorResponse('身份验证失败'));
  }
};

// 可选身份验证中间件（允许匿名访问）
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      req.user = null;
      return next();
    }

    const decoded = utils.verifyToken(token);
    if (!decoded) {
      req.user = null;
      return next();
    }

    try {
      if (decoded.type === 'user') {
        const userInfo = await userService.getUserInfo(decoded.uid);
        req.user = {
          ...userInfo,
          type: 'user'
        };
      } else if (decoded.type === 'anonymous') {
        const anonymousInfo = await userService.getAnonymousUserInfo(decoded.uid);
        // 检查匿名用户禁言状态
        const now = Date.now();
        const isMuted = anonymousInfo.muteUntil && now < anonymousInfo.muteUntil;
        
        req.user = {
          ...anonymousInfo,
          type: 'anonymous',
          isMuted,
          muteUntil: anonymousInfo.muteUntil
        };
      } else {
        req.user = null;
      }
    } catch (error) {
      req.user = null;
    }

    next();
  } catch (error) {
    console.error('可选身份验证错误:', error);
    req.user = null;
    next();
  }
};

// 管理员权限验证中间件
const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json(utils.errorResponse('需要身份验证'));
  }

  if (req.user.type !== 'user' || !req.user.isAdmin) {
    return res.status(403).json(utils.errorResponse('需要管理员权限'));
  }

  next();
};

// 检查聊天室管理员权限的中间件
const requireChatroomAdmin = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json(utils.errorResponse('需要身份验证'));
    }

    const chatroomId = req.params.roomId || req.body.chatroomId;
    if (!chatroomId) {
      return res.status(400).json(utils.errorResponse('缺少聊天室ID'));
    }

    const chatroomService = require('../services/chatroomService');
    const hasPermission = await chatroomService.checkAdminPermission(req.user.uid, chatroomId);

    if (!hasPermission) {
      return res.status(403).json(utils.errorResponse('需要聊天室管理员权限'));
    }

    req.chatroomId = chatroomId;
    next();
  } catch (error) {
    console.error('聊天室管理员权限检查错误:', error);
    res.status(500).json(utils.errorResponse('权限检查失败'));
  }
};

// 验证请求体数据的中间件工厂
const validateRequest = (validationRules) => {
  return (req, res, next) => {
    const errors = [];

    for (const [field, rules] of Object.entries(validationRules)) {
      const value = req.body[field];

      if (rules.required && (value === undefined || value === null || value === '')) {
        errors.push(`${field} 是必需的`);
        continue;
      }

      if (value !== undefined && value !== null && value !== '') {
        if (rules.type && typeof value !== rules.type) {
          errors.push(`${field} 类型不正确`);
        }

        if (rules.minLength && value.length < rules.minLength) {
          errors.push(`${field} 长度不能少于 ${rules.minLength} 个字符`);
        }

        if (rules.maxLength && value.length > rules.maxLength) {
          errors.push(`${field} 长度不能超过 ${rules.maxLength} 个字符`);
        }

        if (rules.pattern && !rules.pattern.test(value)) {
          errors.push(`${field} 格式不正确`);
        }

        if (rules.custom && !rules.custom(value)) {
          errors.push(`${field} 验证失败`);
        }
      }
    }

    if (errors.length > 0) {
      return res.status(400).json(utils.errorResponse('数据验证失败', { errors }));
    }

    next();
  };
};

// CORS处理中间件
const corsHandler = (req, res, next) => {
  const origin = req.headers.origin;
  
  // 从环境变量获取允许的源，支持多个源用逗号分隔
  const corsOriginEnv = process.env.CORS_ORIGIN || 'http://localhost:5173';
  const configuredOrigins = corsOriginEnv.split(',').map(origin => origin.trim());
  
  // 默认允许的开发环境源
  const defaultAllowedOrigins = [
    'http://localhost:5173',
    'http://localhost:8080',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:8080'
  ];
  
  // 合并配置的源和默认源
  const allowedOrigins = [...new Set([...configuredOrigins, ...defaultAllowedOrigins])];

  // 设置CORS头部
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (!origin) {
    // 如果没有origin头（例如移动应用），允许访问
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Referer, User-Agent, X-CSRF-Token');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400'); // 24小时预检缓存
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type');

  // 处理预检请求
  if (req.method === 'OPTIONS') {
    console.log('Handling CORS preflight request for:', req.url);
    res.status(204).end();
    return;
  }

  next();
};

// 错误处理中间件
const errorHandler = (error, req, res, next) => {
  console.error('API错误:', error);

  if (error.name === 'ValidationError') {
    return res.status(400).json(utils.errorResponse('数据验证错误', { 
      details: error.message 
    }));
  }

  if (error.name === 'UnauthorizedError') {
    return res.status(401).json(utils.errorResponse('未授权访问'));
  }

  if (error.code === 'SQLITE_CONSTRAINT') {
    return res.status(409).json(utils.errorResponse('数据冲突'));
  }

  res.status(500).json(utils.errorResponse('服务器内部错误'));
};

// 检查用户禁言状态中间件
const checkMuteStatus = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json(utils.errorResponse('需要身份验证'));
  }

  // 检查用户是否被禁言
  if (req.user.isMuted) {
    const remaining = utils.getMuteTimeRemaining(req.user.muteUntil);
    if (remaining > 0) {
      return res.status(403).json(utils.errorResponse('您已被禁言，无法发送消息', {
        muteUntil: req.user.muteUntil,
        remaining: remaining
      }));
    }
  }

  next();
};

// 请求日志中间件
const requestLogger = (req, res, next) => {
  const start = Date.now();
  const { method, url, ip } = req;
  const userAgent = req.headers['user-agent'];

  res.on('finish', () => {
    const duration = Date.now() - start;
    const { statusCode } = res;
    
    console.log(`[${new Date().toISOString()}] ${method} ${url} - ${statusCode} - ${duration}ms - ${ip} - ${userAgent}`);
  });

  next();
};

module.exports = {
  authenticateToken,
  optionalAuth,
  requireAdmin,
  requireChatroomAdmin,
  validateRequest,
  corsHandler,
  errorHandler,
  checkMuteStatus,
  requestLogger
}; 