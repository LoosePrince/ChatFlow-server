const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// 数据库文件路径
const DB_PATH = path.join(__dirname, 'data', 'chatroom.db');
const DATA_DIR = path.join(__dirname, 'data');

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

class Database {
  constructor() {
    this.db = null;
    this.isReady = false;
  }

  // 初始化数据库连接
  async initialize() {
    try {
      this.db = new sqlite3.Database(DB_PATH, (err) => {
        if (err) {
          console.error('数据库连接失败:', err.message);
          throw err;
        }
        console.log('SQLite数据库连接成功');
      });

      // 启用外键约束
      await this.run('PRAGMA foreign_keys = ON');
      
      // 创建表结构
      await this.createTables();
      
      this.isReady = true;
      console.log('数据库初始化完成');
    } catch (error) {
      console.error('数据库初始化失败:', error);
      throw error;
    }
  }

  // 创建数据库表结构
  async createTables() {
    // 用户表
    await this.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT UNIQUE NOT NULL,
        nickname TEXT NOT NULL,
        email TEXT UNIQUE,
        password_hash TEXT NOT NULL,
        avatar_url TEXT,
        is_admin INTEGER DEFAULT 0,
        is_banned INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      )
    `);

    // 匿名用户表
    await this.run(`
      CREATE TABLE IF NOT EXISTS anonymous_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT NOT NULL,
        chatroom_id TEXT NOT NULL,
        nickname TEXT NOT NULL,
        avatar_url TEXT,
        mute_until INTEGER,
        is_active INTEGER DEFAULT 1,
        join_time INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        last_active INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        UNIQUE(uid, chatroom_id)
      )
    `);

    // 聊天室表
    await this.run(`
      CREATE TABLE IF NOT EXISTS chatrooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        password_hash TEXT,
        creator_uid TEXT NOT NULL,
        max_users INTEGER DEFAULT 100,
        is_active INTEGER DEFAULT 1,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      )
    `);

    // 聊天室管理员表
    await this.run(`
      CREATE TABLE IF NOT EXISTS chatroom_admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chatroom_id TEXT NOT NULL,
        user_uid TEXT NOT NULL,
        granted_by TEXT NOT NULL,
        granted_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        UNIQUE(chatroom_id, user_uid),
        FOREIGN KEY (chatroom_id) REFERENCES chatrooms(room_id),
        FOREIGN KEY (user_uid) REFERENCES users(uid),
        FOREIGN KEY (granted_by) REFERENCES users(uid)
      )
    `);

    // 消息表
    await this.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT UNIQUE NOT NULL,
        chatroom_id TEXT NOT NULL,
        sender_uid TEXT NOT NULL,
        sender_type TEXT NOT NULL CHECK(sender_type IN ('user', 'anonymous', 'system')),
        content TEXT NOT NULL,
        message_type TEXT DEFAULT 'text' CHECK(message_type IN ('text', 'image', 'file', 'system', 'bilibili', 'markdown')),
        system_message_type TEXT CHECK(system_message_type IN ('persistent', 'temporary')),
        visibility_scope TEXT DEFAULT 'all' CHECK(visibility_scope IN ('all', 'specific')),
        visible_to_users TEXT,
        reply_to_message_id INTEGER,
        is_deleted INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        FOREIGN KEY (chatroom_id) REFERENCES chatrooms(room_id),
        FOREIGN KEY (reply_to_message_id) REFERENCES messages(id)
      )
    `);

    // 用户禁言记录表
    await this.run(`
      CREATE TABLE IF NOT EXISTS user_mutes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chatroom_id TEXT NOT NULL,
        user_uid TEXT NOT NULL,
        muted_by TEXT NOT NULL,
        reason TEXT,
        mute_until INTEGER NOT NULL,
        is_active INTEGER DEFAULT 1,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        FOREIGN KEY (chatroom_id) REFERENCES chatrooms(room_id),
        FOREIGN KEY (muted_by) REFERENCES users(uid)
      )
    `);

    // 用户加入聊天室记录表
    await this.run(`
      CREATE TABLE IF NOT EXISTS chatroom_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chatroom_id TEXT NOT NULL,
        user_uid TEXT NOT NULL,
        user_type TEXT NOT NULL CHECK(user_type IN ('user', 'anonymous')),
        nickname TEXT NOT NULL,
        avatar_url TEXT,
        join_time INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        last_active INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        status TEXT DEFAULT 'online' CHECK(status IN ('online', 'offline', 'left')),
        is_active INTEGER DEFAULT 1,
        UNIQUE(chatroom_id, user_uid),
        FOREIGN KEY (chatroom_id) REFERENCES chatrooms(room_id)
      )
    `);

    // 数据库迁移：为现有的messages表添加reply_to_message_id字段
    try {
      // 检查是否已存在reply_to_message_id字段
      const columns = await this.all("PRAGMA table_info(messages)");
      const hasReplyField = columns.some(col => col.name === 'reply_to_message_id');
      
      if (!hasReplyField) {
        console.log('正在为messages表添加reply_to_message_id字段...');
        await this.run('ALTER TABLE messages ADD COLUMN reply_to_message_id INTEGER');
        console.log('reply_to_message_id字段添加完成');
      }
    } catch (error) {
      console.warn('添加reply_to_message_id字段时出错:', error.message);
    }

    // 数据库迁移：为现有的messages表添加image_url字段
    try {
      // 检查是否已存在image_url字段
      const columns = await this.all("PRAGMA table_info(messages)");
      const hasImageUrlField = columns.some(col => col.name === 'image_url');
      
      if (!hasImageUrlField) {
        console.log('正在为messages表添加image_url字段...');
        await this.run('ALTER TABLE messages ADD COLUMN image_url TEXT');
        console.log('image_url字段添加完成');
      }
    } catch (error) {
      console.warn('添加image_url字段时出错:', error.message);
    }

    // 数据库迁移：为现有的messages表添加扩展内容字段
    try {
      const columns = await this.all("PRAGMA table_info(messages)");
      
      // 添加bilibili_bv字段
      const hasBilibiliField = columns.some(col => col.name === 'bilibili_bv');
      if (!hasBilibiliField) {
        console.log('正在为messages表添加bilibili_bv字段...');
        await this.run('ALTER TABLE messages ADD COLUMN bilibili_bv TEXT');
        console.log('bilibili_bv字段添加完成');
      }
      
      // 添加markdown_content字段
      const hasMarkdownField = columns.some(col => col.name === 'markdown_content');
      if (!hasMarkdownField) {
        console.log('正在为messages表添加markdown_content字段...');
        await this.run('ALTER TABLE messages ADD COLUMN markdown_content TEXT');
        console.log('markdown_content字段添加完成');
      }

      // 添加文件相关字段
      const hasFileIdField = columns.some(col => col.name === 'file_id');
      if (!hasFileIdField) {
        console.log('正在为messages表添加文件相关字段...');
        await this.run('ALTER TABLE messages ADD COLUMN file_id TEXT');
        await this.run('ALTER TABLE messages ADD COLUMN file_name TEXT');
        await this.run('ALTER TABLE messages ADD COLUMN file_size INTEGER');
        await this.run('ALTER TABLE messages ADD COLUMN file_expiry INTEGER');
        console.log('文件相关字段添加完成');
      }
      
    } catch (error) {
      console.warn('添加扩展内容字段时出错:', error.message);
    }

    // 数据库迁移：为files表添加compressed_size字段
    try {
      const filesColumns = await this.all("PRAGMA table_info(files)");
      const hasCompressedSizeField = filesColumns.some(col => col.name === 'compressed_size');
      
      if (!hasCompressedSizeField) {
        console.log('正在为files表添加compressed_size字段...');
        await this.run('ALTER TABLE files ADD COLUMN compressed_size INTEGER');
        console.log('compressed_size字段添加完成');
      }
    } catch (error) {
      console.warn('添加compressed_size字段时出错:', error.message);
    }

    // 创建文件表
    await this.run(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id TEXT UNIQUE NOT NULL,
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        uploader_uid TEXT NOT NULL,
        chatroom_id TEXT NOT NULL,
        message_id TEXT,
        upload_time INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        expiry_time INTEGER NOT NULL,
        download_count INTEGER DEFAULT 0,
        is_expired INTEGER DEFAULT 0,
        FOREIGN KEY (chatroom_id) REFERENCES chatrooms(room_id),
        FOREIGN KEY (message_id) REFERENCES messages(message_id)
      )
    `);

    // 创建索引以提高查询性能
    await this.run('CREATE INDEX IF NOT EXISTS idx_users_uid ON users(uid)');
    await this.run('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
    await this.run('CREATE INDEX IF NOT EXISTS idx_anonymous_users_uid ON anonymous_users(uid)');
    await this.run('CREATE INDEX IF NOT EXISTS idx_anonymous_users_chatroom ON anonymous_users(chatroom_id)');
    await this.run('CREATE INDEX IF NOT EXISTS idx_chatrooms_room_id ON chatrooms(room_id)');
    await this.run('CREATE INDEX IF NOT EXISTS idx_messages_chatroom ON messages(chatroom_id)');
    await this.run('CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_uid)');
    await this.run('CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)');
    await this.run('CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to_message_id)');
    await this.run('CREATE INDEX IF NOT EXISTS idx_chatroom_members_chatroom ON chatroom_members(chatroom_id)');
    await this.run('CREATE INDEX IF NOT EXISTS idx_chatroom_members_user ON chatroom_members(user_uid)');
    await this.run('CREATE INDEX IF NOT EXISTS idx_files_file_id ON files(file_id)');
    await this.run('CREATE INDEX IF NOT EXISTS idx_files_chatroom ON files(chatroom_id)');
    await this.run('CREATE INDEX IF NOT EXISTS idx_files_uploader ON files(uploader_uid)');
    await this.run('CREATE INDEX IF NOT EXISTS idx_files_expiry ON files(expiry_time)');
  }

  // 执行SQL语句（无返回结果）
  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) {
          console.error('SQL执行错误:', sql, params, err.message);
          reject(err);
        } else {
          resolve({
            id: this.lastID,
            changes: this.changes
          });
        }
      });
    });
  }

  // 查询单行数据
  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) {
          console.error('SQL查询错误:', sql, params, err.message);
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
  }

  // 查询多行数据
  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) {
          console.error('SQL查询错误:', sql, params, err.message);
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  // 开始事务
  async beginTransaction() {
    await this.run('BEGIN TRANSACTION');
  }

  // 提交事务
  async commit() {
    await this.run('COMMIT');
  }

  // 回滚事务
  async rollback() {
    await this.run('ROLLBACK');
  }

  // 关闭数据库连接
  close() {
    return new Promise((resolve, reject) => {
      if (this.db) {
        this.db.close((err) => {
          if (err) {
            console.error('关闭数据库失败:', err.message);
            reject(err);
          } else {
            console.log('数据库连接已关闭');
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }

  // 检查数据库是否就绪
  checkReady() {
    if (!this.isReady) {
      throw new Error('数据库未初始化');
    }
  }

  // 获取数据库统计信息
  async getStats() {
    this.checkReady();
    
    const stats = {};
    stats.users = await this.get('SELECT COUNT(*) as count FROM users');
    stats.anonymousUsers = await this.get('SELECT COUNT(*) as count FROM anonymous_users WHERE is_active = 1');
    stats.chatrooms = await this.get('SELECT COUNT(*) as count FROM chatrooms WHERE is_active = 1');
    stats.messages = await this.get('SELECT COUNT(*) as count FROM messages WHERE is_deleted = 0');
    
    return {
      users: stats.users.count,
      anonymousUsers: stats.anonymousUsers.count,
      chatrooms: stats.chatrooms.count,
      messages: stats.messages.count
    };
  }

  // 清理过期数据
  async cleanup() {
    this.checkReady();
    
    try {
      // 清理过期的匿名用户（24小时后）
      const result = await this.run(`
        UPDATE anonymous_users 
        SET is_active = 0 
        WHERE is_active = 1 
        AND datetime(join_time, '+24 hours') < datetime('now')
      `);

      // 清理过期的禁言记录
      await this.run(`
        UPDATE user_mutes 
        SET is_active = 0 
        WHERE is_active = 1 
        AND mute_until < datetime('now')
      `);

      // 清理过期文件
      const expiredFiles = await this.all(`
        SELECT file_id, stored_name FROM files 
        WHERE expiry_time < ? AND is_expired = 0
      `, [Date.now()]);

      if (expiredFiles.length > 0) {
        // 标记文件为过期
        await this.run(`
          UPDATE files 
          SET is_expired = 1 
          WHERE expiry_time < ? AND is_expired = 0
        `, [Date.now()]);

        // 删除物理文件
        const fs = require('fs');
        const path = require('path');
        const uploadDir = path.join(__dirname, 'uploads/files');
        
        let deletedCount = 0;
        for (const file of expiredFiles) {
          const filePath = path.join(uploadDir, file.stored_name);
          try {
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
              deletedCount++;
            }
          } catch (error) {
            console.warn(`删除文件失败: ${file.stored_name}`, error);
          }
        }

        console.log(`清理了 ${expiredFiles.length} 个过期文件，删除了 ${deletedCount} 个物理文件`);
      }

      console.log(`清理了 ${result.changes} 个过期的匿名用户`);
      return result.changes;
    } catch (error) {
      console.error('数据清理失败:', error);
      throw error;
    }
  }
}

// 创建数据库实例
const database = new Database();

module.exports = database;