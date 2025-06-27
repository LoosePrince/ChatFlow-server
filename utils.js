const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('./config');

class Utils {
  // 生成8位16进制聊天室ID
  generateRoomId() {
    return crypto.randomBytes(4).toString('hex').toUpperCase();
  }

  // 生成8位16进制用户UID
  generateUserUID() {
    return crypto.randomBytes(4).toString('hex').toUpperCase();
  }

  // 生成16位匿名用户UID（数字+字母）
  generateAnonymousUID() {
    const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let result = '';
    for (let i = 0; i < config.anonymous.uidLength; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  // 生成消息ID
  generateMessageId() {
    return crypto.randomUUID();
  }

  // 哈希密码
  async hashPassword(password) {
    const saltRounds = 12;
    return await bcrypt.hash(password, saltRounds);
  }

  // 验证密码
  async verifyPassword(password, hash) {
    return await bcrypt.compare(password, hash);
  }

  // 生成JWT令牌
  generateToken(payload) {
    return jwt.sign(payload, config.jwtSecret, { 
      expiresIn: '24h',
      issuer: 'chatroom-server'
    });
  }

  // 验证JWT令牌
  verifyToken(token) {
    try {
      return jwt.verify(token, config.jwtSecret);
    } catch (error) {
      return null;
    }
  }

  // 验证邮箱格式
  isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  // 验证昵称格式
  isValidNickname(nickname) {
    if (!nickname || typeof nickname !== 'string') return false;
    const trimmed = nickname.trim();
    return trimmed.length >= 1 && trimmed.length <= 20;
  }

  // 验证密码强度
  isValidPassword(password) {
    if (!password || typeof password !== 'string') return false;
    return password.length >= 6 && password.length <= 50;
  }

  // 验证聊天室名称
  isValidRoomName(name) {
    if (!name || typeof name !== 'string') return false;
    const trimmed = name.trim();
    return trimmed.length >= 1 && trimmed.length <= config.chatroom.maxNameLength;
  }

  // 生成默认头像URL
  generateDefaultAvatar(nickname) {
    const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8'];
    const color = colors[nickname.charCodeAt(0) % colors.length];
    const initial = nickname.charAt(0).toUpperCase();
    
    // 返回一个基于用户名首字母的默认头像URL
    return `data:image/svg+xml;base64,${Buffer.from(`
      <svg width="64" height="64" xmlns="http://www.w3.org/2000/svg">
        <rect width="64" height="64" fill="${color}"/>
        <text x="32" y="40" font-family="Arial, sans-serif" font-size="24" 
              font-weight="bold" fill="white" text-anchor="middle">${initial}</text>
      </svg>
    `).toString('base64')}`;
  }

  // 清理HTML标签，防止XSS
  sanitizeText(text) {
    if (!text || typeof text !== 'string') return '';
    return text
      .trim()
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/\//g, '&#x2F;');
  }

  // 格式化时间戳
  formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    
    // 小于1分钟
    if (diff < 60000) {
      return '刚刚';
    }
    
    // 小于1小时
    if (diff < 3600000) {
      return `${Math.floor(diff / 60000)}分钟前`;
    }
    
    // 小于24小时
    if (diff < 86400000) {
      return `${Math.floor(diff / 3600000)}小时前`;
    }
    
    // 超过24小时显示具体时间
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  // 检查用户是否被禁言
  isUserMuted(muteUntil) {
    if (!muteUntil) return false;
    return new Date(muteUntil) > new Date();
  }

  // 计算禁言剩余时间
  getMuteTimeRemaining(muteUntil) {
    if (!muteUntil) return 0;
    const remaining = new Date(muteUntil) - new Date();
    return Math.max(0, remaining);
  }

  // 验证文件类型
  isValidFileType(mimetype) {
    return config.avatar.allowedTypes.includes(mimetype);
  }

  // 验证图片buffer
  async validateImageBuffer(buffer) {
    try {
      // 简单的图片格式验证（检查文件头）
      const signatures = {
        'image/jpeg': [0xFF, 0xD8, 0xFF],
        'image/png': [0x89, 0x50, 0x4E, 0x47],
        'image/webp': [0x52, 0x49, 0x46, 0x46] // RIFF header
      };

      // 检查文件头
      let detectedType = null;
      for (const [type, signature] of Object.entries(signatures)) {
        if (signature.every((byte, index) => buffer[index] === byte)) {
          detectedType = type;
          break;
        }
      }

      if (!detectedType) {
        throw new Error('无效的图片格式');
      }

      // 检查文件大小
      if (buffer.length > config.avatar.maxSize) {
        throw new Error('图片文件过大');
      }

      // 检查最小文件大小（防止恶意文件）
      if (buffer.length < 100) {
        throw new Error('图片文件太小');
      }

      return {
        isValid: true,
        detectedType,
        fileSize: buffer.length
      };
    } catch (error) {
      return {
        isValid: false,
        error: error.message
      };
    }
  }

  // 生成文件名
  generateFileName(originalName, uid) {
    const ext = originalName.split('.').pop();
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex');
    return `${uid}_${timestamp}_${random}.${ext}`;
  }

  // 响应格式化
  formatResponse(success, message, data = null) {
    return {
      success,
      message,
      data,
      timestamp: new Date().toISOString()
    };
  }

  // 成功响应
  successResponse(message, data = null) {
    return this.formatResponse(true, message, data);
  }

  // 错误响应
  errorResponse(message, data = null) {
    return this.formatResponse(false, message, data);
  }
}

module.exports = new Utils(); 