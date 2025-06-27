const express = require('express');
const multer = require('multer');
// const sharp = require('sharp'); // 暂时移除Sharp依赖
const path = require('path');
const fs = require('fs').promises;
const router = express.Router();

const userService = require('../services/userService');
const utils = require('../utils');
const config = require('../config');
const { validateRequest, authenticateToken } = require('../middleware/auth');

// 配置头像上传
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: config.avatar.maxSize, // 50kb 限制
    files: 1, // 只允许一个文件
    fields: 10 // 限制字段数量
  },
  fileFilter: (req, file, cb) => {
    // 验证文件类型
    if (!utils.isValidFileType(file.mimetype)) {
      return cb(new Error('只支持 JPG、PNG、WebP 格式的图片'), false);
    }
    
    // 验证文件大小（在这里提前检查，防止上传大文件）
    if (file.size && file.size > config.avatar.maxSize) {
      return cb(new Error('图片大小不能超过50kb'), false);
    }
    
    cb(null, true);
  }
});

// multer错误处理中间件
const handleMulterError = (error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json(utils.errorResponse('文件大小超过限制（最大2MB）'));
    }
    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json(utils.errorResponse('只能上传一个文件'));
    }
    if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json(utils.errorResponse('不支持的文件字段'));
    }
    return res.status(400).json(utils.errorResponse('文件上传错误'));
  }
  
  if (error.message.includes('格式') || error.message.includes('类型')) {
    return res.status(400).json(utils.errorResponse(error.message));
  }
  
  next(error);
};

// 用户注册
router.post('/register', 
  upload.single('avatar'),
  handleMulterError,
  validateRequest({
    nickname: { 
      required: true, 
      type: 'string', 
      minLength: 1, 
      maxLength: 20 
    },
    password: { 
      required: true, 
      type: 'string', 
      minLength: 6, 
      maxLength: 50 
    },
    email: { 
      type: 'string', 
      pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ 
    }
  }),
  async (req, res) => {
    try {
      const { nickname, email, password } = req.body;
      let avatarUrl = null;

      // 处理头像上传
      if (req.file) {
        try {
          // 验证图片内容
          const validation = await utils.validateImageBuffer(req.file.buffer);
          if (!validation.isValid) {
            return res.status(400).json(utils.errorResponse(`头像验证失败：${validation.error}`));
          }

          // 先创建用户获取UID
          const tempUserData = await userService.register({
            nickname,
            email,
            password,
            avatarUrl: null
          });

          // 使用UID作为文件名，保持原始格式
          const extension = validation.detectedType === 'image/jpeg' ? 'jpg' : 
                          validation.detectedType === 'image/png' ? 'png' : 'webp';
          const filename = `${tempUserData.user.uid}.${extension}`;
          const avatarPath = path.join(config.uploadPath, 'avatars', filename);

          // 确保目录存在
          await fs.mkdir(path.dirname(avatarPath), { recursive: true });

          // 保存头像文件
          await fs.writeFile(avatarPath, req.file.buffer);

          // 更新用户头像URL
          avatarUrl = `/avatars/${tempUserData.user.uid}`;
          await userService.updateUser(tempUserData.user.uid, { avatarUrl });

          // 返回完整用户数据
          const updatedUserData = await userService.getUserInfo(tempUserData.user.uid);
          return res.status(201).json(utils.successResponse('注册成功', {
            token: tempUserData.token,
            user: updatedUserData
          }));
        } catch (error) {
          console.error('头像处理错误:', error);
          return res.status(400).json(utils.errorResponse('头像处理失败'));
        }
      }

      // 注册用户
      const userData = await userService.register({
        nickname,
        email,
        password,
        avatarUrl
      });

      res.status(201).json(utils.successResponse('注册成功', userData));
    } catch (error) {
      console.error('注册错误:', error);
      res.status(400).json(utils.errorResponse(error.message));
    }
  }
);

// 用户登录
router.post('/login',
  validateRequest({
    identifier: { 
      required: true, 
      type: 'string' 
    },
    password: { 
      required: true, 
      type: 'string' 
    }
  }),
  async (req, res) => {
    try {
      const { identifier, password } = req.body;
      
      const result = await userService.login(identifier, password);
      
      res.json(utils.successResponse('登录成功', result));
    } catch (error) {
      console.error('登录错误:', error);
      res.status(400).json(utils.errorResponse(error.message));
    }
  }
);

// 创建匿名用户
router.post('/anonymous',
  validateRequest({
    chatroomId: { 
      required: true, 
      type: 'string' 
    }
  }),
  async (req, res) => {
    try {
      const { chatroomId } = req.body;
      
      const anonymousUser = await userService.createAnonymousUser(chatroomId);
      
      // 生成JWT令牌
      const token = utils.generateToken({
        uid: anonymousUser.uid,
        nickname: anonymousUser.nickname,
        type: 'anonymous'
      });

      res.status(201).json(utils.successResponse('匿名用户创建成功', {
        token,
        user: anonymousUser
      }));
    } catch (error) {
      console.error('匿名用户创建错误:', error);
      res.status(400).json(utils.errorResponse(error.message));
    }
  }
);

