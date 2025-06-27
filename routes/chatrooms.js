const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const chatroomService = require('../services/chatroomService');
const messageService = require('../services/messageService');
const utils = require('../utils');
const { authenticateToken, validateRequest, requireChatroomAdmin, checkMuteStatus } = require('../middleware/auth');

// 配置multer用于图片上传
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../uploads/images');
    // 确保目录存在
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // 生成唯一文件名
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, 'img-' + uniqueSuffix + ext);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 1024 * 1024 // 1MB限制
  },
  fileFilter: function (req, file, cb) {
    // 只允许图片文件
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('只能上传图片文件'));
    }
  }
});

// 创建聊天室
router.post('/',
  authenticateToken,
  validateRequest({
    name: { 
      required: true, 
      type: 'string', 
      minLength: 1, 
      maxLength: 50 
    },
    password: { 
      type: 'string', 
      maxLength: 50 
    }
  }),
  async (req, res) => {
    try {
      // 只有注册用户可以创建聊天室
      if (req.user.type !== 'user') {
        return res.status(403).json(utils.errorResponse('匿名用户无法创建聊天室'));
      }

      const { name, password } = req.body;
      
      const chatroom = await chatroomService.createChatroom(req.user.uid, {
        name,
        password
      });

      // 发送系统消息
      await messageService.sendSystemMessage(
        chatroom.roomId,
        `聊天室 "${name}" 创建成功，欢迎大家！`
      );

      res.status(201).json(utils.successResponse('聊天室创建成功', chatroom));
    } catch (error) {
      console.error('创建聊天室错误:', error);
      res.status(400).json(utils.errorResponse(error.message));
    }
  }
);

// 加入聊天室
router.post('/join',
  validateRequest({
    roomId: { 
      required: true, 
      type: 'string' 
    },
    password: { 
      type: 'string' 
    }
  }),
  async (req, res) => {
    try {
      const { roomId, password } = req.body;
      
      // 如果用户已登录，传递用户UID以便检查是否为创建者
      let userUid = null;
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const token = authHeader.substring(7);
          const decoded = utils.verifyToken(token);
          if (decoded && decoded.type === 'user') {
            userUid = decoded.uid;
          }
        } catch (error) {
          // 忽略token验证错误，继续以匿名方式加入
        }
      }
      
      const chatroom = await chatroomService.joinChatroom(roomId, password, userUid);
      
      res.json(utils.successResponse('加入聊天室成功', chatroom));
    } catch (error) {
      console.error('加入聊天室错误:', error);
      res.status(400).json(utils.errorResponse(error.message));
    }
  }
);

// 获取用户创建的聊天室列表
router.get('/my/rooms',
  authenticateToken,
  async (req, res) => {
    try {
      // 只有注册用户可以查看自己创建的聊天室
      if (req.user.type !== 'user') {
        return res.status(403).json(utils.errorResponse('匿名用户无法查看聊天室列表'));
      }

      const chatrooms = await chatroomService.getUserChatrooms(req.user.uid);
      
      res.json(utils.successResponse('获取聊天室列表成功', chatrooms));
    } catch (error) {
      console.error('获取聊天室列表错误:', error);
      res.status(500).json(utils.errorResponse(error.message));
    }
  }
);

// 获取聊天室信息
router.get('/:roomId',
  async (req, res) => {
    try {
      const { roomId } = req.params;
      
      const chatroomInfo = await chatroomService.getChatroomInfo(roomId);
      
      res.json(utils.successResponse('获取聊天室信息成功', chatroomInfo));
    } catch (error) {
      console.error('获取聊天室信息错误:', error);
      res.status(404).json(utils.errorResponse(error.message));
    }
  }
);

// 获取聊天室成员列表
router.get('/:roomId/members',
  authenticateToken,
  async (req, res) => {
    try {
      const { roomId } = req.params;
      
      const members = await chatroomService.getChatroomMembers(roomId);
      
      res.json(utils.successResponse('获取成员列表成功', members));
    } catch (error) {
      console.error('获取成员列表错误:', error);
      res.status(400).json(utils.errorResponse(error.message));
    }
  }
);

