const database = require('../database');
const utils = require('../utils');
const config = require('../config');

class ChatroomService {
  // 创建聊天室
  async createChatroom(creatorUid, chatroomData) {
    const { name, password } = chatroomData;

    // 验证输入数据
    if (!utils.isValidRoomName(name)) {
      throw new Error('聊天室名称格式不正确');
    }

    if (password && password.length > config.chatroom.maxPasswordLength) {
      throw new Error('密码长度不能超过50个字符');
    }

    // 生成唯一聊天室ID
    let roomId;
    let attempts = 0;
    do {
      roomId = utils.generateRoomId();
      const existing = await database.get(
        'SELECT id FROM chatrooms WHERE room_id = ?',
        [roomId]
      );
      if (!existing) break;
      attempts++;
    } while (attempts < 10);

    if (attempts >= 10) {
      throw new Error('系统繁忙，请稍后重试');
    }

    // 哈希密码（如果有）
    let passwordHash = null;
    if (password) {
      passwordHash = await utils.hashPassword(password);
    }

    // 创建聊天室
    await database.run(`
      INSERT INTO chatrooms (room_id, name, password_hash, creator_uid)
      VALUES (?, ?, ?, ?)
    `, [roomId, name, passwordHash, creatorUid]);

    // 发送欢迎系统消息
    const messageService = require('./messageService');
    await messageService.sendSystemMessage(
      roomId,
      `欢迎来到聊天室"${name}"！这是一个全新的聊天室，快开始聊天吧！`,
      {
        systemMessageType: 'persistent',
        visibilityScope: 'all'
      }
    );

    return {
      roomId,
      name,
      hasPassword: Boolean(password),
      creatorUid
    };
  }

  // 加入聊天室
  async joinChatroom(roomId, password = null, userUid = null) {
    // 检查聊天室是否存在
    const chatroom = await database.get(
      'SELECT * FROM chatrooms WHERE room_id = ? AND is_active = 1',
      [roomId]
    );

    if (!chatroom) {
      throw new Error('聊天室不存在或已被关闭');
    }

    // 检查密码（如果需要）
    if (chatroom.password_hash) {
      // 如果是创建者，无需密码
      if (userUid && chatroom.creator_uid === userUid) {
        // 创建者可以直接加入
      } else {
        if (!password) {
          throw new Error('该聊天室需要密码');
        }

        const isValidPassword = await utils.verifyPassword(password, chatroom.password_hash);
        if (!isValidPassword) {
          throw new Error('密码错误');
        }
      }
    }

    return {
      roomId: chatroom.room_id,
      name: chatroom.name,
      creatorUid: chatroom.creator_uid,
      createdAt: chatroom.created_at,
      isOwner: userUid === chatroom.creator_uid
    };
  }

  // 获取聊天室信息
  async getChatroomInfo(roomId) {
    const chatroom = await database.get(
      'SELECT room_id, name, creator_uid, created_at FROM chatrooms WHERE room_id = ? AND is_active = 1',
      [roomId]
    );

    if (!chatroom) {
      throw new Error('聊天室不存在');
    }

    // 获取在线用户数量
    const userCount = await this.getActiveUserCount(roomId);

    return {
      roomId: chatroom.room_id,
      name: chatroom.name,
      creatorUid: chatroom.creator_uid,
      createdAt: chatroom.created_at,
      userCount
    };
  }

  // 获取用户参与的聊天室列表
  async getUserChatrooms(userUid) {
    // 从chatroom_members表获取用户参与的所有聊天室
    const userChatrooms = await database.all(
      `SELECT DISTINCT cm.chatroom_id, c.room_id, c.name, c.creator_uid, cm.join_time,
       CASE WHEN c.creator_uid = ? THEN 'created' ELSE 'joined' END as join_type,
       (SELECT COUNT(*) FROM chatroom_members cm2 WHERE cm2.chatroom_id = c.room_id AND cm2.is_active = 1) as member_count
       FROM chatroom_members cm
       JOIN chatrooms c ON cm.chatroom_id = c.room_id
       WHERE cm.user_uid = ? AND cm.is_active = 1 AND c.is_active = 1
       ORDER BY cm.last_active DESC`,
      [userUid, userUid]
    );

    // 为每个聊天室添加额外信息
    const chatroomsWithInfo = await Promise.all(
      userChatrooms.map(async (chatroom) => {
        // 获取最近一条消息
        const lastMessage = await database.get(
          `SELECT content, sender_uid, created_at, message_type 
           FROM messages 
           WHERE chatroom_id = ? AND is_deleted = 0 
           ORDER BY created_at DESC 
           LIMIT 1`,
          [chatroom.room_id]
        );

        return {
          roomId: chatroom.room_id,
          name: chatroom.name,
          createdAt: chatroom.join_time,
          joinType: chatroom.join_type,
          userCount: chatroom.member_count,
          isCreator: chatroom.creator_uid === userUid,
          lastMessage: lastMessage ? {
            content: lastMessage.content,
            senderUid: lastMessage.sender_uid,
            createdAt: lastMessage.created_at,
            messageType: lastMessage.message_type
          } : null
        };
      })
    );

    // 按最近活动时间排序
    chatroomsWithInfo.sort((a, b) => {
      const aTime = a.lastMessage?.createdAt || a.createdAt;
      const bTime = b.lastMessage?.createdAt || b.createdAt;
      return new Date(bTime) - new Date(aTime);
    });

    return chatroomsWithInfo;
  }

