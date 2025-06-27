const express = require('express');
const router = express.Router();
const axios = require('axios');
const utils = require('../utils');

// B站API代理路由
router.get('/video/:bvid', async (req, res) => {
  try {
    const { bvid } = req.params;
    
    // 验证BVID格式
    if (!bvid || !bvid.match(/^BV[a-zA-Z0-9]+$/)) {
      return res.status(400).json(utils.errorResponse('无效的BVID格式'));
    }
    
    console.log(`正在获取B站视频信息: ${bvid}`);
    
    // 调用B站API
    const response = await axios.get(`https://api.bilibili.com/x/web-interface/view`, {
      params: {
        bvid: bvid
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Referer': 'https://www.bilibili.com/',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site'
      },
      timeout: 10000 // 10秒超时
    });
    
    const data = response.data;
    
    // 检查B站API响应
    if (data.code !== 0) {
      console.error(`B站API返回错误: ${data.code} - ${data.message}`);
      return res.status(400).json(utils.errorResponse(data.message || 'B站API请求失败'));
    }
    
    // 提取需要的数据
    const videoInfo = data.data;
    const result = {
      // 基础信息
      bvid: videoInfo.bvid,
      aid: videoInfo.aid,
      title: videoInfo.title,
      pic: videoInfo.pic,
      desc: videoInfo.desc,
      duration: videoInfo.duration,
      
      // 分辨率信息
      dimension: videoInfo.dimension,
      
      // 时间信息
      pubdate: videoInfo.pubdate,
      ctime: videoInfo.ctime,
      
      // 版权信息
      copyright: videoInfo.copyright,
      
      // 作者信息
      owner: {
        mid: videoInfo.owner.mid,
        name: videoInfo.owner.name,
        face: videoInfo.owner.face
      },
      
      // 统计信息
      stat: {
        view: videoInfo.stat.view,
        danmaku: videoInfo.stat.danmaku,
        reply: videoInfo.stat.reply,
        favorite: videoInfo.stat.favorite,
        coin: videoInfo.stat.coin,
        share: videoInfo.stat.share,
        like: videoInfo.stat.like
      }
    };
    
    console.log(`成功获取视频信息: ${result.title}`);
    res.json(utils.successResponse('获取视频信息成功', result));
    
  } catch (error) {
    console.error('获取B站视频信息失败:', error);
    
    let errorMessage = '获取视频信息失败';
    let statusCode = 500;
    
    if (error.code === 'ENOTFOUND') {
      errorMessage = '无法连接到B站服务器';
      statusCode = 503;
    } else if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      errorMessage = '请求超时，请重试';
      statusCode = 408;
    } else if (error.response) {
      // B站API返回了错误状态码
      statusCode = error.response.status === 404 ? 404 : 400;
      errorMessage = error.response.status === 404 ? '视频不存在或已被删除' : '获取视频信息失败';
    } else if (error.message) {
      errorMessage = error.message;
    }
    
    res.status(statusCode).json(utils.errorResponse(errorMessage));
  }
});

// 获取视频播放地址（可选功能，暂时不实现）
router.get('/video/:bvid/playurl', async (req, res) => {
  res.status(501).json(utils.errorResponse('暂不支持获取播放地址'));
});

module.exports = router; 