// 更新聊天室名称
router.put('/:roomId/name',
  authenticateToken,
  requireChatroomAdmin,
  validateRequest({
    name: { 
      required: true, 
      type: 'string', 
      minLength: 1, 
      maxLength: 50 
    }
  }),
  async (req, res) => {
    try {
      const { roomId } = req.params;
      const { name } = req.body;
      
      const oldInfo = await chatroomService.getChatroomInfo(roomId);
      const updatedChatroom = await chatroomService.updateChatroomName(
        roomId, 
        name, 
        req.user.uid
      );

      // 发送系统消息
      await messageService.sendSystemMessage(
        roomId,
        `聊天室名称已从 "${oldInfo.name}" 更改为 "${name}"`
      );

      // 通过WebSocket通知房间内所有用户房间名称已更新
      const io = req.app.get('io');
      if (io) {
        io.to(roomId).emit('room-name-updated', {
          roomId: roomId,
          newName: name,
          oldName: oldInfo.name,
          updatedBy: req.user.uid,
          updatedByName: req.user.nickname || '管理员',
          timestamp: Date.now()
        });
      }

      res.json(utils.successResponse('聊天室名称更新成功', updatedChatroom));
    } catch (error) {
      console.error('更新聊天室名称错误:', error);
      res.status(400).json(utils.errorResponse(error.message));
    }
  }
);

// 设置管理员
router.post('/:roomId/admins',
  authenticateToken,
  validateRequest({
    targetUid: { 
      required: true, 
      type: 'string' 
    }
  }),
  async (req, res) => {
    try {
      const { roomId } = req.params;
      const { targetUid } = req.body;
      
      const result = await chatroomService.setAdmin(roomId, targetUid, req.user.uid);

      // 发送系统消息
      await messageService.sendSystemMessage(
        roomId,
        `用户 ${targetUid} 已被设置为管理员`
      );

      res.json(utils.successResponse('管理员设置成功', result));
    } catch (error) {
      console.error('设置管理员错误:', error);
      res.status(400).json(utils.errorResponse(error.message));
    }
  }
);

// 移除管理员
router.delete('/:roomId/admins/:targetUid',
  authenticateToken,
  async (req, res) => {
    try {
      const { roomId, targetUid } = req.params;
      
      const result = await chatroomService.removeAdmin(roomId, targetUid, req.user.uid);

      // 发送系统消息
      await messageService.sendSystemMessage(
        roomId,
        `用户 ${targetUid} 的管理员权限已被移除`
      );

      res.json(utils.successResponse('管理员移除成功', result));
    } catch (error) {
      console.error('移除管理员错误:', error);
      res.status(400).json(utils.errorResponse(error.message));
    }
  }
);

// 获取管理员列表
router.get('/:roomId/admins',
  async (req, res) => {
    try {
      const { roomId } = req.params;
      
      const admins = await chatroomService.getChatroomAdmins(roomId);
      
      res.json(utils.successResponse('获取管理员列表成功', admins));
    } catch (error) {
      console.error('获取管理员列表错误:', error);
      res.status(500).json(utils.errorResponse(error.message));
    }
  }
);

// 设置/取消管理员权限
router.post('/:roomId/admin',
  authenticateToken,
  validateRequest({
    targetUid: { 
      required: true, 
      type: 'string' 
    },
    isAdmin: {
      required: true,
      type: 'boolean'
    }
  }),
  async (req, res) => {
    try {
      const { roomId } = req.params;
      const { targetUid, isAdmin } = req.body;
      
      // 检查是否为房主
      const chatroom = await chatroomService.getChatroomInfo(roomId);
      if (chatroom.creatorUid !== req.user.uid) {
        return res.status(403).json(utils.errorResponse('只有房主可以设置管理员'));
      }
      
      // 不能对自己设置
      if (targetUid === req.user.uid) {
        return res.status(400).json(utils.errorResponse('不能对自己设置管理员权限'));
      }

      let result;
      if (isAdmin) {
        result = await chatroomService.setAdmin(roomId, targetUid, req.user.uid);
      } else {
        result = await chatroomService.removeAdmin(roomId, targetUid, req.user.uid);
      }

      res.json(utils.successResponse(isAdmin ? '管理员设置成功' : '管理员权限移除成功', result));
    } catch (error) {
      console.error('设置管理员错误:', error);
      res.status(400).json(utils.errorResponse(error.message));
    }
  }
);