  // 更新聊天室名称
  async updateChatroomName(roomId, newName, updaterUid) {
    // 验证新名称
    if (!utils.isValidRoomName(newName)) {
      throw new Error('聊天室名称格式不正确');
    }

    // 检查权限（只有创建者和管理员可以修改）
    const hasPermission = await this.checkAdminPermission(updaterUid, roomId);
    if (!hasPermission) {
      throw new Error('没有权限修改聊天室名称');
    }

    await database.run(
      'UPDATE chatrooms SET name = ? WHERE room_id = ?',
      [newName, roomId]
    );

    return await this.getChatroomInfo(roomId);
  }

  // 设置聊天室管理员
  async setAdmin(roomId, targetUid, granterUid) {
    // 检查权限（只有创建者可以设置管理员）
    const chatroom = await database.get(
      'SELECT creator_uid FROM chatrooms WHERE room_id = ?',
      [roomId]
    );

    if (!chatroom || chatroom.creator_uid !== granterUid) {
      throw new Error('只有聊天室创建者可以设置管理员');
    }

    // 检查目标用户是否存在
    const targetUser = await database.get(
      'SELECT id FROM users WHERE uid = ?',
      [targetUid]
    );

    if (!targetUser) {
      throw new Error('目标用户不存在');
    }

    // 检查是否已经是管理员
    const existingAdmin = await database.get(
      'SELECT id FROM chatroom_admins WHERE chatroom_id = ? AND user_uid = ?',
      [roomId, targetUid]
    );

    if (existingAdmin) {
      throw new Error('该用户已经是管理员');
    }

    // 添加管理员
    await database.run(`
      INSERT INTO chatroom_admins (chatroom_id, user_uid, granted_by)
      VALUES (?, ?, ?)
    `, [roomId, targetUid, granterUid]);

    return { success: true, message: '管理员设置成功' };
  }

  // 移除聊天室管理员
  async removeAdmin(roomId, targetUid, removerUid) {
    // 检查权限（只有创建者可以移除管理员）
    const chatroom = await database.get(
      'SELECT creator_uid FROM chatrooms WHERE room_id = ?',
      [roomId]
    );

    if (!chatroom || chatroom.creator_uid !== removerUid) {
      throw new Error('只有聊天室创建者可以移除管理员');
    }

    const result = await database.run(
      'DELETE FROM chatroom_admins WHERE chatroom_id = ? AND user_uid = ?',
      [roomId, targetUid]
    );

    if (result.changes === 0) {
      throw new Error('该用户不是管理员');
    }

    return { success: true, message: '管理员移除成功' };
  }

  // 检查管理员权限
  async checkAdminPermission(uid, roomId) {
    // 检查是否为创建者
    const chatroom = await database.get(
      'SELECT creator_uid FROM chatrooms WHERE room_id = ?',
      [roomId]
    );

    if (chatroom && chatroom.creator_uid === uid) {
      return true;
    }

    // 检查是否为管理员
    const admin = await database.get(
      'SELECT id FROM chatroom_admins WHERE chatroom_id = ? AND user_uid = ?',
      [roomId, uid]
    );

    return Boolean(admin);
  }