// 重新激活匿名用户（重新加入房间）
router.post('/anonymous/rejoin',
  validateRequest({
    uid: { 
      required: true, 
      type: 'string' 
    },
    chatroomId: { 
      required: true, 
      type: 'string' 
    }
  }),
  async (req, res) => {
    try {
      const { uid, chatroomId } = req.body;
      
      const anonymousUser = await userService.reactivateAnonymousUser(uid, chatroomId);
      
      // 生成JWT令牌
      const token = utils.generateToken({
        uid: anonymousUser.uid,
        nickname: anonymousUser.nickname,
        type: 'anonymous'
      });

      res.json(utils.successResponse('匿名用户重新激活成功', {
        token,
        user: anonymousUser
      }));
    } catch (error) {
      console.error('匿名用户重新激活错误:', error);
      res.status(400).json(utils.errorResponse(error.message));
    }
  }
);

// 获取当前用户信息
router.get('/me', authenticateToken, async (req, res) => {
  try {
    res.json(utils.successResponse('获取用户信息成功', {
      user: req.user
    }));
  } catch (error) {
    console.error('获取用户信息错误:', error);
    res.status(500).json(utils.errorResponse('获取用户信息失败'));
  }
});

// 更新用户信息
router.put('/me', 
  authenticateToken,
  upload.single('avatar'),
  handleMulterError,
  async (req, res) => {
    try {
      if (req.user.type !== 'user') {
        return res.status(403).json(utils.errorResponse('匿名用户无法更新个人信息'));
      }

      const { nickname, email } = req.body;
      const updateData = {};

      if (nickname !== undefined) {
        updateData.nickname = nickname;
      }

      if (email !== undefined) {
        updateData.email = email;
      }

      // 处理头像上传
      if (req.file) {
        try {
          // 验证图片内容
          const validation = await utils.validateImageBuffer(req.file.buffer);
          if (!validation.isValid) {
            return res.status(400).json(utils.errorResponse(`头像验证失败：${validation.error}`));
          }

          // 使用UID作为文件名，保持原始格式
          const extension = validation.detectedType === 'image/jpeg' ? 'jpg' : 
                          validation.detectedType === 'image/png' ? 'png' : 'webp';
          const filename = `${req.user.uid}.${extension}`;
          const avatarPath = path.join(config.uploadPath, 'avatars', filename);

          // 确保目录存在
          await fs.mkdir(path.dirname(avatarPath), { recursive: true });

          // 删除旧的头像文件（所有格式）
          const oldExtensions = ['jpg', 'jpeg', 'png', 'webp'];
          for (const oldExt of oldExtensions) {
            const oldPath = path.join(config.uploadPath, 'avatars', `${req.user.uid}.${oldExt}`);
            try {
              await fs.unlink(oldPath);
            } catch (error) {
              // 忽略文件不存在的错误
            }
          }

          // 保存新头像文件
          await fs.writeFile(avatarPath, req.file.buffer);

          // 设置固定的头像URL
          updateData.avatarUrl = `/avatars/${req.user.uid}`;

        } catch (error) {
          console.error('头像处理错误:', error);
          return res.status(400).json(utils.errorResponse('头像处理失败'));
        }
      }

      if (Object.keys(updateData).length === 0) {
        return res.status(400).json(utils.errorResponse('没有需要更新的数据'));
      }

      const updatedUser = await userService.updateUserInfo(req.user.uid, updateData);
      
      res.json(utils.successResponse('用户信息更新成功', updatedUser));
    } catch (error) {
      console.error('更新用户信息错误:', error);
      res.status(400).json(utils.errorResponse(error.message));
    }
  }
);

// 更新个人资料（昵称、邮箱）
router.put('/profile', 
  authenticateToken,
  validateRequest({
    nickname: { 
      type: 'string', 
      minLength: 1, 
      maxLength: 20 
    },
    email: { 
      type: 'string', 
      pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ 
    }
  }),
  async (req, res) => {
    try {
      if (req.user.type !== 'user') {
        return res.status(403).json(utils.errorResponse('匿名用户无法更新个人信息'));
      }

      const { nickname, email } = req.body;
      const updateData = {};

      if (nickname !== undefined && nickname !== req.user.nickname) {
        updateData.nickname = nickname;
      }

      if (email !== undefined && email !== req.user.email) {
        updateData.email = email;
      }

      if (Object.keys(updateData).length === 0) {
        return res.status(400).json(utils.errorResponse('没有需要更新的数据'));
      }

      const updatedUser = await userService.updateUserInfo(req.user.uid, updateData);
      
      res.json(utils.successResponse('个人信息更新成功', updatedUser));
    } catch (error) {
      console.error('更新个人信息错误:', error);
      res.status(400).json(utils.errorResponse(error.message));
    }
  }
);