// 踢出用户
router.post('/:roomId/kick',
  authenticateToken,
  validateRequest({
    targetUid: { 
      required: true, 
      type: 'string' 
    }
  }),
  async (req, res) => {
    try {
      const { roomId } = req.params;
      const { targetUid } = req.body;
      
      // 检查权限（只有房主可以踢人）
      const chatroom = await chatroomService.getChatroomInfo(roomId);
      if (chatroom.creatorUid !== req.user.uid) {
        return res.status(403).json(utils.errorResponse('只有房主可以踢出用户'));
      }
      
      // 不能踢出自己
      if (targetUid === req.user.uid) {
        return res.status(400).json(utils.errorResponse('不能踢出自己'));
      }

      // 踢出用户（等同于强制其退出房间）
      const result = await chatroomService.kickUser(roomId, targetUid, req.user.uid);

              // 通过WebSocket通知被踢用户和其他用户
        const io = req.app.get('io');
        if (io) {
          // 获取被踢用户的完整信息
          const kickedUser = await chatroomService.getUserInfo(targetUid, roomId);
          
          // 通知被踢用户
          io.to(roomId).emit('user-kicked', {
            roomId,
            kickedUid: targetUid,
            kickedUser: kickedUser,
            message: '您已被移出聊天室',
            timestamp: Date.now()
          });
          
          // 更新在线用户列表（不发送user-left事件，避免重复消息）
          const onlineUsers = await chatroomService.getOnlineUsers(roomId);
          io.to(roomId).emit('online-users', {
            users: onlineUsers
          });
        }

      res.json(utils.successResponse('用户已被踢出', result));
    } catch (error) {
      console.error('踢出用户错误:', error);
      res.status(400).json(utils.errorResponse(error.message));
    }
  }
);

// 取消禁言（使用POST方式，与前端保持一致）
router.post('/:roomId/unmute',
  authenticateToken,
  requireChatroomAdmin,
  validateRequest({
    targetUid: { 
      required: true, 
      type: 'string' 
    }
  }),
  async (req, res) => {
    try {
      const { roomId } = req.params;
      const { targetUid } = req.body;
      
      const result = await chatroomService.unmuteUser(roomId, targetUid, req.user.uid);

      // 通过WebSocket通知禁言状态变化
      const io = req.app.get('io');
      if (io) {
        io.to(roomId).emit('user-muted', {
          roomId,
          targetUid,
          isMuted: false,
          muteUntil: null,
          timestamp: Date.now()
        });
      }

      res.json(utils.successResponse('禁言已解除', result));
    } catch (error) {
      console.error('解除禁言错误:', error);
      res.status(400).json(utils.errorResponse(error.message));
    }
  }
);

// 禁言用户
router.post('/:roomId/mute',
  authenticateToken,
  requireChatroomAdmin,
  validateRequest({
    targetUid: { 
      required: true, 
      type: 'string' 
    },
    duration: { 
      type: 'number',
      custom: (value) => value > 0 && value <= 24 * 60 * 60 // 最长24小时（秒）
    },
    reason: { 
      type: 'string',
      maxLength: 200
    }
  }),
  async (req, res) => {
    try {
      const { roomId } = req.params;
      const { targetUid, duration = 3600, reason = '' } = req.body; // 默认1小时（秒）

      const result = await chatroomService.muteUser(
        roomId, 
        targetUid, 
        req.user.uid, 
        duration, 
        reason
      );

      // 通过WebSocket通知禁言状态变化
      const io = req.app.get('io');
      if (io) {
        io.to(roomId).emit('user-muted', {
          roomId,
          targetUid,
          isMuted: true,
          muteUntil: Date.now() + (duration * 1000),
          duration: duration,
          timestamp: Date.now()
        });
      }

      res.json(utils.successResponse('用户已被禁言', result));
    } catch (error) {
      console.error('禁言用户错误:', error);
      res.status(400).json(utils.errorResponse(error.message));
    }
  }
);