  // 获取聊天室管理员列表
  async getChatroomAdmins(roomId) {
    const admins = await database.all(`
      SELECT ca.user_uid, u.nickname, u.avatar_url, ca.granted_at,
             CASE WHEN c.creator_uid = ca.user_uid THEN 1 ELSE 0 END as is_creator
      FROM chatroom_admins ca
      JOIN users u ON ca.user_uid = u.uid
      JOIN chatrooms c ON ca.chatroom_id = c.room_id
      WHERE ca.chatroom_id = ?
      ORDER BY is_creator DESC, ca.granted_at ASC
    `, [roomId]);

    // 添加创建者（确保创建者在列表中）
    const creator = await database.get(`
      SELECT c.creator_uid, u.nickname, u.avatar_url, c.created_at
      FROM chatrooms c
      JOIN users u ON c.creator_uid = u.uid
      WHERE c.room_id = ?
    `, [roomId]);

    if (creator) {
      const creatorExists = admins.some(admin => admin.user_uid === creator.creator_uid);
      if (!creatorExists) {
        admins.unshift({
          user_uid: creator.creator_uid,
          nickname: creator.nickname,
          avatar_url: creator.avatar_url,
          granted_at: creator.created_at,
          is_creator: 1
        });
      }
    }

    return admins;
  }

  // 获取活跃用户数量
  async getActiveUserCount(roomId) {
    // 注册用户数量（需要在实际实现中通过WebSocket连接来统计）
    // 这里先返回一个模拟值
    return 0;
  }

  // 获取在线用户列表
  async getOnlineUsers(roomId) {
    const members = await database.all(
      `SELECT cm.user_uid as uid, cm.nickname, cm.avatar_url as avatarUrl, cm.user_type as type
       FROM chatroom_members cm
       WHERE cm.chatroom_id = ? AND cm.is_active = 1 AND cm.status = 'online'`,
      [roomId]
    );
    return members;
  }

  // 获取用户信息
  async getUserInfo(userUid, roomId) {
    // 首先从成员表中查找
    const member = await database.get(
      `SELECT user_uid as uid, nickname, avatar_url as avatarUrl, user_type as type
       FROM chatroom_members 
       WHERE chatroom_id = ? AND user_uid = ?`,
      [roomId, userUid]
    );
    
    if (member) {
      return member;
    }
    
    // 如果成员表中没有，从用户表或匿名用户表中查找
    const user = await database.get(
      'SELECT uid, nickname, avatar_url as avatarUrl, "user" as type FROM users WHERE uid = ?',
      [userUid]
    );
    
    if (user) {
      return user;
    }
    
    // 查找匿名用户
    const anonymousUser = await database.get(
      'SELECT uid, nickname, avatar_url as avatarUrl, "anonymous" as type FROM anonymous_users WHERE uid = ? AND chatroom_id = ?',
      [userUid, roomId]
    );
    
    return anonymousUser;
  }

  // 添加成员到聊天室
  async addMemberToChatroom(roomId, userUid, userType, nickname, avatarUrl) {
    try {
      await database.run(`
        INSERT OR REPLACE INTO chatroom_members 
        (chatroom_id, user_uid, user_type, nickname, avatar_url, join_time, last_active, status, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'online', 1)
      `, [roomId, userUid, userType, nickname, avatarUrl, Date.now(), Date.now()]);
    } catch (error) {
      console.error('添加成员到聊天室失败:', error);
      // 不抛出错误，避免影响主流程
    }
  }

  // 更新成员活跃时间
  async updateMemberActivity(roomId, userUid) {
    try {
      await database.run(`
        UPDATE chatroom_members 
        SET last_active = ?, status = 'online'
        WHERE chatroom_id = ? AND user_uid = ?
      `, [Date.now(), roomId, userUid]);
    } catch (error) {
      console.error('更新成员活跃时间失败:', error);
    }
  }

  // 设置成员离线状态
  async setMemberOffline(roomId, userUid) {
    try {
      await database.run(`
        UPDATE chatroom_members 
        SET status = 'offline', last_active = ?
        WHERE chatroom_id = ? AND user_uid = ?
      `, [Date.now(), roomId, userUid]);
    } catch (error) {
      console.error('设置成员离线状态失败:', error);
    }
  }

  // 设置成员退出状态
  async setMemberLeft(roomId, userUid) {
    try {
      await database.run(`
        UPDATE chatroom_members 
        SET status = 'left', is_active = 0, last_active = ?
        WHERE chatroom_id = ? AND user_uid = ?
      `, [Date.now(), roomId, userUid]);
    } catch (error) {
      console.error('设置成员退出状态失败:', error);
    }
  }

