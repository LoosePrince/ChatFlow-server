// 加载环境变量 - 必须在所有其他require之前
require('dotenv').config();

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const database = require('./database');
const config = require('./config');
const utils = require('./utils');

// 中间件
const { 
  corsHandler, 
  errorHandler, 
  requestLogger,
  authenticateToken 
} = require('./middleware/auth');

// 路由
const authRoutes = require('./routes/auth');
const chatroomRoutes = require('./routes/chatrooms');
const fileRoutes = require('./routes/files');
const bilibiliRoutes = require('./routes/bilibili');

// 服务
const userService = require('./services/userService');
const messageService = require('./services/messageService');
const chatroomService = require('./services/chatroomService');

class ChatroomServer {
  constructor() {
    this.app = express();
    this.server = http.createServer(this.app);
    this.io = socketIo(this.server, {
      cors: {
        origin: function(origin, callback) {
          // 从环境变量获取允许的源
          const corsOriginEnv = process.env.CORS_ORIGIN || 'http://localhost:5173';
          const allowedOrigins = corsOriginEnv.split(',').map(origin => origin.trim());
          
          // 添加默认开发环境源
          allowedOrigins.push('http://localhost:5173', 'http://localhost:8080', 'http://localhost:3000');
          
          // 如果没有origin（移动应用等），允许访问
          if (!origin) return callback(null, true);
          
          if (allowedOrigins.includes(origin)) {
            callback(null, true);
          } else {
            console.log('Socket.IO CORS rejected origin:', origin);
            callback(new Error('Not allowed by CORS'));
          }
        },
        methods: ["GET", "POST"],
        credentials: true
      }
    });
    
    // 存储在线用户
    this.onlineUsers = new Map(); // roomId -> Set of users
    this.userSockets = new Map(); // userId -> socket
    
    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
    this.setupCleanupTasks();
    
    // 将io实例设置到app中，供路由使用
    this.app.set('io', this.io);
  }