// 解除禁言
router.delete('/:roomId/mute/:targetUid',
  authenticateToken,
  requireChatroomAdmin,
  async (req, res) => {
    try {
      const { roomId, targetUid } = req.params;
      
      const result = await chatroomService.unmuteUser(roomId, targetUid, req.user.uid);

      res.json(utils.successResponse('禁言已解除', result));
    } catch (error) {
      console.error('解除禁言错误:', error);
      res.status(400).json(utils.errorResponse(error.message));
    }
  }
);

// 检查用户禁言状态
router.get('/:roomId/mute/:targetUid',
  authenticateToken,
  async (req, res) => {
    try {
      const { roomId, targetUid } = req.params;
      
      const muteStatus = await chatroomService.checkUserMuted(targetUid, roomId);
      
      res.json(utils.successResponse('获取禁言状态成功', muteStatus));
    } catch (error) {
      console.error('检查禁言状态错误:', error);
      res.status(500).json(utils.errorResponse(error.message));
    }
  }
);

// 退出聊天室
router.post('/:roomId/leave',
  authenticateToken,
  async (req, res) => {
    try {
      const { roomId } = req.params;
      
      // 设置用户为已退出状态
      await chatroomService.setMemberLeft(roomId, req.user.uid);

      res.json(utils.successResponse('已退出聊天室', { roomId }));
    } catch (error) {
      console.error('退出聊天室错误:', error);
      res.status(400).json(utils.errorResponse(error.message));
    }
  }
);

// 关闭聊天室
router.delete('/:roomId',
  authenticateToken,
  async (req, res) => {
    try {
      const { roomId } = req.params;
      
      const result = await chatroomService.closeChatroom(roomId, req.user.uid);

      // 发送系统消息
      await messageService.sendSystemMessage(
        roomId,
        '聊天室已被创建者关闭'
      );

      // 通过WebSocket通知所有在线用户房间已解散
      const io = req.app.get('io');
      if (io) {
        io.to(roomId).emit('room-dissolved', {
          roomId,
          message: '聊天室已被创建者解散',
          timestamp: Date.now()
        });
      }

      res.json(utils.successResponse('聊天室已关闭', result));
    } catch (error) {
      console.error('关闭聊天室错误:', error);
      res.status(400).json(utils.errorResponse(error.message));
    }
  }
);

// 获取聊天室消息历史
router.get('/:roomId/messages',
  authenticateToken,
  async (req, res) => {
    try {
      const { roomId } = req.params;
      const limit = parseInt(req.query.limit) || 50;
      const offset = parseInt(req.query.offset) || 0;

      // 限制每次最多获取100条消息
      const actualLimit = Math.min(limit, 100);

      const messages = await messageService.getChatroomMessages(
        roomId,
        req.user.uid,
        req.user.type,
        actualLimit,
        offset
      );

      res.json(utils.successResponse('获取消息历史成功', {
        messages,
        total: messages.length,
        hasMore: messages.length === actualLimit
      }));
    } catch (error) {
      console.error('获取消息历史错误:', error);
      res.status(400).json(utils.errorResponse(error.message));
    }
  }
);

// 搜索消息
router.get('/:roomId/messages/search',
  authenticateToken,
  validateRequest({
    q: { 
      required: true, 
      type: 'string', 
      minLength: 1,
      maxLength: 100
    }
  }),
  async (req, res) => {
    try {
      const { roomId } = req.params;
      const { q: keyword } = req.query;
      const limit = parseInt(req.query.limit) || 20;

      const messages = await messageService.searchMessages(
        roomId,
        keyword,
        req.user.uid,
        req.user.type,
        Math.min(limit, 50)
      );

      res.json(utils.successResponse('搜索消息成功', {
        messages,
        keyword,
        total: messages.length
      }));
    } catch (error) {
      console.error('搜索消息错误:', error);
      res.status(400).json(utils.errorResponse(error.message));
    }
  }
);