  // 获取聊天室成员列表
  async getChatroomMembers(roomId) {
    // 检查聊天室是否存在
    const chatroom = await database.get(
      'SELECT room_id, name, creator_uid FROM chatrooms WHERE room_id = ? AND is_active = 1',
      [roomId]
    );

    if (!chatroom) {
      throw new Error('聊天室不存在');
    }

    // 从chatroom_members表获取成员列表
    const members = await database.all(
      `SELECT cm.user_uid, cm.user_type, cm.nickname, cm.avatar_url, 
              cm.join_time, cm.last_active, cm.status, cm.is_active,
              CASE WHEN cm.user_uid = ? THEN 1 ELSE 0 END as is_creator,
              CASE WHEN ca.id IS NOT NULL THEN 1 ELSE 0 END as is_admin
       FROM chatroom_members cm
       LEFT JOIN chatroom_admins ca ON ca.user_uid = cm.user_uid AND ca.chatroom_id = ?
       WHERE cm.chatroom_id = ? AND cm.is_active = 1
       ORDER BY cm.join_time ASC`,
      [chatroom.creator_uid, roomId, roomId]
    );

    // 转换为标准格式并检查禁言状态
    const memberList = await Promise.all(members.map(async member => {
      // 检查禁言状态
      const muteStatus = await this.checkUserMuted(member.user_uid, roomId);
      
      return {
      uid: member.user_uid,
      nickname: member.nickname,
      avatarUrl: member.avatar_url,
      type: member.user_type,
      status: member.status,
      isCreator: Boolean(member.is_creator),
      isAdmin: Boolean(member.is_admin) || Boolean(member.is_creator), // 创建者默认是管理员
        isMuted: muteStatus.isMuted,
        muteUntil: muteStatus.muteUntil,
      joinTime: member.join_time,
      lastActiveTime: member.last_active
      };
    }));

    // 确保创建者在列表中
    const creatorExists = memberList.some(member => member.uid === chatroom.creator_uid);
    if (!creatorExists) {
      const creator = await database.get(
        'SELECT uid, nickname, avatar_url, created_at FROM users WHERE uid = ?',
        [chatroom.creator_uid]
      );
      
      if (creator) {
        // 添加创建者到成员表
        await this.addMemberToChatroom(roomId, creator.uid, 'user', creator.nickname, creator.avatar_url);
        
        memberList.unshift({
          uid: creator.uid,
          nickname: creator.nickname,
          avatarUrl: creator.avatar_url,
          type: 'user',
          status: 'offline',
          isCreator: true,
          isAdmin: true,
          joinTime: creator.created_at,
          lastActiveTime: Date.now()
        });
      }
    }

    return memberList;
  }

  // 禁言用户
  async muteUser(roomId, targetUid, muterUid, duration = 3600, reason = '') {
    // 检查权限
    const hasPermission = await this.checkAdminPermission(muterUid, roomId);
    if (!hasPermission) {
      throw new Error('没有权限禁言用户');
    }

    // 不能禁言创建者
    const chatroom = await database.get(
      'SELECT creator_uid FROM chatrooms WHERE room_id = ?',
      [roomId]
    );

    if (chatroom && chatroom.creator_uid === targetUid) {
      throw new Error('不能禁言聊天室创建者');
    }

    const muteUntil = Date.now() + (duration * 1000); // 转换为毫秒

    // 记录禁言
    await database.run(`
      INSERT INTO user_mutes (chatroom_id, user_uid, muted_by, reason, mute_until)
      VALUES (?, ?, ?, ?, ?)
    `, [roomId, targetUid, muterUid, reason, muteUntil]);

    // 如果是匿名用户，更新匿名用户表
    const anonymousUser = await database.get(
      'SELECT id FROM anonymous_users WHERE uid = ? AND chatroom_id = ?',
      [targetUid, roomId]
    );

    if (anonymousUser) {
      await database.run(
        'UPDATE anonymous_users SET mute_until = ? WHERE uid = ? AND chatroom_id = ?',
        [muteUntil, targetUid, roomId]
      );
    }

    return {
      success: true,
      message: '用户已被禁言',
      muteUntil,
      duration
    };
  }

  // 解除禁言
  async unmuteUser(roomId, targetUid, unmuterUid) {
    // 检查权限
    const hasPermission = await this.checkAdminPermission(unmuterUid, roomId);
    if (!hasPermission) {
      throw new Error('没有权限解除禁言');
    }

    // 更新禁言记录
    await database.run(
      'UPDATE user_mutes SET is_active = 0 WHERE chatroom_id = ? AND user_uid = ? AND is_active = 1',
      [roomId, targetUid]
    );

    // 如果是匿名用户，更新匿名用户表
    const anonymousUser = await database.get(
      'SELECT id FROM anonymous_users WHERE uid = ? AND chatroom_id = ?',
      [targetUid, roomId]
    );

    if (anonymousUser) {
      await database.run(
        'UPDATE anonymous_users SET is_muted = 0, mute_until = NULL WHERE uid = ? AND chatroom_id = ?',
        [targetUid, roomId]
      );
    }

    return { success: true, message: '禁言已解除' };
  }

