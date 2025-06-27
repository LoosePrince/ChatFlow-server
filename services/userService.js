const database = require('../database');
const utils = require('../utils');
const config = require('../config');

class UserService {
  // 用户注册
  async register(userData) {
    const { nickname, email, password, avatarUrl } = userData;

    // 验证输入数据
    if (!utils.isValidNickname(nickname)) {
      throw new Error('昵称格式不正确');
    }

    if (!utils.isValidPassword(password)) {
      throw new Error('密码长度必须在6-50个字符之间');
    }

    if (email && !utils.isValidEmail(email)) {
      throw new Error('邮箱格式不正确');
    }

    // 检查邮箱是否已存在
    if (email) {
      const existingUser = await database.get(
        'SELECT id FROM users WHERE email = ?',
        [email]
      );
      if (existingUser) {
        throw new Error('邮箱已被注册');
      }
    }

    // 生成唯一UID
    let uid;
    let attempts = 0;
    do {
      uid = utils.generateUserUID();
      const existing = await database.get('SELECT id FROM users WHERE uid = ?', [uid]);
      if (!existing) break;
      attempts++;
    } while (attempts < 10);

    if (attempts >= 10) {
      throw new Error('系统繁忙，请稍后重试');
    }

    // 哈希密码
    const passwordHash = await utils.hashPassword(password);

    // 设置头像URL（如果没有提供则为null，前端将显示默认头像）
    const finalAvatarUrl = avatarUrl || `/avatars/${uid}`;

    // 插入用户数据
    const result = await database.run(`
      INSERT INTO users (uid, nickname, email, password_hash, avatar_url)
      VALUES (?, ?, ?, ?, ?)
    `, [uid, nickname, email || null, passwordHash, finalAvatarUrl]);

    // 生成JWT令牌
    const token = utils.generateToken({
      uid,
      nickname,
      type: 'user'
    });

    return {
      token,
      user: {
        uid,
        nickname,
        email,
        avatarUrl: finalAvatarUrl,
        isAdmin: false,
        type: 'user'
      }
    };
  }

  // 用户登录
  async login(identifier, password) {
    // identifier 可以是 UID 或邮箱
    let user;
    
    if (utils.isValidEmail(identifier)) {
      user = await database.get(
        'SELECT * FROM users WHERE email = ? AND is_banned = 0',
        [identifier]
      );
    } else {
      user = await database.get(
        'SELECT * FROM users WHERE uid = ? AND is_banned = 0',
        [identifier]
      );
    }

    if (!user) {
      throw new Error('用户不存在或已被封禁');
    }

    // 验证密码
    const isValidPassword = await utils.verifyPassword(password, user.password_hash);
    if (!isValidPassword) {
      throw new Error('密码错误');
    }

    // 更新最后登录时间
    await database.run(
      'UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [user.id]
    );

    // 生成JWT令牌
    const token = utils.generateToken({
      uid: user.uid,
      nickname: user.nickname,
      type: 'user'
    });

    return {
      token,
      user: {
        uid: user.uid,
        nickname: user.nickname,
        email: user.email,
        avatarUrl: user.avatar_url,
        isAdmin: Boolean(user.is_admin),
        type: 'user'
      }
    };
  }

  // 获取用户信息
  async getUserInfo(uid) {
    const user = await database.get(
      'SELECT uid, nickname, email, avatar_url, is_admin, created_at FROM users WHERE uid = ? AND is_banned = 0',
      [uid]
    );

    if (!user) {
      throw new Error('用户不存在');
    }

    return {
      uid: user.uid,
      nickname: user.nickname,
      email: user.email,
      avatarUrl: user.avatar_url,
      isAdmin: Boolean(user.is_admin),
      createdAt: user.created_at,
      type: 'user'
    };
  }

  // 创建匿名用户
  async createAnonymousUser(chatroomId) {
    let uid;
    let attempts = 0;
    
    do {
      uid = utils.generateAnonymousUID();
      const existing = await database.get(
        'SELECT id FROM anonymous_users WHERE uid = ?',
        [uid]
      );
      if (!existing) break;
      attempts++;
    } while (attempts < 10);

    if (attempts >= 10) {
      throw new Error('系统繁忙，请稍后重试');
    }

    const nickname = `匿名用户${uid.slice(-4)}`;
    const avatarUrl = `/avatars/${uid}`;
    const muteUntil = Date.now() + config.anonymous.muteDuration;

    await database.run(`
      INSERT INTO anonymous_users (uid, chatroom_id, nickname, avatar_url, mute_until)
      VALUES (?, ?, ?, ?, ?)
    `, [uid, chatroomId, nickname, avatarUrl, muteUntil]);

    return {
      uid,
      nickname,
      avatarUrl,
      muteUntil,
      type: 'anonymous'
    };
  }

  // 获取匿名用户信息
  async getAnonymousUserInfo(uid) {
    const user = await database.get(
      'SELECT * FROM anonymous_users WHERE uid = ? AND is_active = 1',
      [uid]
    );

    if (!user) {
      throw new Error('匿名用户不存在或已过期');
    }

    // 检查是否过期（24小时）
    const joinTime = user.join_time;
    const now = Date.now();
    if (now - joinTime > config.anonymous.sessionExpiry) {
      await this.deactivateAnonymousUser(uid);
      throw new Error('匿名用户会话已过期');
    }

    // 更新最后活跃时间
    await database.run(
      'UPDATE anonymous_users SET last_active = ? WHERE uid = ?',
      [Date.now(), uid]
    );

    return {
      uid: user.uid,
      nickname: user.nickname,
      avatarUrl: user.avatar_url,
      chatroomId: user.chatroom_id,
      joinTime: user.join_time,
      muteUntil: user.mute_until,
      type: 'anonymous'
    };
  }

