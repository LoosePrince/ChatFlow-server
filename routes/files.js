const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { v4: uuidv4 } = require('uuid');

const database = require('../database');
const utils = require('../utils');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// 允许的文件类型白名单（MIME类型）
const ALLOWED_MIME_TYPES = [
  // 图片
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  // 文档
  'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/csv', 'application/rtf',
  // 压缩文件
  'application/zip', 'application/x-rar-compressed', 'application/x-7z-compressed',
  'application/gzip', 'application/x-tar',
  // 音频
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/flac',
  // 视频
  'video/mp4', 'video/avi', 'video/mov', 'video/wmv', 'video/flv', 'video/webm',
  // 其他
  'application/json', 'application/xml', 'text/xml'
];

// 检查文件类型是否安全
const isFileTypeSafe = (mimetype, originalname) => {
  // 检查MIME类型
  if (!ALLOWED_MIME_TYPES.includes(mimetype)) {
    return false;
  }
  
  // 检查文件扩展名（防止文件名伪造）
  const ext = path.extname(originalname).toLowerCase();
  const dangerousExtensions = ['.exe', '.bat', '.cmd', '.com', '.pif', '.scr', '.vbs', '.js', '.jar', '.sh'];
  
  if (dangerousExtensions.includes(ext)) {
    return false;
  }
  
  return true;
};

// 确保uploads/files目录存在
const UPLOAD_DIR = path.join(__dirname, '../uploads/files');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// 压缩文件函数
const compressFile = (inputPath, outputPath) => {
  return new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(inputPath);
    const writeStream = fs.createWriteStream(outputPath);
    const gzipStream = zlib.createGzip({ level: 6 }); // 使用适中的压缩级别

    readStream
      .pipe(gzipStream)
      .pipe(writeStream)
      .on('finish', () => {
        resolve();
      })
      .on('error', (error) => {
        reject(error);
      });
  });
};

// 解压文件函数
const decompressFile = (inputPath, outputPath) => {
  return new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(inputPath);
    const writeStream = fs.createWriteStream(outputPath);
    const gunzipStream = zlib.createGunzip();

    readStream
      .pipe(gunzipStream)
      .pipe(writeStream)
      .on('finish', () => {
        resolve();
      })
      .on('error', (error) => {
        reject(error);
      });
  });
};

// 获取临时文件路径
const getTempFilePath = (originalPath) => {
  const ext = path.extname(originalPath);
  const basename = path.basename(originalPath, ext);
  const dir = path.dirname(originalPath);
  return path.join(dir, `${basename}_temp${ext}`);
};

// 配置multer用于文件上传
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    // 生成唯一文件名，统一使用.file后缀以隐藏真实文件类型
    const fileName = crypto.randomBytes(16).toString('hex') + '.file';
    cb(null, fileName);
  }
});

// 文件过滤器
const fileFilter = (req, file, cb) => {
  // 检查文件大小（2MB = 2 * 1024 * 1024 bytes）
  const maxSize = 2 * 1024 * 1024;
  
  // 这里无法直接检查文件大小，在后面的中间件中检查
  cb(null, true);
};

const upload = multer({ 
  storage,
  fileFilter,
  limits: {
    fileSize: 2 * 1024 * 1024 // 2MB
  }
});