// 发送消息
router.post('/:roomId/messages',
  authenticateToken,
  checkMuteStatus,
  validateRequest({
    content: { 
      required: true, 
      type: 'string', 
      minLength: 1,
      maxLength: 1000
    },
    messageType: { 
      type: 'string',
      custom: (value) => ['text', 'system'].includes(value)
    },
    replyToMessageId: {
      type: 'number'
    }
  }),
  async (req, res) => {
    try {
      const { roomId } = req.params;
      const { content, messageType = 'text', replyToMessageId } = req.body;

      const message = await messageService.sendMessage({
        chatroomId: roomId,
        userUid: req.user.uid,
        userType: req.user.type,
        content,
        messageType,
        replyToMessageId
      });

      res.status(201).json(utils.successResponse('消息发送成功', message));
    } catch (error) {
      console.error('发送消息错误:', error);
      res.status(400).json(utils.errorResponse(error.message));
    }
  }
);

// 发送图片消息
router.post('/:roomId/messages/image',
  authenticateToken,
  checkMuteStatus,
  upload.single('image'),
  async (req, res) => {
    try {
      const { roomId } = req.params;
      const { replyToMessageId } = req.body;

      if (!req.file) {
        return res.status(400).json(utils.errorResponse('请选择要上传的图片'));
      }

      // 构建图片URL
      const imageUrl = `/uploads/images/${req.file.filename}`;

      const message = await messageService.sendMessage({
        chatroomId: roomId,
        userUid: req.user.uid,
        userType: req.user.type,
        content: req.body.caption || '', // 图片说明文字（可选）
        messageType: 'image',
        imageUrl: imageUrl,
        replyToMessageId: replyToMessageId ? parseInt(replyToMessageId) : undefined
      });

      // 通过WebSocket广播图片消息给房间内所有用户
      const io = req.app.get('io');
      if (io) {
        io.to(roomId).emit('new-message', message);
      }

      res.status(201).json(utils.successResponse('图片发送成功', message));
    } catch (error) {
      console.error('发送图片错误:', error);
      
      // 如果出错，删除已上传的文件
      if (req.file) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (unlinkError) {
          console.error('删除上传文件失败:', unlinkError);
        }
      }
      
      res.status(400).json(utils.errorResponse(error.message));
    }
  }
);

// 删除消息
router.delete('/:roomId/messages/:messageId',
  authenticateToken,
  async (req, res) => {
    try {
      const { roomId, messageId } = req.params;
      
      const result = await messageService.deleteMessage(
        parseInt(messageId),
        req.user.uid,
        roomId
      );

      // 通过WebSocket通知所有在线用户消息已被删除
      const io = req.app.get('io');
      if (io) {
        io.to(roomId).emit('message-deleted', {
          messageId: parseInt(messageId),
          roomId,
          deletedBy: req.user.uid,
          timestamp: Date.now()
        });
      }

      res.json(utils.successResponse('消息删除成功', result));
    } catch (error) {
      console.error('删除消息错误:', error);
      res.status(400).json(utils.errorResponse(error.message));
    }
  }
);

// 批量删除用户消息
router.delete('/:roomId/messages/user/:targetUid',
  authenticateToken,
  requireChatroomAdmin,
  async (req, res) => {
    try {
      const { roomId, targetUid } = req.params;
      
      const result = await messageService.deleteUserMessages(
        targetUid,
        roomId,
        req.user.uid
      );

      res.json(utils.successResponse('批量删除消息成功', result));
    } catch (error) {
      console.error('批量删除消息错误:', error);
      res.status(400).json(utils.errorResponse(error.message));
    }
  }
);