  // 停用匿名用户
  async deactivateAnonymousUser(uid) {
    await database.run(
      'UPDATE anonymous_users SET is_active = 0 WHERE uid = ?',
      [uid]
    );
  }

  // 重新激活匿名用户（重新加入房间时）
  async reactivateAnonymousUser(uid, chatroomId) {
    // 检查是否存在该匿名用户
    const existingUser = await database.get(
      'SELECT * FROM anonymous_users WHERE uid = ? AND chatroom_id = ?',
      [uid, chatroomId]
    );

    if (!existingUser) {
      throw new Error('匿名用户不存在');
    }

    // 重置禁言计时为10分钟（从现在开始计算）
    const now = Date.now();
    const muteUntil = now + config.anonymous.muteDuration;
    
    console.log(`重新激活匿名用户 ${uid}，重置禁言时间：${config.anonymous.muteDuration}ms (${config.anonymous.muteDuration / 60000}分钟)`);
    console.log(`当前时间: ${now}, 禁言结束时间: ${muteUntil}`);
    
    // 重新激活用户并重置禁言时间
    await database.run(`
      UPDATE anonymous_users 
      SET is_active = 1, 
          last_active = ?, 
          mute_until = ?,
          join_time = ?
      WHERE uid = ? AND chatroom_id = ?
    `, [now, muteUntil, now, uid, chatroomId]);

    return {
      uid: existingUser.uid,
      nickname: existingUser.nickname,
      avatarUrl: existingUser.avatar_url,
      chatroomId,
      muteUntil,
      type: 'anonymous'
    };
  }

  // 更新用户信息（内部方法）
  async updateUser(uid, updateData) {
    const fields = [];
    const values = [];

    if (updateData.avatarUrl !== undefined) {
      fields.push('avatar_url = ?');
      values.push(updateData.avatarUrl);
    }

    if (updateData.nickname !== undefined) {
      fields.push('nickname = ?');
      values.push(updateData.nickname);
    }

    if (updateData.email !== undefined) {
      fields.push('email = ?');
      values.push(updateData.email);
    }

    if (fields.length === 0) {
      throw new Error('没有需要更新的数据');
    }

    values.push(uid);
    
    await database.run(
      `UPDATE users SET ${fields.join(', ')}, updated_at = ? WHERE uid = ?`,
      [...values, Date.now()]
    );

    return await this.getUserInfo(uid);
  }

  // 更新用户信息（公开方法）
  async updateUserInfo(uid, updateData) {
    const { nickname, email, avatarUrl } = updateData;
    
    // 构建更新字段
    const updateFields = [];
    const updateValues = [];
    
    if (nickname !== undefined) {
      if (!utils.isValidNickname(nickname)) {
        throw new Error('昵称格式不正确');
      }
      updateFields.push('nickname = ?');
      updateValues.push(nickname);
    }
    
    if (email !== undefined) {
      if (email && !utils.isValidEmail(email)) {
        throw new Error('邮箱格式不正确');
      }
      
      // 检查邮箱是否已被其他用户使用
      if (email) {
        const existingUser = await database.get(
          'SELECT id FROM users WHERE email = ? AND uid != ?',
          [email, uid]
        );
        if (existingUser) {
          throw new Error('邮箱已被其他用户使用');
        }
      }
      
      updateFields.push('email = ?');
      updateValues.push(email || null);
    }
    
    if (avatarUrl !== undefined) {
      updateFields.push('avatar_url = ?');
      updateValues.push(avatarUrl);
    }
    
    if (updateFields.length === 0) {
      throw new Error('没有需要更新的数据');
    }
    
    // 添加更新时间
    updateFields.push('updated_at = ?');
    updateValues.push(Date.now());
    updateValues.push(uid);
    
    // 执行更新
    const sql = `UPDATE users SET ${updateFields.join(', ')} WHERE uid = ?`;
    await database.run(sql, updateValues);
    
    // 返回更新后的用户信息
    return await this.getUserInfo(uid);
  }

  // 检查用户权限
  async checkUserPermissions(uid, chatroomId) {
    // 检查是否为聊天室创建者
    const chatroom = await database.get(
      'SELECT creator_uid FROM chatrooms WHERE room_id = ?',
      [chatroomId]
    );

    if (chatroom && chatroom.creator_uid === uid) {
      return { isCreator: true, isAdmin: true };
    }

    // 检查是否为管理员
    const admin = await database.get(
      'SELECT id FROM chatroom_admins WHERE chatroom_id = ? AND user_uid = ?',
      [chatroomId, uid]
    );

    return { isCreator: false, isAdmin: Boolean(admin) };
  }

  // 清理过期匿名用户
  async cleanupExpiredAnonymousUsers() {
    const expiredTime = Date.now() - config.anonymous.sessionExpiry;
    
    const result = await database.run(
      'UPDATE anonymous_users SET is_active = 0 WHERE join_time < ? AND is_active = 1',
      [expiredTime]
    );

    console.log(`清理了 ${result.changes} 个过期匿名用户`);
    return result.changes;
  }
}

module.exports = new UserService(); 