  // 设置中间件
  setupMiddleware() {
    // 安全中间件
    this.app.use(helmet({
      crossOriginResourcePolicy: false
    }));

    // CORS
    this.app.use(corsHandler);

    // 请求日志
    this.app.use(requestLogger);

    // 限流
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15分钟
      max: 1000, // 每个IP最多1000个请求
      message: utils.errorResponse('请求过于频繁，请稍后再试'),
      standardHeaders: true,
      legacyHeaders: false,
    });
    this.app.use(limiter);

    // API限流（更严格）
    const apiLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 500,
      message: utils.errorResponse('API请求过于频繁'),
    });
    this.app.use('/api/', apiLimiter);

    // 消息发送限流
    const messageLimiter = rateLimit({
      windowMs: 60 * 1000, // 1分钟
      max: 60, // 每分钟最多60条消息
      message: utils.errorResponse('发送消息过于频繁'),
      keyGenerator: (req) => {
        return req.user ? req.user.uid : req.ip;
      }
    });

    // 解析JSON
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // 静态文件服务
    this.app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
    
    // 前端静态文件（生产环境）
    // 只有在前端构建文件存在时才提供静态文件服务
    const frontendDistPath = path.join(__dirname, '../client/dist');
    if (process.env.NODE_ENV === 'production' && fs.existsSync(frontendDistPath)) {
      this.app.use(express.static(frontendDistPath));
    }

    // 应用消息限流到聊天室消息路由
    this.app.use('/api/chatrooms/:roomId/messages', authenticateToken, messageLimiter);
  }

  // 设置路由
  setupRoutes() {
    // API路由
    this.app.use('/api/auth', authRoutes);
    this.app.use('/api/chatrooms', chatroomRoutes);
    this.app.use('/api/files', fileRoutes);
    this.app.use('/api/bilibili', bilibiliRoutes);

    // 头像静态文件服务 - 支持多种格式
    this.app.get('/avatars/:uid', (req, res) => {
      const { uid } = req.params;
      
      // 支持的文件扩展名，按优先级排序
      const extensions = ['png', 'jpg', 'jpeg', 'webp'];
      let avatarPath = null;
      
      // 查找存在的头像文件
      for (const ext of extensions) {
        const testPath = path.join(__dirname, 'uploads', 'avatars', `${uid}.${ext}`);
        if (fs.existsSync(testPath)) {
          avatarPath = testPath;
          break;
        }
      }
      
      if (avatarPath) {
        // 设置缓存头
        res.set({
          'Cache-Control': 'public, max-age=86400', // 24小时缓存
          'ETag': `"${uid}-${fs.statSync(avatarPath).mtime.getTime()}"`
        });
        res.sendFile(avatarPath);
      } else {
        // 返回默认头像
        const defaultAvatarPath = path.join(__dirname, 'avatar.jpg');
        if (fs.existsSync(defaultAvatarPath)) {
          res.set({
            'Cache-Control': 'public, max-age=86400'
          });
          res.sendFile(defaultAvatarPath);
        } else {
          res.status(404).json(utils.errorResponse('头像不存在'));
        }
      }
    });

    // 健康检查
    this.app.get('/api/health', (req, res) => {
      res.json(utils.successResponse('服务器运行正常', {
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        version: '1.0.0'
      }));
    });

    // 获取服务器状态
    this.app.get('/api/stats', (req, res) => {
      const stats = {
        onlineUsers: this.getTotalOnlineUsers(),
        activeRooms: this.onlineUsers.size,
        uptime: process.uptime()
      };
      res.json(utils.successResponse('获取统计信息成功', stats));
    });

    // 404处理
    this.app.use('/api/*', (req, res) => {
      res.status(404).json(utils.errorResponse('API端点不存在'));
    });

    // 前端路由（生产环境）
    // 只有在前端构建文件存在时才提供前端路由
    const frontendIndexPath = path.join(__dirname, '../client/dist/index.html');
    if (process.env.NODE_ENV === 'production' && fs.existsSync(frontendIndexPath)) {
      this.app.get('*', (req, res) => {
        res.sendFile(frontendIndexPath);
      });
    } else {
      // 开发环境下，为根路径提供简单的API状态页面
      this.app.get('/', (req, res) => {
        res.json(utils.successResponse('ChatFlow API 服务器运行中', {
          message: '这是后端API服务器，前端请访问前端开发服务器',
          apiEndpoints: [
            'GET /api/health - 健康检查',
            'GET /api/stats - 服务器统计',
            'POST /api/auth/login - 用户登录',
            'POST /api/auth/register - 用户注册',
            'GET /api/chatrooms - 获取聊天室列表'
          ],
          timestamp: new Date().toISOString()
        }));
      });
    }

    // 错误处理中间件
    this.app.use(errorHandler);
  }

  // 设置WebSocket
  setupWebSocket() {
    // Socket.IO身份验证中间件
    this.io.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth.token;
        if (!token) {
          return next(new Error('认证失败：缺少令牌'));
        }

        const decoded = utils.verifyToken(token);
        if (!decoded) {
          return next(new Error('认证失败：无效令牌'));
        }

        // 获取用户信息
        try {
          if (decoded.type === 'user') {
            const userInfo = await userService.getUserInfo(decoded.uid);
            socket.user = { ...userInfo, type: 'user' };
          } else if (decoded.type === 'anonymous') {
            const anonymousInfo = await userService.getAnonymousUserInfo(decoded.uid);
            socket.user = { ...anonymousInfo, type: 'anonymous' };
          } else {
            return next(new Error('认证失败：无效用户类型'));
          }
        } catch (error) {
          return next(new Error('认证失败：用户不存在或已过期'));
        }

        next();
      } catch (error) {
        console.error('Socket认证错误:', error);
        next(new Error('认证失败'));
      }
    });

    // 连接事件
    this.io.on('connection', (socket) => {
      console.log(`用户连接: ${socket.user.uid} (${socket.user.nickname})`);
      
      // 存储用户socket
      this.userSockets.set(socket.user.uid, socket);

      // 加入聊天室
      socket.on('join-room', async (data) => {
        try {
          const { roomId } = data;
          
          // 验证聊天室
          const chatroomInfo = await chatroomService.getChatroomInfo(roomId);
          
          // 加入Socket.IO房间
          socket.join(roomId);
          socket.currentRoom = roomId;

          // 添加用户到聊天室成员表
          await chatroomService.addMemberToChatroom(
            roomId, 
            socket.user.uid, 
            socket.user.type, 
            socket.user.nickname, 
            socket.user.avatarUrl
          );

          // 更新在线用户列表
          if (!this.onlineUsers.has(roomId)) {
            this.onlineUsers.set(roomId, new Set());
          }
          this.onlineUsers.get(roomId).add(socket.user.uid);

          // 获取在线用户列表（在添加用户后获取）
          const onlineUserList = await this.getOnlineUserList(roomId);

          // 通知其他用户有新用户加入
          socket.to(roomId).emit('user-joined', {
            user: {
              uid: socket.user.uid,
              nickname: socket.user.nickname,
              avatarUrl: socket.user.avatarUrl,
              type: socket.user.type
            },
            onlineUsers: onlineUserList,
            timestamp: Date.now()
          });

          // 不再发送系统消息到数据库，只通过临时通知显示

          socket.emit('room-joined', {
            roomId,
            roomInfo: chatroomInfo,
            onlineUsers: onlineUserList,
            timestamp: Date.now()
          });

        } catch (error) {
          console.error('加入房间错误:', error);
          socket.emit('error', { message: error.message });
        }
      });

      // 发送消息
      socket.on('send-message', async (data) => {
        try {
          const { content, roomId, replyToMessageId } = data;
          
          if (!socket.currentRoom || socket.currentRoom !== roomId) {
            socket.emit('error', { message: '请先加入聊天室' });
            return;
          }

          // 更新用户活跃时间
          await chatroomService.updateMemberActivity(roomId, socket.user.uid);

          const message = await messageService.sendMessage({
            chatroomId: roomId,
            userUid: socket.user.uid,
            userType: socket.user.type,
            content,
            replyToMessageId
          });

          // 广播消息给房间内所有用户
          this.io.to(roomId).emit('new-message', message);

        } catch (error) {
          console.error('发送消息错误:', error);
          socket.emit('error', { message: error.message });
        }
      });

      // 用户开始输入
      socket.on('typing-start', (data) => {
        const { roomId } = data;
        if (socket.currentRoom === roomId) {
          socket.to(roomId).emit('user-typing', {
            uid: socket.user.uid,
            nickname: socket.user.nickname,
            isTyping: true
          });
        }
      });

      // 用户停止输入
      socket.on('typing-stop', (data) => {
        const { roomId } = data;
        if (socket.currentRoom === roomId) {
          socket.to(roomId).emit('user-typing', {
            uid: socket.user.uid,
            nickname: socket.user.nickname,
            isTyping: false
          });
        }
      });

      // 离开聊天室
      socket.on('leave-room', () => {
        this.handleUserLeaveRoom(socket);
      });

      // 断开连接
      socket.on('disconnect', () => {
        console.log(`用户断开连接: ${socket.user.uid} (${socket.user.nickname})`);
        this.handleUserLeaveRoom(socket);
        this.userSockets.delete(socket.user.uid);
      });

      // 获取在线用户列表
      socket.on('get-online-users', async (data) => {
        try {
          const { roomId } = data;
          const onlineUserList = await this.getOnlineUserList(roomId);
          socket.emit('online-users', onlineUserList);
        } catch (error) {
          console.error('获取在线用户错误:', error);
          socket.emit('error', { message: '获取在线用户失败' });
        }
      });
    });
  }

  // 处理用户离开聊天室
  async handleUserLeaveRoom(socket) {
    if (socket.currentRoom) {
      const roomId = socket.currentRoom;
      
      // 设置用户为离线状态
      await chatroomService.setMemberOffline(roomId, socket.user.uid);
      
      // 从在线用户列表移除
      if (this.onlineUsers.has(roomId)) {
        this.onlineUsers.get(roomId).delete(socket.user.uid);
        
        // 如果房间没有用户了，删除房间记录
        if (this.onlineUsers.get(roomId).size === 0) {
          this.onlineUsers.delete(roomId);
        }
      }

      // 获取更新后的在线用户列表
      const onlineUserList = await this.getOnlineUserList(roomId);
      
      // 通知其他用户
      socket.to(roomId).emit('user-left', {
        user: {
          uid: socket.user.uid,
          nickname: socket.user.nickname
        },
        onlineUsers: onlineUserList,
        timestamp: Date.now()
      });

      // 不再发送系统消息到数据库，只通过临时通知显示

      // 离开Socket.IO房间
      socket.leave(roomId);
      socket.currentRoom = null;
    }
  }

  // 获取在线用户列表
  async getOnlineUserList(roomId) {
    const userList = [];
    const onlineUserIds = this.onlineUsers.get(roomId);
    
    if (onlineUserIds) {
      for (const uid of onlineUserIds) {
        const socket = this.userSockets.get(uid);
        if (socket && socket.user) {
          // 检查是否为管理员
          const isAdmin = await chatroomService.checkAdminPermission(uid, roomId);
          
          // 检查是否被禁言
          const muteStatus = await chatroomService.checkUserMuted(uid, roomId);
          
          // 检查是否为创建者
          const chatroomInfo = await chatroomService.getChatroomInfo(roomId);
          const isCreator = chatroomInfo.creatorUid === uid;
          
          userList.push({
            uid: socket.user.uid,
            nickname: socket.user.nickname,
            avatarUrl: socket.user.avatarUrl,
            type: socket.user.type,
            isAdmin,
            isCreator,
            isMuted: muteStatus.isMuted,
            muteUntil: muteStatus.muteUntil
          });
        }
      }
    }
    
    return userList;
  }

  // 获取总在线用户数
  getTotalOnlineUsers() {
    let total = 0;
    for (const users of this.onlineUsers.values()) {
      total += users.size;
    }
    return total;
  }

  // 设置清理任务
  setupCleanupTasks() {
    // 每小时清理过期匿名用户
    setInterval(async () => {
      try {
        await userService.cleanupExpiredAnonymousUsers();
      } catch (error) {
        console.error('清理过期匿名用户错误:', error);
      }
    }, 60 * 60 * 1000);

    // 每天清理旧消息
    setInterval(async () => {
      try {
        await messageService.cleanupOldMessages(30); // 保留30天
      } catch (error) {
        console.error('清理旧消息错误:', error);
      }
    }, 24 * 60 * 60 * 1000);
  }

  // 启动服务器
  async start() {
    try {
      // 初始化SQLite数据库
      console.log('正在初始化数据库...');
      await database.initialize();
      console.log('数据库已就绪');
      
      // 启动服务器
      this.server.listen(config.port, () => {
        console.log(`ChatFlow 服务器启动成功！`);
        console.log(`HTTP服务器运行在: http://localhost:${config.port}`);
        console.log(`WebSocket服务运行在: ws://localhost:${config.port}`);
        console.log(`环境: ${process.env.NODE_ENV || 'development'}`);
      });

      // 优雅关闭
      process.on('SIGTERM', () => this.shutdown());
      process.on('SIGINT', () => this.shutdown());

    } catch (error) {
      console.error('服务器启动失败:', error);
      process.exit(1);
    }
  }

  // 优雅关闭服务器
  async shutdown() {
    console.log('正在关闭服务器...');
    
    try {
      // 关闭Socket.IO
      this.io.close();
      
      // 关闭HTTP服务器
      this.server.close(() => {
        console.log('HTTP服务器已关闭');
      });

      // 关闭数据库连接
      await database.close();
      
      console.log('服务器已优雅关闭');
      process.exit(0);
    } catch (error) {
      console.error('关闭服务器时出错:', error);
      process.exit(1);
    }
  }
}

// 创建并启动服务器
const server = new ChatroomServer();
server.start();

module.exports = server; 