// 发送B站视频消息
router.post('/:roomId/messages/bilibili',
  authenticateToken,
  checkMuteStatus,
  validateRequest({
    bilibiliId: { 
      required: true, 
      type: 'string',
      custom: (value) => /^BV[a-zA-Z0-9]{10}$/.test(value)
    },
    replyToMessageId: {
      type: 'number'
    }
  }),
  async (req, res) => {
    try {
      const { roomId } = req.params;
      const { bilibiliId, replyToMessageId } = req.body;

      const message = await messageService.sendMessage({
        chatroomId: roomId,
        userUid: req.user.uid,
        userType: req.user.type,
        content: '', // B站视频不需要描述
        messageType: 'bilibili',
        bilibiliId: bilibiliId,
        replyToMessageId: replyToMessageId ? parseInt(replyToMessageId) : undefined
      });

      // 通过WebSocket广播消息给房间内所有用户
      const io = req.app.get('io');
      if (io) {
        io.to(roomId).emit('new-message', message);
      }

      res.status(201).json(utils.successResponse('B站视频发送成功', message));
    } catch (error) {
      console.error('发送B站视频错误:', error);
      res.status(400).json(utils.errorResponse(error.message));
    }
  }
);

// 发送Markdown消息
router.post('/:roomId/messages/markdown',
  authenticateToken,
  checkMuteStatus,
  validateRequest({
    markdownContent: { 
      required: true, 
      type: 'string',
      minLength: 1,
      maxLength: 5000
    },
    title: { 
      type: 'string',
      maxLength: 100
    },
    replyToMessageId: {
      type: 'number'
    }
  }),
  async (req, res) => {
    try {
      const { roomId } = req.params;
      const { markdownContent, title = '', replyToMessageId } = req.body;

      const message = await messageService.sendMessage({
        chatroomId: roomId,
        userUid: req.user.uid,
        userType: req.user.type,
        content: title,
        messageType: 'markdown',
        markdownContent: markdownContent,
        replyToMessageId: replyToMessageId ? parseInt(replyToMessageId) : undefined
      });

      // 通过WebSocket广播消息给房间内所有用户
      const io = req.app.get('io');
      if (io) {
        io.to(roomId).emit('new-message', message);
      }

      res.status(201).json(utils.successResponse('Markdown消息发送成功', message));
    } catch (error) {
      console.error('发送Markdown消息错误:', error);
      res.status(400).json(utils.errorResponse(error.message));
    }
  }
);

// 发送文件消息
router.post('/:roomId/messages/file',
  authenticateToken,
  checkMuteStatus,
  validateRequest({
    fileId: { 
      required: true, 
      type: 'string'
    },
    fileName: { 
      required: true, 
      type: 'string'
    },
    fileSize: { 
      required: true, 
      type: 'number'
    },
    replyToMessageId: {
      type: 'number'
    }
  }),
  async (req, res) => {
    try {
      const { roomId } = req.params;
      const { fileId, fileName, fileSize, replyToMessageId } = req.body;

      // 验证文件是否存在且属于当前用户
      const database = require('../database');
      const file = await database.get(
        'SELECT * FROM files WHERE file_id = ? AND uploader_uid = ? AND chatroom_id = ? AND is_expired = 0',
        [fileId, req.user.uid, roomId]
      );

      if (!file) {
        return res.status(404).json(utils.errorResponse('文件不存在或已过期'));
      }

      // 检查文件是否过期
      if (Date.now() > file.expiry_time) {
        await database.run('UPDATE files SET is_expired = 1 WHERE file_id = ?', [fileId]);
        return res.status(410).json(utils.errorResponse('文件已过期'));
      }

      const message = await messageService.sendMessage({
        chatroomId: roomId,
        userUid: req.user.uid,
        userType: req.user.type,
        content: fileName, // 文件名作为消息内容
        messageType: 'file',
        fileId: fileId,
        fileName: fileName,
        fileSize: fileSize,
        fileExpiry: file.expiry_time,
        replyToMessageId: replyToMessageId ? parseInt(replyToMessageId) : undefined
      });

      // 更新文件记录的消息ID
      await database.run(
        'UPDATE files SET message_id = ? WHERE file_id = ?',
        [message.messageId, fileId]
      );

      // 通过WebSocket广播文件消息给房间内所有用户
      const io = req.app.get('io');
      if (io) {
        io.to(roomId).emit('new-message', message);
      }

      res.status(201).json(utils.successResponse('文件发送成功', message));
    } catch (error) {
      console.error('发送文件消息错误:', error);
      res.status(400).json(utils.errorResponse(error.message));
    }
  }
);

module.exports = router; 