// 文件上传API
router.post('/upload', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json(utils.errorResponse('未选择文件'));
    }

    // 暂时取消检查
    // // 安全检查：验证文件类型
    // if (!isFileTypeSafe(req.file.mimetype, req.file.originalname)) {
    //   // 删除已上传的文件
    //   fs.unlinkSync(req.file.path);
    //   return res.status(400).json(utils.errorResponse('不支持的文件类型或存在安全风险'));
    // }

    const { chatroomId, replyToMessageId } = req.body;
    
    if (!chatroomId) {
      // 删除已上传的文件
      fs.unlinkSync(req.file.path);
      return res.status(400).json(utils.errorResponse('缺少聊天室ID'));
    }

    // 检查用户是否在聊天室中
    const member = await database.get(
      'SELECT * FROM chatroom_members WHERE chatroom_id = ? AND user_uid = ? AND is_active = 1',
      [chatroomId, req.user.uid]
    );

    if (!member) {
      // 删除已上传的文件
      fs.unlinkSync(req.file.path);
      return res.status(403).json(utils.errorResponse('您不在此聊天室中'));
    }

    // 检查文件大小
    if (req.file.size > 2 * 1024 * 1024) {
      // 删除已上传的文件
      fs.unlinkSync(req.file.path);
      return res.status(400).json(utils.errorResponse('文件大小不能超过2MB'));
    }

    // 生成文件ID
    const fileId = uuidv4();
    
    // 计算过期时间（30分钟后）
    const expiryTime = Date.now() + (30 * 60 * 1000);

    // 压缩文件
    const originalFilePath = req.file.path;
    const tempFilePath = getTempFilePath(originalFilePath);
    
    try {
      // 压缩原文件到临时文件
      await compressFile(originalFilePath, tempFilePath);
      
      // 删除原未压缩文件
      fs.unlinkSync(originalFilePath);
      
      // 将压缩文件重命名为最终文件
      fs.renameSync(tempFilePath, originalFilePath);
      
      // 获取压缩后的文件大小
      const compressedStats = fs.statSync(originalFilePath);
      const compressedSize = compressedStats.size;
      
      console.log(`文件压缩完成: ${req.file.originalname}`);
      console.log(`原始大小: ${req.file.size} 字节`);
      console.log(`压缩后大小: ${compressedSize} 字节`);
      console.log(`压缩率: ${(((req.file.size - compressedSize) / req.file.size) * 100).toFixed(2)}%`);

      // 保存文件信息到数据库（保存原始文件大小用于显示，压缩大小用于存储管理）
      await database.run(`
        INSERT INTO files (
          file_id, original_name, stored_name, mime_type, file_size,
          uploader_uid, chatroom_id, upload_time, expiry_time, compressed_size
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        fileId,
        req.file.originalname,
        req.file.filename,
        req.file.mimetype,
        req.file.size, // 保存原始文件大小
        req.user.uid,
        chatroomId,
        Date.now(),
        expiryTime,
        compressedSize // 保存压缩后大小
      ]);
      
    } catch (compressionError) {
      console.error('文件压缩失败:', compressionError);
      
      // 清理文件
      if (fs.existsSync(originalFilePath)) {
        fs.unlinkSync(originalFilePath);
      }
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
      
      return res.status(500).json(utils.errorResponse('文件压缩失败'));
    }

    // 返回文件信息
    res.json(utils.successResponse('文件上传成功', {
      fileId,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
      expiryTime,
      replyToMessageId: replyToMessageId || null
    }));

  } catch (error) {
    console.error('文件上传失败:', error);
    
    // 清理已上传的文件
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json(utils.errorResponse('文件上传失败'));
  }
});

// 文件下载API
router.get('/download/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;

    // 从数据库获取文件信息
    const file = await database.get(
      'SELECT * FROM files WHERE file_id = ? AND is_expired = 0',
      [fileId]
    );

    if (!file) {
      return res.status(404).json(utils.errorResponse('文件不存在或已过期'));
    }

    // 检查文件是否过期
    if (Date.now() > file.expiry_time) {
      // 标记文件为过期
      await database.run('UPDATE files SET is_expired = 1 WHERE file_id = ?', [fileId]);
      
      // 删除物理文件
      const filePath = path.join(UPLOAD_DIR, file.stored_name);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      
      return res.status(410).json(utils.errorResponse('文件已过期'));
    }

    // 构建文件路径
    const filePath = path.join(UPLOAD_DIR, file.stored_name);

    // 检查文件是否存在
    if (!fs.existsSync(filePath)) {
      return res.status(404).json(utils.errorResponse('文件不存在'));
    }

    // 更新下载次数
    await database.run(
      'UPDATE files SET download_count = download_count + 1 WHERE file_id = ?',
      [fileId]
    );

    // 创建临时解压文件
    const tempDecompressPath = getTempFilePath(filePath).replace('.file', '_decomp');
    
    try {
      // 解压文件
      await decompressFile(filePath, tempDecompressPath);
      
      // 设置响应头
      res.set({
        'Content-Type': file.mime_type,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(file.original_name)}"`,
        'Content-Length': file.file_size // 使用原始文件大小
      });

      // 发送解压后的文件
      res.sendFile(tempDecompressPath, (err) => {
        // 发送完成后删除临时文件
        if (fs.existsSync(tempDecompressPath)) {
          fs.unlinkSync(tempDecompressPath);
        }
        
        if (err) {
          console.error('发送文件失败:', err);
        }
      });
      
    } catch (decompressionError) {
      console.error('文件解压失败:', decompressionError);
      
      // 清理临时文件
      if (fs.existsSync(tempDecompressPath)) {
        fs.unlinkSync(tempDecompressPath);
      }
      
      return res.status(500).json(utils.errorResponse('文件解压失败'));
    }

  } catch (error) {
    console.error('文件下载失败:', error);
    res.status(500).json(utils.errorResponse('文件下载失败'));
  }
});

// 获取文件信息API
router.get('/info/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;

    const file = await database.get(
      'SELECT file_id, original_name, file_size, mime_type, upload_time, expiry_time, is_expired FROM files WHERE file_id = ?',
      [fileId]
    );

    if (!file) {
      return res.status(404).json(utils.errorResponse('文件不存在'));
    }

    // 检查是否过期
    const isExpired = Date.now() > file.expiry_time;
    if (isExpired && !file.is_expired) {
      await database.run('UPDATE files SET is_expired = 1 WHERE file_id = ?', [fileId]);
      file.is_expired = 1;
    }

    res.json(utils.successResponse('获取文件信息成功', {
      fileId: file.file_id,
      fileName: file.original_name,
      fileSize: file.file_size,
      mimeType: file.mime_type,
      uploadTime: file.upload_time,
      expiryTime: file.expiry_time,
      isExpired: isExpired || file.is_expired === 1
    }));

  } catch (error) {
    console.error('获取文件信息失败:', error);
    res.status(500).json(utils.errorResponse('获取文件信息失败'));
  }
});

module.exports = router; 