// 上传头像
router.post('/avatar', 
  authenticateToken,
  upload.single('avatar'),
  handleMulterError,
  async (req, res) => {
    try {
      if (req.user.type !== 'user') {
        return res.status(403).json(utils.errorResponse('匿名用户无法上传头像'));
      }

      if (!req.file) {
        return res.status(400).json(utils.errorResponse('请选择头像文件'));
      }

      try {
        // 验证图片内容
        const validation = await utils.validateImageBuffer(req.file.buffer);
        if (!validation.isValid) {
          return res.status(400).json(utils.errorResponse(`头像验证失败：${validation.error}`));
        }

        // 使用UID作为文件名，保持原始格式
        const extension = validation.detectedType === 'image/jpeg' ? 'jpg' : 
                        validation.detectedType === 'image/png' ? 'png' : 'webp';
        const filename = `${req.user.uid}.${extension}`;
        const avatarPath = path.join(config.uploadPath, 'avatars', filename);

        // 确保目录存在
        await fs.mkdir(path.dirname(avatarPath), { recursive: true });

        // 删除旧的头像文件（所有格式）
        const oldExtensions = ['jpg', 'jpeg', 'png', 'webp'];
        for (const oldExt of oldExtensions) {
          const oldPath = path.join(config.uploadPath, 'avatars', `${req.user.uid}.${oldExt}`);
          try {
            await fs.unlink(oldPath);
          } catch (error) {
            // 忽略文件不存在的错误
          }
        }

        // 保存新头像文件
        await fs.writeFile(avatarPath, req.file.buffer);

        // 设置固定的头像URL（添加时间戳避免缓存）
        const avatarUrl = `/avatars/${req.user.uid}?t=${Date.now()}`;
        
        // 更新用户头像URL
        const updatedUser = await userService.updateUserInfo(req.user.uid, { 
          avatarUrl: `/avatars/${req.user.uid}` // 数据库中不存时间戳
        });

        res.json(utils.successResponse('头像上传成功', { 
          avatarUrl: avatarUrl // 返回带时间戳的URL
        }));
      } catch (error) {
        console.error('头像处理错误:', error);
        return res.status(400).json(utils.errorResponse('头像处理失败'));
      }
    } catch (error) {
      console.error('上传头像错误:', error);
      res.status(400).json(utils.errorResponse(error.message));
    }
  }
);

// 刷新令牌
router.post('/refresh', authenticateToken, async (req, res) => {
  try {
    // 生成新的令牌
    const token = utils.generateToken({
      uid: req.user.uid,
      nickname: req.user.nickname,
      type: req.user.type
    });

    res.json(utils.successResponse('令牌刷新成功', { token }));
  } catch (error) {
    console.error('令牌刷新错误:', error);
    res.status(500).json(utils.errorResponse('令牌刷新失败'));
  }
});

// 验证用户名/邮箱是否可用
router.post('/check-availability',
  validateRequest({
    type: { 
      required: true, 
      type: 'string',
      custom: (value) => ['email', 'nickname'].includes(value)
    },
    value: { 
      required: true, 
      type: 'string' 
    }
  }),
  async (req, res) => {
    try {
      const { type, value } = req.body;
      
      if (type === 'email') {
        if (!utils.isValidEmail(value)) {
          return res.status(400).json(utils.errorResponse('邮箱格式不正确'));
        }
        
        const userService = require('../services/userService');
        const database = require('../database');
        const existing = await database.get('SELECT id FROM users WHERE email = ?', [value]);
        
        res.json(utils.successResponse('检查完成', { 
          available: !existing,
          message: existing ? '邮箱已被使用' : '邮箱可用'
        }));
      } else if (type === 'nickname') {
        if (!utils.isValidNickname(value)) {
          return res.status(400).json(utils.errorResponse('昵称格式不正确'));
        }
        
        res.json(utils.successResponse('检查完成', { 
          available: true,
          message: '昵称可用'
        }));
      }
    } catch (error) {
      console.error('可用性检查错误:', error);
      res.status(500).json(utils.errorResponse('检查失败'));
    }
  }
);

// 错误处理中间件
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json(utils.errorResponse('文件大小超出限制'));
    }
    return res.status(400).json(utils.errorResponse('文件上传错误'));
  }
  
  if (error.message === '不支持的文件类型') {
    return res.status(400).json(utils.errorResponse('不支持的文件类型，请上传 JPG、PNG 或 WebP 格式的图片'));
  }
  
  next(error);
});

module.exports = router; 