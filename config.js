// 应用配置文件
module.exports = {
  port: process.env.PORT || 3000,
  jwtSecret: process.env.JWT_SECRET || 'chatroom_secret_key_change_in_production',
  dbPath: process.env.DB_PATH || './database.sqlite',
  uploadPath: process.env.UPLOAD_PATH || './uploads',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  
  // 头像配置
  avatar: {
    maxSize: parseInt(process.env.AVATAR_MAX_SIZE) || 50 * 1024, // 50kb
    width: parseInt(process.env.AVATAR_WIDTH) || 64,
    height: parseInt(process.env.AVATAR_HEIGHT) || 64,
    allowedTypes: process.env.AVATAR_ALLOWED_TYPES ? 
      process.env.AVATAR_ALLOWED_TYPES.split(',') : 
      ['image/jpeg', 'image/png', 'image/webp']
  },
  
  // 匿名用户配置
  anonymous: {
    muteDuration: parseInt(process.env.ANONYMOUS_MUTE_DURATION) || 10 * 60 * 1000, // 10分钟
    sessionExpiry: parseInt(process.env.ANONYMOUS_SESSION_EXPIRY) || 24 * 60 * 60 * 1000, // 24小时
    uidLength: parseInt(process.env.ANONYMOUS_UID_LENGTH) || 16
  },
  
  // 用户配置
  user: {
    uidStart: parseInt(process.env.USER_UID_START) || 10000000,
    uidLength: parseInt(process.env.USER_UID_LENGTH) || 8
  },
  
  // 聊天室配置
  chatroom: {
    idLength: parseInt(process.env.CHATROOM_ID_LENGTH) || 8,
    maxNameLength: parseInt(process.env.CHATROOM_MAX_NAME_LENGTH) || 50,
    maxPasswordLength: parseInt(process.env.CHATROOM_MAX_PASSWORD_LENGTH) || 50
  }
}; 