  // 检查用户是否被禁言
  async checkUserMuted(uid, roomId) {
    // 检查禁言记录
    const muteRecord = await database.get(`
      SELECT mute_until FROM user_mutes
      WHERE chatroom_id = ? AND user_uid = ? AND is_active = 1
      ORDER BY created_at DESC LIMIT 1
    `, [roomId, uid]);

    if (muteRecord && utils.isUserMuted(muteRecord.mute_until)) {
      return {
        isMuted: true,
        muteUntil: muteRecord.mute_until,
        remaining: utils.getMuteTimeRemaining(muteRecord.mute_until)
      };
    }

    // 检查匿名用户禁言
    const anonymousUser = await database.get(
      'SELECT mute_until FROM anonymous_users WHERE uid = ? AND chatroom_id = ? AND is_active = 1',
      [uid, roomId]
    );

    if (anonymousUser && utils.isUserMuted(anonymousUser.mute_until)) {
      return {
        isMuted: true,
        muteUntil: anonymousUser.mute_until,
        remaining: utils.getMuteTimeRemaining(anonymousUser.mute_until)
      };
    }

    // 没有禁言
    return {
      isMuted: false,
      muteUntil: null,
      remaining: 0
    };
  }

  // 踢出用户
  async kickUser(roomId, targetUid, kickerUid) {
    // 检查聊天室是否存在
    const chatroom = await database.get(
      'SELECT * FROM chatrooms WHERE room_id = ? AND is_active = 1',
      [roomId]
    );

    if (!chatroom) {
      throw new Error('聊天室不存在');
    }

    // 检查权限（只有房主可以踢人）
    if (chatroom.creator_uid !== kickerUid) {
      throw new Error('只有房主可以踢出用户');
    }

    // 不能踢出自己
    if (targetUid === kickerUid) {
      throw new Error('不能踢出自己');
    }

    // 检查目标用户是否在聊天室中
    const member = await database.get(
      'SELECT * FROM chatroom_members WHERE chatroom_id = ? AND user_uid = ? AND is_active = 1',
      [roomId, targetUid]
    );

    if (!member) {
      throw new Error('用户不在聊天室中');
    }

    // 设置用户为已退出状态（踢出等同于强制退出）
    await database.run(
      `UPDATE chatroom_members 
       SET is_active = 0, 
           status = 'left',
           last_active = CURRENT_TIMESTAMP 
       WHERE chatroom_id = ? AND user_uid = ?`,
      [roomId, targetUid]
    );

    // 移除该用户的管理员权限（如果有）
    await database.run(
      'DELETE FROM chatroom_admins WHERE chatroom_id = ? AND user_uid = ?',
      [roomId, targetUid]
    );

    // 移除该用户的禁言状态（如果有）
    await database.run(
      'DELETE FROM user_mutes WHERE user_uid = ? AND chatroom_id = ?',
      [targetUid, roomId]
    );

    return {
      roomId,
      targetUid,
      kickedBy: kickerUid,
      kickedAt: new Date().toISOString()
    };
  }

  // 关闭聊天室
  async closeChatroom(roomId, closerUid) {
    // 检查权限（只有创建者可以关闭）
    const chatroom = await database.get(
      'SELECT creator_uid FROM chatrooms WHERE room_id = ?',
      [roomId]
    );

    if (!chatroom || chatroom.creator_uid !== closerUid) {
      throw new Error('只有聊天室创建者可以关闭聊天室');
    }

    // 获取所有成员列表，用于通知
    const members = await database.all(
      'SELECT user_uid FROM chatroom_members WHERE chatroom_id = ? AND is_active = 1',
      [roomId]
    );

    await database.run(
      'UPDATE chatrooms SET is_active = 0 WHERE room_id = ?',
      [roomId]
    );

    // 停用所有匿名用户
    await database.run(
      'UPDATE anonymous_users SET is_active = 0 WHERE chatroom_id = ?',
      [roomId]
    );

    // 将所有成员设置为已退出状态
    await database.run(
      'UPDATE chatroom_members SET status = "left", is_active = 0, last_active = ? WHERE chatroom_id = ?',
      [Date.now(), roomId]
    );

    return { 
      success: true, 
      message: '聊天室已关闭',
      members: members.map(m => m.user_uid)
    };
  }
}

module.exports = new ChatroomService(); 