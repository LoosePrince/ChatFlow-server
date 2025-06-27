const database = require('../database');
const utils = require('../utils');
const chatroomService = require('./chatroomService');

class MessageService {
  // 发送消息
  async sendMessage(messageData) {
    const { chatroomId, userUid, userType = 'user', content, messageType = 'text', imageUrl = null, replyToMessageId = null, bilibiliId = null, markdownContent = null, fileId = null, fileName = null, fileSize = null, fileExpiry = null } = messageData;

    // 验证消息内容
    if (messageType === 'image') {
      // 图片消息必须有图片URL
      if (!imageUrl) {
        throw new Error('图片消息必须包含图片URL');
      }
      // 图片消息的content可以为空（作为图片说明）
      if (content && content.length > 200) {
        throw new Error('图片说明过长，最多200个字符');
      }
    } else if (messageType === 'bilibili') {
      // B站视频消息必须有BV号
      if (!bilibiliId || typeof bilibiliId !== 'string' || bilibiliId.trim().length === 0) {
        throw new Error('B站视频消息必须包含BV号');
      }
      // 验证BV号格式
      if (!/^BV[a-zA-Z0-9]{10}$/.test(bilibiliId.trim())) {
        throw new Error('BV号格式不正确');
      }
    } else if (messageType === 'markdown') {
      // Markdown消息必须有内容
      if (!markdownContent || typeof markdownContent !== 'string' || markdownContent.trim().length === 0) {
        throw new Error('Markdown消息内容不能为空');
      }
      if (markdownContent.length > 5000) {
        throw new Error('Markdown内容过长，最多5000个字符');
      }
      // content作为标题或简介，可以为空
      if (content && content.length > 100) {
        throw new Error('Markdown标题过长，最多100个字符');
      }
    } else if (messageType === 'file') {
      // 文件消息必须有文件ID和文件信息
      if (!fileId || typeof fileId !== 'string' || fileId.trim().length === 0) {
        throw new Error('文件消息必须包含文件ID');
      }
      if (!fileName || typeof fileName !== 'string' || fileName.trim().length === 0) {
        throw new Error('文件消息必须包含文件名');
      }
      if (!fileSize || typeof fileSize !== 'number' || fileSize <= 0) {
        throw new Error('文件消息必须包含有效的文件大小');
      }
      if (!fileExpiry || typeof fileExpiry !== 'number' || fileExpiry <= 0) {
        throw new Error('文件消息必须包含过期时间');
      }
      // content作为文件名，必须有内容
      if (!content || typeof content !== 'string' || content.trim().length === 0) {
        throw new Error('文件消息必须包含文件名');
      }
    } else {
      // 文本消息必须有内容
      if (!content || typeof content !== 'string' || content.trim().length === 0) {
        throw new Error('消息内容不能为空');
      }

      if (content.length > 1000) {
        throw new Error('消息内容过长，最多1000个字符');
      }
    }

    // 检查用户是否被禁言
    const muteStatus = await chatroomService.checkUserMuted(userUid, chatroomId);
    if (muteStatus.isMuted) {
      const remainingMinutes = Math.ceil(muteStatus.remaining / 60000);
      throw new Error(`您已被禁言，还有 ${remainingMinutes} 分钟解除`);
    }

    // 清理消息内容，防止XSS
    const sanitizedContent = content ? utils.sanitizeText(content) : '';

    // 验证回复消息
    let replyToMessage = null;
    if (replyToMessageId) {
      replyToMessage = await database.get(
        'SELECT * FROM messages WHERE id = ? AND chatroom_id = ?',
        [replyToMessageId, chatroomId]
      );
      if (!replyToMessage) {
        throw new Error('回复的消息不存在');
      }
    }

    // 保存消息到数据库
    const messageId = utils.generateMessageId();
    const result = await database.run(`
      INSERT INTO messages (message_id, chatroom_id, sender_uid, sender_type, content, message_type, image_url, reply_to_message_id, bilibili_bv, markdown_content, file_id, file_name, file_size, file_expiry)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [messageId, chatroomId, userUid, userType, sanitizedContent, messageType, imageUrl, replyToMessageId, bilibiliId, markdownContent, fileId, fileName, fileSize, fileExpiry]);

    // 获取用户信息
    let userInfo;
    if (userType === 'anonymous') {
      const anonymousUser = await database.get(
        'SELECT uid, nickname, avatar_url FROM anonymous_users WHERE uid = ? AND chatroom_id = ?',
        [userUid, chatroomId]
      );
      userInfo = anonymousUser;
    } else {
      const user = await database.get(
        'SELECT uid, nickname, avatar_url FROM users WHERE uid = ?',
        [userUid]
      );
      userInfo = user;
    }

    // 检查是否为管理员
    const isAdmin = await chatroomService.checkAdminPermission(userUid, chatroomId);

    // 构建返回对象
    const messageResult = {
      id: result.id,
      messageId,
      chatroomId,
      userUid,
      userType,
      content: sanitizedContent,
      messageType,
      imageUrl,
      bilibiliId,
      markdownContent,
      fileId,
      fileName,
      fileSize,
      fileExpiry,
      replyToMessageId,
      createdAt: Date.now(),
      user: {
        uid: userInfo.uid,
        nickname: userInfo.nickname,
        avatarUrl: userInfo.avatar_url,
        isAdmin
      }
    };

    // 如果是回复消息，添加被回复消息的信息
    if (replyToMessage) {
      // 获取被回复消息的发送者信息
      let repliedUserInfo;
      if (replyToMessage.sender_type === 'anonymous') {
        const anonymousUser = await database.get(
          'SELECT uid, nickname, avatar_url FROM anonymous_users WHERE uid = ? AND chatroom_id = ?',
          [replyToMessage.sender_uid, chatroomId]
        );
        repliedUserInfo = anonymousUser;
      } else if (replyToMessage.sender_type === 'system') {
        repliedUserInfo = { uid: 'system', nickname: '系统', avatar_url: null };
      } else {
        const user = await database.get(
          'SELECT uid, nickname, avatar_url FROM users WHERE uid = ?',
          [replyToMessage.sender_uid]
        );
        repliedUserInfo = user;
      }

      messageResult.replyToMessage = {
        id: replyToMessage.id,
        content: replyToMessage.content,
        messageType: replyToMessage.message_type,
        createdAt: replyToMessage.created_at,
        user: {
          uid: repliedUserInfo.uid,
          nickname: repliedUserInfo.nickname,
          avatarUrl: repliedUserInfo.avatar_url
        }
      };
    }

    return messageResult;
  }

  // 获取聊天室消息历史
  async getChatroomMessages(chatroomId, userUid, userType = 'user', limit = 50, offset = 0) {
    let messages;

    if (userType === 'anonymous') {
      // 匿名用户只能看到自己加入后的消息
      const anonymousUser = await database.get(
        'SELECT join_time FROM anonymous_users WHERE uid = ? AND chatroom_id = ?',
        [userUid, chatroomId]
      );

      if (!anonymousUser) {
        throw new Error('匿名用户信息不存在');
      }

      messages = await database.all(`
        SELECT m.*, 
               CASE 
                 WHEN m.sender_type = 'anonymous' THEN a.nickname 
                 WHEN m.sender_type = 'system' THEN '系统'
                 ELSE u.nickname 
               END as nickname,
               CASE 
                 WHEN m.sender_type = 'anonymous' THEN a.avatar_url 
                 WHEN m.sender_type = 'system' THEN NULL
                 ELSE u.avatar_url 
               END as avatar_url,
               -- 回复消息信息
               rm.id as reply_msg_id,
               rm.content as reply_content,
               rm.message_type as reply_message_type,
               rm.bilibili_bv as reply_bilibili_bv,
               rm.markdown_content as reply_markdown_content,
               rm.sender_uid as reply_sender_uid,
               rm.sender_type as reply_sender_type,
               rm.created_at as reply_created_at,
               CASE 
                 WHEN rm.sender_type = 'anonymous' THEN ra.nickname 
                 WHEN rm.sender_type = 'system' THEN '系统'
                 ELSE ru.nickname 
               END as reply_nickname,
               CASE 
                 WHEN rm.sender_type = 'anonymous' THEN ra.avatar_url 
                 WHEN rm.sender_type = 'system' THEN NULL
                 ELSE ru.avatar_url 
               END as reply_avatar_url
        FROM messages m
        LEFT JOIN users u ON m.sender_uid = u.uid AND m.sender_type = 'user'
        LEFT JOIN anonymous_users a ON m.sender_uid = a.uid AND m.sender_type = 'anonymous' AND a.chatroom_id = m.chatroom_id
        LEFT JOIN messages rm ON m.reply_to_message_id = rm.id
        LEFT JOIN users ru ON rm.sender_uid = ru.uid AND rm.sender_type = 'user'
        LEFT JOIN anonymous_users ra ON rm.sender_uid = ra.uid AND rm.sender_type = 'anonymous' AND ra.chatroom_id = rm.chatroom_id
        WHERE m.chatroom_id = ? AND m.created_at >= ?
        AND (
          m.message_type != 'system' OR 
          (m.system_message_type = 'persistent' AND (
            m.visibility_scope = 'all' OR 
            (m.visibility_scope = 'specific' AND m.visible_to_users LIKE '%"' || ? || '"%')
          ))
        )
        ORDER BY m.created_at DESC
        LIMIT ? OFFSET ?
      `, [chatroomId, anonymousUser.join_time, userUid, limit, offset]);
    } else {
      // 注册用户可以看到所有历史消息
      messages = await database.all(`
        SELECT m.*,
               CASE 
                 WHEN m.sender_type = 'anonymous' THEN a.nickname 
                 WHEN m.sender_type = 'system' THEN '系统'
                 ELSE u.nickname 
               END as nickname,
               CASE 
                 WHEN m.sender_type = 'anonymous' THEN a.avatar_url 
                 WHEN m.sender_type = 'system' THEN NULL
                 ELSE u.avatar_url 
               END as avatar_url,
               -- 回复消息信息
               rm.id as reply_msg_id,
               rm.content as reply_content,
               rm.message_type as reply_message_type,
               rm.bilibili_bv as reply_bilibili_bv,
               rm.markdown_content as reply_markdown_content,
               rm.sender_uid as reply_sender_uid,
               rm.sender_type as reply_sender_type,
               rm.created_at as reply_created_at,
               CASE 
                 WHEN rm.sender_type = 'anonymous' THEN ra.nickname 
                 WHEN rm.sender_type = 'system' THEN '系统'
                 ELSE ru.nickname 
               END as reply_nickname,
               CASE 
                 WHEN rm.sender_type = 'anonymous' THEN ra.avatar_url 
                 WHEN rm.sender_type = 'system' THEN NULL
                 ELSE ru.avatar_url 
               END as reply_avatar_url
        FROM messages m
        LEFT JOIN users u ON m.sender_uid = u.uid AND m.sender_type = 'user'
        LEFT JOIN anonymous_users a ON m.sender_uid = a.uid AND m.sender_type = 'anonymous' AND a.chatroom_id = m.chatroom_id
        LEFT JOIN messages rm ON m.reply_to_message_id = rm.id
        LEFT JOIN users ru ON rm.sender_uid = ru.uid AND rm.sender_type = 'user'
        LEFT JOIN anonymous_users ra ON rm.sender_uid = ra.uid AND rm.sender_type = 'anonymous' AND ra.chatroom_id = rm.chatroom_id
        WHERE m.chatroom_id = ?
        AND (
          m.message_type != 'system' OR 
          (m.system_message_type = 'persistent' AND (
            m.visibility_scope = 'all' OR 
            (m.visibility_scope = 'specific' AND m.visible_to_users LIKE '%"' || ? || '"%')
          ))
        )
        ORDER BY m.created_at DESC
        LIMIT ? OFFSET ?
      `, [chatroomId, userUid, limit, offset]);
    }

    // 反转消息顺序（最新的在后面）
    messages.reverse();

    // 格式化消息并检查管理员权限
    const formattedMessages = await Promise.all(messages.map(async (msg) => {
      const isAdmin = msg.sender_type === 'system' ? true : await chatroomService.checkAdminPermission(msg.sender_uid, chatroomId);
      
      const formattedMsg = {
        id: msg.id,
        chatroomId: msg.chatroom_id,
        userUid: msg.sender_uid,
        userType: msg.sender_type,
        content: msg.content,
        messageType: msg.message_type,
        imageUrl: msg.image_url,
        bilibiliId: msg.bilibili_bv,
        markdownContent: msg.markdown_content,
        fileId: msg.file_id,
        fileName: msg.file_name,
        fileSize: msg.file_size,
        fileExpiry: msg.file_expiry,
        replyToMessageId: msg.reply_to_message_id,
        createdAt: msg.created_at,
        user: {
          uid: msg.sender_uid,
          nickname: msg.nickname,
          avatarUrl: msg.avatar_url,
          isAdmin
        }
      };

      // 如果有回复消息，添加回复信息
      if (msg.reply_msg_id) {
        formattedMsg.replyToMessage = {
          id: msg.reply_msg_id,
          content: msg.reply_content,
          messageType: msg.reply_message_type,
          bilibiliId: msg.reply_bilibili_bv,
          markdownContent: msg.reply_markdown_content,
          createdAt: msg.reply_created_at,
          user: {
            uid: msg.reply_sender_uid,
            nickname: msg.reply_nickname,
            avatarUrl: msg.reply_avatar_url
          }
        };
      }

      // 如果是系统消息，添加额外字段
      if (msg.message_type === 'system') {
        formattedMsg.systemMessageType = msg.system_message_type;
        formattedMsg.visibilityScope = msg.visibility_scope;
        formattedMsg.visibleToUsers = msg.visible_to_users ? JSON.parse(msg.visible_to_users) : null;
      }

      return formattedMsg;
    }));

    return formattedMessages;
  }

  // 删除消息
  async deleteMessage(messageId, deleterUid, chatroomId) {
    // 获取消息信息
    const message = await database.get(
      'SELECT * FROM messages WHERE id = ? AND chatroom_id = ?',
      [messageId, chatroomId]
    );

    if (!message) {
      throw new Error('消息不存在');
    }

    // 检查权限：用户只能删除自己的消息，管理员可以删除任何消息
    const isAdmin = await chatroomService.checkAdminPermission(deleterUid, chatroomId);
    const isOwner = message.sender_uid === deleterUid;

    if (!isAdmin && !isOwner) {
      throw new Error('没有权限删除此消息');
    }

    try {
      // 开始事务
      await database.beginTransaction();

      // 先处理引用此消息的回复消息（将回复关系清除）
      await database.run(
        'UPDATE messages SET reply_to_message_id = NULL WHERE reply_to_message_id = ?',
        [messageId]
      );

      // 如果是文件消息，需要先处理文件引用并删除物理文件
      if (message.message_type === 'file' && message.file_id) {
        // 获取文件信息
        const fileInfo = await database.get(
          'SELECT stored_name FROM files WHERE file_id = ?',
          [message.file_id]
        );
        
        // 清除文件表中的消息引用，并标记文件为过期
        await database.run(
          'UPDATE files SET is_expired = 1, message_id = NULL WHERE file_id = ?',
          [message.file_id]
        );
        
        // 删除物理文件
        if (fileInfo && fileInfo.stored_name) {
          const fs = require('fs');
          const path = require('path');
          const filePath = path.join(__dirname, '../uploads/files', fileInfo.stored_name);
          
          try {
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
              console.log(`已删除文件: ${fileInfo.stored_name}`);
            }
          } catch (error) {
            console.warn(`删除文件失败: ${fileInfo.stored_name}`, error);
          }
        }
      }

      // 删除消息（物理删除）
      await database.run('DELETE FROM messages WHERE id = ?', [messageId]);

      // 提交事务
      await database.commit();

      return {
        success: true,
        message: '消息已删除',
        messageId,
        deletedBy: deleterUid
      };
    } catch (error) {
      // 回滚事务
      await database.rollback();
      console.error('删除消息失败:', error);
      throw new Error('删除消息失败: ' + error.message);
    }
  }

  // 批量删除用户消息
  async deleteUserMessages(targetUid, chatroomId, deleterUid) {
    // 检查权限（只有管理员可以批量删除用户消息）
    const isAdmin = await chatroomService.checkAdminPermission(deleterUid, chatroomId);
    if (!isAdmin) {
      throw new Error('没有权限批量删除消息');
    }

    // 不能删除创建者的消息
    const chatroom = await database.get(
      'SELECT creator_uid FROM chatrooms WHERE room_id = ?',
      [chatroomId]
    );

    if (chatroom && chatroom.creator_uid === targetUid) {
      throw new Error('不能删除聊天室创建者的消息');
    }

    try {
      // 开始事务
      await database.beginTransaction();
      
      // 获取要删除的文件消息
      const fileMessages = await database.all(`
        SELECT m.id, m.file_id, f.stored_name 
        FROM messages m
        LEFT JOIN files f ON m.file_id = f.file_id
        WHERE m.chatroom_id = ? AND m.sender_uid = ? AND m.is_deleted = 0 AND m.message_type = 'file'
      `, [chatroomId, targetUid]);
      
      // 标记消息为已删除
      const result = await database.run(`
        UPDATE messages 
        SET is_deleted = 1, deleted_by = ?, deleted_at = ? 
        WHERE chatroom_id = ? AND sender_uid = ? AND is_deleted = 0
      `, [deleterUid, Date.now(), chatroomId, targetUid]);
      
      // 处理文件消息的物理文件删除
      if (fileMessages.length > 0) {
        const fs = require('fs');
        const path = require('path');
        
        // 标记相关文件为过期并清除消息引用
        for (const fileMsg of fileMessages) {
          if (fileMsg.file_id) {
            await database.run(
              'UPDATE files SET is_expired = 1, message_id = NULL WHERE file_id = ?',
              [fileMsg.file_id]
            );
            
            // 删除物理文件
            if (fileMsg.stored_name) {
              const filePath = path.join(__dirname, '../uploads/files', fileMsg.stored_name);
              try {
                if (fs.existsSync(filePath)) {
                  fs.unlinkSync(filePath);
                  console.log(`批量删除：已删除文件 ${fileMsg.stored_name}`);
                }
              } catch (error) {
                console.warn(`批量删除：删除文件失败 ${fileMsg.stored_name}`, error);
              }
            }
          }
        }
      }
      
      // 提交事务
      await database.commit();
      
      return {
        success: true,
        message: `已删除 ${result.changes} 条消息，其中包含 ${fileMessages.length} 个文件`,
        deletedCount: result.changes,
        deletedFiles: fileMessages.length
      };
    } catch (error) {
      // 回滚事务
      await database.rollback();
      console.error('批量删除消息失败:', error);
      throw new Error('批量删除消息失败: ' + error.message);
    }
  }

  // 发送系统消息
  async sendSystemMessage(chatroomId, content, options = {}) {
    const {
      systemMessageType = 'persistent', // 'persistent' 或 'temporary'
      visibilityScope = 'all', // 'all' 或 'specific'
      visibleToUsers = null // 当 visibilityScope 为 'specific' 时，指定可见用户UID数组
    } = options;

    const messageId = utils.generateMessageId();
    
    // 如果是临时消息，不保存到数据库，直接返回消息对象用于实时推送
    if (systemMessageType === 'temporary') {
      return {
        id: messageId,
        chatroomId,
        userUid: 'system',
        userType: 'system',
        content,
        messageType: 'system',
        systemMessageType: 'temporary',
        visibilityScope,
        visibleToUsers,
        createdAt: Date.now(),
        user: {
          uid: 'system',
          nickname: '系统',
          avatarUrl: null,
          isAdmin: true
        }
      };
    }

    // 持久系统消息保存到数据库
    const visibleToUsersJson = visibleToUsers ? JSON.stringify(visibleToUsers) : null;
    
    const result = await database.run(`
      INSERT INTO messages (
        message_id, chatroom_id, sender_uid, sender_type, content, message_type,
        system_message_type, visibility_scope, visible_to_users
      )
      VALUES (?, ?, 'system', 'system', ?, 'system', ?, ?, ?)
    `, [messageId, chatroomId, content, systemMessageType, visibilityScope, visibleToUsersJson]);

    return {
      id: result.id,
      chatroomId,
      userUid: 'system',
      userType: 'system',
      content,
      messageType: 'system',
      systemMessageType,
      visibilityScope,
      visibleToUsers,
      createdAt: Date.now(),
      user: {
        uid: 'system',
        nickname: '系统',
        avatarUrl: null,
        isAdmin: true
      }
    };
  }

  // 获取用户消息统计
  async getUserMessageStats(userUid, chatroomId) {
    const stats = await database.get(`
      SELECT 
        COUNT(*) as total_messages,
        COUNT(CASE WHEN is_deleted = 1 THEN 1 END) as deleted_messages,
        MIN(created_at) as first_message_at,
        MAX(created_at) as last_message_at
      FROM messages 
      WHERE sender_uid = ? AND chatroom_id = ?
    `, [userUid, chatroomId]);

    return stats;
  }

  // 搜索消息
  async searchMessages(chatroomId, keyword, userUid, userType = 'user', limit = 20) {
    if (!keyword || keyword.trim().length === 0) {
      return [];
    }

    const searchTerm = `%${keyword.trim()}%`;
    let messages;

    if (userType === 'anonymous') {
      // 匿名用户只能搜索自己加入后的消息
      const anonymousUser = await database.get(
        'SELECT join_time FROM anonymous_users WHERE uid = ? AND chatroom_id = ?',
        [userUid, chatroomId]
      );

      if (!anonymousUser) {
        return [];
      }

      messages = await database.all(`
        SELECT m.*,
               CASE 
                 WHEN m.sender_type = 'anonymous' THEN a.nickname 
                 ELSE u.nickname 
               END as nickname,
               CASE 
                 WHEN m.sender_type = 'anonymous' THEN a.avatar_url 
                 ELSE u.avatar_url 
               END as avatar_url
        FROM messages m
        LEFT JOIN users u ON m.sender_uid = u.uid AND m.sender_type != 'anonymous'
        LEFT JOIN anonymous_users a ON m.sender_uid = a.uid AND m.sender_type = 'anonymous' AND a.chatroom_id = m.chatroom_id
        WHERE m.chatroom_id = ? AND m.is_deleted = 0 AND m.content LIKE ? AND m.created_at >= ?
        ORDER BY m.created_at DESC
        LIMIT ?
      `, [chatroomId, searchTerm, anonymousUser.join_time, limit]);
    } else {
      messages = await database.all(`
        SELECT m.*,
               CASE 
                 WHEN m.sender_type = 'anonymous' THEN a.nickname 
                 ELSE u.nickname 
               END as nickname,
               CASE 
                 WHEN m.sender_type = 'anonymous' THEN a.avatar_url 
                 ELSE u.avatar_url 
               END as avatar_url
        FROM messages m
        LEFT JOIN users u ON m.sender_uid = u.uid AND m.sender_type != 'anonymous'
        LEFT JOIN anonymous_users a ON m.sender_uid = a.uid AND m.sender_type = 'anonymous' AND a.chatroom_id = m.chatroom_id
        WHERE m.chatroom_id = ? AND m.is_deleted = 0 AND m.content LIKE ?
        ORDER BY m.created_at DESC
        LIMIT ?
      `, [chatroomId, searchTerm, limit]);
    }

    // 格式化消息
    const formattedMessages = await Promise.all(messages.map(async (msg) => {
      const isAdmin = await chatroomService.checkAdminPermission(msg.sender_uid, chatroomId);
      
      return {
        id: msg.id,
        chatroomId: msg.chatroom_id,
        userUid: msg.sender_uid,
        userType: msg.sender_type,
        content: msg.content,
        messageType: msg.message_type,
        createdAt: msg.created_at,
        user: {
          uid: msg.sender_uid,
          nickname: msg.nickname,
          avatarUrl: msg.avatar_url,
          isAdmin
        }
      };
    }));

    return formattedMessages;
  }

  // 清理旧消息（定期清理，保留最近N天的消息）
  async cleanupOldMessages(daysToKeep = 30) {
    const cutoffDate = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
    
    try {
      // 开始事务
      await database.beginTransaction();
      
      // 获取要清理的文件消息
      const oldFileMessages = await database.all(`
        SELECT m.file_id, f.stored_name 
        FROM messages m
        LEFT JOIN files f ON m.file_id = f.file_id
        WHERE m.created_at < ? AND m.is_deleted = 1 AND m.message_type = 'file' AND m.file_id IS NOT NULL
      `, [cutoffDate]);
      
      // 删除旧消息
      const result = await database.run(
        'DELETE FROM messages WHERE created_at < ? AND is_deleted = 1',
        [cutoffDate]
      );
      
      // 处理关联的文件
      if (oldFileMessages.length > 0) {
        const fs = require('fs');
        const path = require('path');
        
        for (const fileMsg of oldFileMessages) {
          if (fileMsg.file_id) {
            // 标记文件为过期
            await database.run(
              'UPDATE files SET is_expired = 1, message_id = NULL WHERE file_id = ?',
              [fileMsg.file_id]
            );
            
            // 删除物理文件
            if (fileMsg.stored_name) {
              const filePath = path.join(__dirname, '../uploads/files', fileMsg.stored_name);
              try {
                if (fs.existsSync(filePath)) {
                  fs.unlinkSync(filePath);
                  console.log(`清理：已删除文件 ${fileMsg.stored_name}`);
                }
              } catch (error) {
                console.warn(`清理：删除文件失败 ${fileMsg.stored_name}`, error);
              }
            }
          }
        }
      }
      
      // 提交事务
      await database.commit();
      
      console.log(`清理了 ${result.changes} 条旧消息，删除了 ${oldFileMessages.length} 个关联文件`);
      return {
        deletedMessages: result.changes,
        deletedFiles: oldFileMessages.length
      };
    } catch (error) {
      // 回滚事务
      await database.rollback();
      console.error('清理旧消息失败:', error);
      throw new Error('清理旧消息失败: ' + error.message);
    }
  }
}

module.exports = new MessageService(); 