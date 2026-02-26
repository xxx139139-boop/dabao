/**
 * 大宝抖音AI托评助手 v2.2.2
 * Content Script - 主入口文件
 * 功能：自动点赞 + AI智能评论（接入DeepSeek）+ 会员系统
 */

(function() {
  'use strict';

  // ==================== 工具类模块 ====================

  class Storage {
    static async get(key) {
      try {
        const result = await chrome.storage.local.get(key);
        return result[key];
      } catch (error) {
        console.error('[大宝AI助手] Storage获取失败:', error);
        return null;
      }
    }
    static async set(key, value) {
      try {
        await chrome.storage.local.set({ [key]: value });
        return true;
      } catch (error) {
        console.error('[大宝AI助手] Storage保存失败:', error);
        return false;
      }
    }
    static async getConfig() {
      const config = await this.get('config');
      return config || this.getDefaultConfig();
    }
    static async setConfig(config) { return await this.set('config', config); }
    static async getStats() {
      const stats = await this.get('stats');
      return stats || this.getDefaultStats();
    }
    static async setStats(stats) { return await this.set('stats', stats); }
    static async getLogs() { return (await this.get('logs')) || []; }
    static async addLog(log) {
      const logs = await this.getLogs();
      logs.unshift({ id: this.generateId(), time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...log });
      if (logs.length > 100) logs.length = 100;
      return await this.set('logs', logs);
    }
    static async clearLogs() { return await this.set('logs', []); }
    static getDefaultConfig() {
      return {
        likeEnabled: false,
        likeMinPerMinute: 20,
        likeMaxPerMinute: 50,
        aiCommentEnabled: false,
        commentInterval: 90,
        aiPrompt: '请根据以下文字和图片内容，以一个真实准备购买的35-55岁买家人设风格生成一条15个字以内的抖音直播间弹幕，只输出弹幕内容本身，不要任何解释',
        aiApiKey: 'sk-db818c2234504dd8a0723772aae6e420',
        sidebarWidth: 400,
        sidebarCollapsed: false,
        serverUrl: 'https://dabao123.cpolar.top',  // 会员服务器地址（固定域名，无需修改）
        machineCode: '' // 本机唯一识别码（自动生成）
      };
    }
    static getDefaultStats() {
      return { totalLikes: 0, totalComments: 0, todayLikes: 0, todayComments: 0, lastResetDate: new Date().toISOString().split('T')[0] };
    }
    static generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }
  }

  class Logger {
    static async add(log) {
      const logEntry = {
        id: Storage.generateId(),
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        type: log.type || 'info',
        source: log.source || 'system',
        message: log.message,
        data: log.data || {}
      };
      try { await Storage.addLog(logEntry); } catch (e) {}
      this.console(logEntry);
      this.emit('log:added', logEntry);
      return logEntry;
    }
    static console(log) {
      const prefix = `[${log.time}][${log.source.toUpperCase()}]`;
      if (log.type === 'success') console.log(`%c${prefix} ${log.message}`, 'color: #00C853', log.data);
      else if (log.type === 'warning') console.warn(`${prefix} ${log.message}`, log.data);
      else if (log.type === 'error') console.error(`${prefix} ${log.message}`, log.data);
      else console.log(`${prefix} ${log.message}`, log.data);
    }
    static async getAll() { return await Storage.getLogs(); }
    static async clear() { await Storage.clearLogs(); this.emit('logs:cleared'); return true; }
    static emit(event, data) { window.dispatchEvent(new CustomEvent(`douyin-helper:${event}`, { detail: data })); }
  }

  // ==================== 机器码 & 离线授权系统 ====================

  class MachineCode {
    static generate() {
      const features = [
        navigator.userAgent,
        screen.width + 'x' + screen.height,
        screen.colorDepth,
        navigator.hardwareConcurrency || 4,
        navigator.language,
        Intl.DateTimeFormat().resolvedOptions().timeZone,
        navigator.platform || '',
        screen.pixelDepth || 24
      ].join('|');
      let hash = 0;
      for (let i = 0; i < features.length; i++) {
        const char = features.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
      }
      const h = Math.abs(hash).toString(16).padStart(8, '0').toUpperCase();
      const raw = (h + h + h + h).substring(0, 16);
      return `${raw.slice(0,4)}-${raw.slice(4,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}`;
    }
    static async getOrCreate() {
      const saved = await Storage.get('machineCode');
      if (saved) return saved;
      const code = this.generate();
      await Storage.set('machineCode', code);
      return code;
    }
  }

  /**
   * 离线授权系统
   * 授权信息通过打包工具写入 license.js，扩展启动时读取并验证
   * 验证逻辑：机器码匹配 + 到期时间校验 + 防篡改哈希校验
   */
  class LicenseAuth {
    // 简单哈希（与打包工具保持一致）
    static simpleHash(str) {
      let h = 5381;
      for (let i = 0; i < str.length; i++) {
        h = ((h << 5) + h) ^ str.charCodeAt(i);
        h = h >>> 0;
      }
      return h.toString(16).padStart(8, '0');
    }

    // XOR解密（与打包工具保持一致）
    static xorDecrypt(encoded, key) {
      try {
        const bytes = atob(encoded);
        let result = '';
        for (let i = 0; i < bytes.length; i++) {
          result += String.fromCharCode(bytes.charCodeAt(i) ^ key.charCodeAt(i % key.length));
        }
        return result;
      } catch(e) {
        return null;
      }
    }

    static async verify(machineCode) {
      try {
        // 读取内嵌授权数据（由打包工具写入）
        const licenseUrl = chrome.runtime.getURL('src/license.js');
        const resp = await fetch(licenseUrl);
        const text = await resp.text();

        // 解析授权数据
        const match = text.match(/window\.__LICENSE__\s*=\s*(\{[\s\S]*?\});/);
        if (!match) return { isVip: false, reason: 'no_license' };

        const lic = JSON.parse(match[1]);
        if (!lic || !lic.d || !lic.m || !lic.c) return { isVip: false, reason: 'invalid_license' };

        // 解密到期时间
        const key = lic.m.substring(0, 8) + 'DB2025';
        const decrypted = this.xorDecrypt(lic.d, key);
        if (!decrypted) return { isVip: false, reason: 'decrypt_failed' };

        let licData;
        try { licData = JSON.parse(decrypted); } catch(e) { return { isVip: false, reason: 'parse_failed' }; }

        // 验证机器码
        if (licData.code !== machineCode) {
          return { isVip: false, reason: 'machine_mismatch' };
        }

        // 验证防篡改哈希
        const checkStr = licData.code + licData.expire + licData.salt;
        const expectedHash = this.simpleHash(checkStr);
        if (lic.c !== expectedHash) {
          return { isVip: false, reason: 'tampered' };
        }

        // 验证到期时间（本地时间 + 网络时间双重校验）
        const now = Date.now();
        const expireTs = licData.expire;
        if (now > expireTs) {
          return { isVip: false, reason: 'expired', expireAt: expireTs };
        }

        // 尝试网络时间校验（防改系统时间）
        try {
          const timeResp = await fetch('https://worldtimeapi.org/api/ip', { signal: AbortSignal.timeout(3000) });
          if (timeResp.ok) {
            const timeData = await timeResp.json();
            const netNow = new Date(timeData.datetime).getTime();
            if (netNow > expireTs) {
              return { isVip: false, reason: 'expired_net', expireAt: expireTs };
            }
          }
        } catch(e) {
          // 网络时间获取失败，仅用本地时间（可接受）
        }

        return { isVip: true, expireAt: expireTs, machineCode: licData.code };
      } catch(e) {
        console.warn('[大宝AI助手] 授权验证异常:', e);
        return { isVip: false, reason: 'error' };
      }
    }
  }

  // ==================== 核心功能模块 ====================

  class ElementFinder {
    static findLiveVideo() {
      const selectors = ['.xgplayer-container video','[data-e2e="live-player"] video','.live-player-video video','.room-player video','video[class*="player"]','video[class*="xgplayer"]','.player video','video'];
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element && this.isVisible(element)) {
          const rect = element.getBoundingClientRect();
          if (rect.width > 300 && rect.height > 200) return element;
        }
      }
      return this.findLargestVideo();
    }
    static findLargestVideo() {
      const videos = document.querySelectorAll('video');
      let largestVideo = null, maxArea = 0;
      videos.forEach(video => {
        if (!this.isVisible(video)) return;
        const rect = video.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area > maxArea && rect.width > 300 && rect.height > 200) { maxArea = area; largestVideo = video; }
      });
      return largestVideo;
    }
    static findCommentInput() {
      const selectors = [
        '[contenteditable="true"][data-e2e="comment-input"]','[contenteditable="true"][data-e2e="chat-input"]',
        '[contenteditable="true"][placeholder*="说点什么"]','[contenteditable="true"][placeholder*="发条评论"]',
        '[contenteditable="true"][placeholder*="和大家聊点什么"]','[contenteditable="true"][placeholder*="评论"]',
        '.comment-input [contenteditable="true"]','.chat-input [contenteditable="true"]',
        '.room-right [contenteditable="true"]','[class*="comment"] [contenteditable="true"]',
        '[class*="chat"] [contenteditable="true"]','textarea[data-e2e="comment-input"]',
        'textarea[placeholder*="说点什么"]','textarea[placeholder*="发条评论"]',
        '.comment-input textarea','.chat-input textarea','#comment-input','#chat-input'
      ];
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element && this.isVisible(element)) {
          const rect = element.getBoundingClientRect();
          if (rect.width > 100 && rect.height > 20) return element;
        }
      }
      return this.findAnyEditableInput();
    }
    static findAnyEditableInput() {
      const editables = Array.from(document.querySelectorAll('[contenteditable="true"]')).sort((a,b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
      for (const el of editables) {
        if (this.isVisible(el)) { const rect = el.getBoundingClientRect(); if (rect.width > 100 && rect.height > 20) return el; }
      }
      const textareas = Array.from(document.querySelectorAll('textarea')).sort((a,b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
      for (const el of textareas) { if (this.isVisible(el)) return el; }
      return null;
    }
    static isVisible(element) {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }
    static getLiveRoomInfo() {
      const info = { title: '', anchor: '', tags: [], recentDanmu: [], roomUrl: window.location.href };
      // 抓取直播标题
      const titleSelectors = ['[data-e2e="live-room-title"]','.room-title','.live-title','[class*="room-title"]','[class*="live-title"]','h1[class*="title"]','.title-text'];
      for (const sel of titleSelectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) { info.title = el.textContent.trim().substring(0, 100); break; }
      }
      if (!info.title) {
        const pageTitle = document.title;
        if (pageTitle && pageTitle !== '抖音直播') info.title = pageTitle.replace(/[-|–].*$/, '').trim().substring(0, 100);
      }
      // 抓取主播名
      const anchorSelectors = ['[data-e2e="anchor-name"]','[data-e2e="live-anchor-name"]','.anchor-name','.user-name','[class*="anchor-name"]','[class*="user-name"]','.nickname'];
      for (const sel of anchorSelectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) { info.anchor = el.textContent.trim().substring(0, 50); break; }
      }
      // 抓取标签
      const tagSelectors = ['[data-e2e="live-tag"]','.live-tag','[class*="tag-item"]','[class*="topic"]','.hashtag'];
      const tagSet = new Set();
      for (const sel of tagSelectors) {
        document.querySelectorAll(sel).forEach(el => { const text = el.textContent.trim(); if (text && text.length < 30) tagSet.add(text); });
      }
      info.tags = Array.from(tagSet).slice(0, 5);
      // 抓取弹幕
      const danmuSelectors = ['[data-e2e="chat-message-item"]','.chat-message-item','[class*="chat-message"]','[class*="danmu-item"]','[class*="comment-item"]','.message-item','[class*="msg-item"]'];
      const danmuSet = new Set();
      for (const sel of danmuSelectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          Array.from(els).slice(-15).forEach(el => {
            const text = el.textContent.trim();
            if (text && text.length > 1 && text.length < 100) danmuSet.add(text.substring(0, 80));
          });
          if (danmuSet.size > 0) break;
        }
      }
      info.recentDanmu = Array.from(danmuSet).slice(0, 15);
      return info;
    }
    static captureVideoFrame() {
      try {
        const video = this.findLiveVideo();
        if (!video || video.readyState < 2) return null;
        const canvas = document.createElement('canvas');
        const maxW = 480, maxH = 270;
        const ratio = Math.min(maxW / (video.videoWidth || maxW), maxH / (video.videoHeight || maxH));
        canvas.width = Math.round((video.videoWidth || maxW) * ratio);
        canvas.height = Math.round((video.videoHeight || maxH) * ratio);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        return dataUrl.split(',')[1];
      } catch (e) {
        console.warn('[大宝AI助手] 截取视频帧失败:', e);
        return null;
      }
    }
  }

  class AntiDetection {
    static init() {
      this.hideWebdriver();
      this.hideChrome();
      this.randomizeBehavior();
      this.spoofTimings();
      this.simulateIdleBehavior();
      this.randomScrollBehavior();
    }
    static hideWebdriver() {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
        delete navigator.webdriver;
      } catch(e) {}
    }
    static hideChrome() {
      if (window.chrome) {
        if (window.chrome.loadTimes) {
          window.chrome.loadTimes = function() {
            return { requestTime: performance.now()/1000, startLoadTime: performance.now()/1000, commitLoadTime: performance.now()/1000, finishDocumentLoadTime: performance.now()/1000, finishLoadTime: performance.now()/1000, firstPaintTime: 0, firstPaintAfterLoadTime: 0, navigationType: 'Other' };
          };
        }
        if (window.chrome.csi) {
          window.chrome.csi = function() { return { startE: performance.now(), onloadT: Date.now(), pageT: performance.now() }; };
        }
      }
    }
    static randomizeBehavior() {
      try {
        Object.defineProperty(navigator, 'plugins', {
          get: function() {
            return [
              { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
              { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
              { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
            ];
          }
        });
      } catch(e) {}
      try { Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] }); } catch(e) {}
    }
    static spoofTimings() {
      try {
        const originalNow = performance.now.bind(performance);
        const jitter = Math.random() * 0.5;
        Object.defineProperty(performance, 'now', { value: () => originalNow() + jitter, configurable: true });
      } catch(e) {}
    }
    // 模拟用户随机滚动行为（轻微，不影响直播观看）
    static randomScrollBehavior() {
      const doRandomScroll = () => {
        if (Math.random() > 0.85) {
          try {
            const scrollEl = document.querySelector('.room-right') || document.querySelector('[class*="chat"]') || document.querySelector('[class*="comment"]');
            if (scrollEl) {
              const delta = (Math.random() - 0.5) * 60;
              scrollEl.scrollTop += delta;
            }
          } catch(e) {}
        }
        setTimeout(doRandomScroll, AntiDetection.humanDelay(8000, 25000));
      };
      setTimeout(doRandomScroll, AntiDetection.humanDelay(15000, 40000));
    }
    // 模拟用户空闲时的随机鼠标微移
    static simulateIdleBehavior() {
      const doIdleMove = () => {
        if (Math.random() > 0.7) {
          try {
            const x = window.innerWidth * (0.1 + Math.random() * 0.8);
            const y = window.innerHeight * (0.1 + Math.random() * 0.8);
            document.dispatchEvent(new MouseEvent('mousemove', {
              bubbles: true, clientX: x, clientY: y,
              screenX: x + window.screenX, screenY: y + window.screenY,
              movementX: (Math.random() - 0.5) * 10, movementY: (Math.random() - 0.5) * 10
            }));
          } catch(e) {}
        }
        setTimeout(doIdleMove, AntiDetection.humanDelay(5000, 20000));
      };
      setTimeout(doIdleMove, AntiDetection.humanDelay(10000, 30000));
    }
    static humanDelay(min, max) {
      let u = 0, v = 0;
      while(u === 0) u = Math.random();
      while(v === 0) v = Math.random();
      const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
      const mean = (min + max) / 2;
      const stdDev = (max - min) / 4;
      return Math.max(min, Math.min(max, Math.round(mean + z * stdDev)));
    }
    static async simulateMouseMove(element) {
      try {
        const rect = element.getBoundingClientRect();
        const targetX = rect.left + rect.width * (0.3 + Math.random() * 0.4);
        const targetY = rect.top + rect.height * (0.3 + Math.random() * 0.4);
        // 使用贝塞尔曲线模拟真实鼠标轨迹
        const startX = targetX + (Math.random() - 0.5) * 300;
        const startY = targetY + (Math.random() - 0.5) * 150;
        const cp1x = startX + (targetX - startX) * 0.3 + (Math.random() - 0.5) * 80;
        const cp1y = startY + (targetY - startY) * 0.3 + (Math.random() - 0.5) * 60;
        const cp2x = startX + (targetX - startX) * 0.7 + (Math.random() - 0.5) * 60;
        const cp2y = startY + (targetY - startY) * 0.7 + (Math.random() - 0.5) * 40;
        const steps = 8 + Math.floor(Math.random() * 7);
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          // 三次贝塞尔曲线公式
          const mt = 1 - t;
          const x = mt*mt*mt*startX + 3*mt*mt*t*cp1x + 3*mt*t*t*cp2x + t*t*t*targetX;
          const y = mt*mt*mt*startY + 3*mt*mt*t*cp1y + 3*mt*t*t*cp2y + t*t*t*targetY;
          // 添加微小抖动模拟手部颤抖
          const jitterX = (Math.random() - 0.5) * 2;
          const jitterY = (Math.random() - 0.5) * 2;
          document.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true,
            clientX: x + jitterX, clientY: y + jitterY,
            screenX: x + jitterX + window.screenX, screenY: y + jitterY + window.screenY,
            movementX: jitterX, movementY: jitterY
          }));
          // 变速移动：中间快，两端慢（ease-in-out）
          const speed = Math.sin(t * Math.PI) * 15 + 5;
          await new Promise(r => setTimeout(r, speed));
        }
        // 到达目标后轻微停顿
        await new Promise(r => setTimeout(r, AntiDetection.humanDelay(80, 200)));
      } catch(e) {}
    }
  }

  class DeepSeekClient {
    constructor(apiKey) { this.apiKey = apiKey; }
    async generateComment(prompt, liveInfo, imageBase64, commentHistory = []) {
      // deepseek-chat 是纯文字模型，将直播信息整合为文字上下文
      const contextParts = [];
      if (liveInfo.title) contextParts.push(`直播标题：${liveInfo.title}`);
      if (liveInfo.anchor) contextParts.push(`主播名：${liveInfo.anchor}`);
      if (liveInfo.tags && liveInfo.tags.length > 0) contextParts.push(`直播标签：${liveInfo.tags.join('、')}`);
      if (liveInfo.recentDanmu && liveInfo.recentDanmu.length > 0) contextParts.push(`最近弹幕：${liveInfo.recentDanmu.slice(0, 8).join(' | ')}`);
      const contextText = contextParts.join('\n');
      // 将历史评论注入到提示词，让模型主动避免重复
      let historyNote = '';
      if (commentHistory && commentHistory.length > 0) {
        historyNote = `\n\n注意：以下是最近已发送过的评论，必须生成与它们内容和表达方式完全不同的新评论：\n${commentHistory.map((c, i) => `${i + 1}. ${c}`).join('\n')}`;
      }
      const fullPrompt = `${prompt}\n\n直播间信息：\n${contextText}${historyNote}`;
      const payload = {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: fullPrompt }],
        max_tokens: 60,
        temperature: 1.0,  // 提高随机性，减少重复
        top_p: 0.95,
        frequency_penalty: 1.5  // 强制降低重复内容的概率
      };
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'CALL_DEEPSEEK_API', payload, apiKey: this.apiKey }, (response) => {
          if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
          if (!response || !response.success) { reject(new Error(response?.error || 'API调用失败')); return; }
          const content = response.data?.choices?.[0]?.message?.content;
          if (!content) { reject(new Error('API返回内容为空')); return; }
          // 先取第一行，再去除首尾引号/括号
          const firstLine = content.trim().split(/\n/)[0].trim();
          const cleaned = firstLine
            .replace(/^["'「『【\[《\u201c\u2018]+/, '')
            .replace(/["'」』】\]》\u201d\u2019]+$/, '')
            .trim()
            .substring(0, 30);
          resolve(cleaned);
        });
      });
    }
  }

  class AutoLike {
    constructor(config = {}) {
      this.config = { enabled: config.enabled || false, minPerMinute: config.minPerMinute || 20, maxPerMinute: config.maxPerMinute || 50 };
      this.state = { isRunning: false, totalLikes: 0, todayLikes: 0 };
      this.timers = [];
    }
    start() {
      if (this.state.isRunning || !this.config.enabled) return;
      this.state.isRunning = true;
      Logger.add({ type: 'info', source: 'like', message: '自动点赞已启动' });
      this.scheduleNextMinute();
      this.emit('like:started');
    }
    stop() {
      if (!this.state.isRunning) return;
      this.state.isRunning = false;
      this.timers.forEach(timer => clearTimeout(timer));
      this.timers = [];
      Logger.add({ type: 'info', source: 'like', message: '自动点赞已停止' });
      this.emit('like:stopped');
    }
    scheduleNextMinute() {
      if (!this.state.isRunning) return;
      const count = AntiDetection.humanDelay(this.config.minPerMinute, this.config.maxPerMinute);
      const interval = 60000 / count;
      for (let i = 0; i < count; i++) {
        const delay = interval * i + AntiDetection.humanDelay(0, Math.floor(interval * 0.3));
        const timer = setTimeout(() => { if (this.state.isRunning) this.performLike(); }, delay);
        this.timers.push(timer);
      }
      const nextTimer = setTimeout(() => { if (this.state.isRunning) { this.timers = []; this.scheduleNextMinute(); } }, 60000 + AntiDetection.humanDelay(-5000, 5000));
      this.timers.push(nextTimer);
    }
    async performLike() {
      try {
        const video = ElementFinder.findLiveVideo();
        if (!video) { Logger.add({ type: 'warning', source: 'like', message: '未找到直播视频' }); return; }
        const rect = video.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const x = rect.left + rect.width * (0.2 + Math.random() * 0.6);
        const y = rect.top + rect.height * (0.2 + Math.random() * 0.6);
        await AntiDetection.simulateMouseMove(video);
        await this.doubleClickAt(x, y);
        this.state.totalLikes++;
        this.state.todayLikes++;
        this.emit('like:success', { count: this.state.totalLikes, today: this.state.todayLikes });
      } catch (error) {
        Logger.add({ type: 'error', source: 'like', message: '点赞异常: ' + error.message });
      }
    }
    async doubleClickAt(x, y) {
      const target = document.elementFromPoint(x, y);
      if (!target) return;
      const events = [
        { type: 'mousedown', buttons: 1, detail: 1 }, { type: 'mouseup', buttons: 0, detail: 1 }, { type: 'click', buttons: 0, detail: 1 },
        { type: 'mousedown', buttons: 1, detail: 2 }, { type: 'mouseup', buttons: 0, detail: 2 }, { type: 'click', buttons: 0, detail: 2 },
        { type: 'dblclick', buttons: 0, detail: 2 }
      ];
      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        target.dispatchEvent(new MouseEvent(ev.type, { bubbles: true, cancelable: true, view: window, clientX: x + (Math.random()-0.5)*2, clientY: y + (Math.random()-0.5)*2, screenX: x + window.screenX, screenY: y + window.screenY, button: 0, buttons: ev.buttons, detail: ev.detail }));
        if (i === 2) await this.delay(AntiDetection.humanDelay(60, 120));
        else if (i < events.length - 1) await this.delay(AntiDetection.humanDelay(8, 20));
      }
    }
    delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
    updateConfig(config) {
      this.config = { ...this.config, ...config };
      if (this.state.isRunning && !this.config.enabled) this.stop();
      else if (!this.state.isRunning && this.config.enabled) this.start();
    }
    emit(event, data) { window.dispatchEvent(new CustomEvent(`douyin-helper:${event}`, { detail: data })); }
  }

  class AIAutoComment {
    constructor(config = {}) {
      this.config = {
        enabled: config.enabled || false,
        interval: config.interval || 90,
        aiPrompt: config.aiPrompt || '请根据以下文字和图片内容，以一个真实准备购买的35-55岁买家人设风格生成一条15个字以内的抖音直播间弹幕，只输出弹幕内容本身，不要任何解释',
        aiApiKey: config.aiApiKey || ''
      };
      this.state = { isRunning: false, isSending: false, isGenerating: false, totalComments: 0, todayComments: 0, retryCount: 0, timerId: null, lastComment: '' };
      this.maxRetries = 3;
      this.deepseekClient = null;
      this.commentHistory = []; // 历史评论记录，用于避免重复
    }
    start() {
      if (this.state.isRunning || !this.config.enabled) return;
      if (!this.config.aiApiKey) { Logger.add({ type: 'warning', source: 'ai', message: '未配置API Key' }); return; }
      this.deepseekClient = new DeepSeekClient(this.config.aiApiKey);
      this.state.isRunning = true;
      Logger.add({ type: 'info', source: 'ai', message: 'AI智能评论已启动', data: { interval: this.config.interval } });
      this.scheduleNextComment(true);
      this.emit('comment:started');
    }
    stop() {
      if (!this.state.isRunning) return;
      this.state.isRunning = false;
      // 重置中间状态，防止关闭时正在生成/发送导致再次打开时被卡住
      this.state.isSending = false;
      this.state.isGenerating = false;
      if (this.state.timerId) { clearTimeout(this.state.timerId); this.state.timerId = null; }
      Logger.add({ type: 'info', source: 'ai', message: 'AI智能评论已停止' });
      this.emit('comment:stopped');
    }
    scheduleNextComment(immediate = false) {
      if (!this.state.isRunning) return;
      if (this.state.timerId) { clearTimeout(this.state.timerId); this.state.timerId = null; }
      let nextInterval;
      if (immediate) {
        nextInterval = AntiDetection.humanDelay(2000, 4000);
      } else {
        const baseInterval = this.config.interval * 1000;
        const variance = baseInterval * 0.2;
        nextInterval = Math.max(5000, baseInterval + (Math.random() - 0.5) * variance);
      }
      Logger.add({ type: 'info', source: 'ai', message: `下次AI评论将在 ${Math.round(nextInterval / 1000)} 秒后生成` });
      this.state.timerId = setTimeout(() => { this.generateAndSend(); }, nextInterval);
    }
    async generateAndSend() {
      if (this.state.isSending || this.state.isGenerating) {
        Logger.add({ type: 'warning', source: 'ai', message: 'AI正在处理中，跳过本次' });
        this.scheduleNextComment();
        return;
      }
      this.state.isGenerating = true;
      this.emit('ai:generating');
      try {
        const liveInfo = ElementFinder.getLiveRoomInfo();
        Logger.add({ type: 'info', source: 'ai', message: `抓取直播信息：${liveInfo.title || '未知标题'} | 主播：${liveInfo.anchor || '未知'}` });
        const imageBase64 = ElementFinder.captureVideoFrame();
        if (imageBase64) Logger.add({ type: 'info', source: 'ai', message: '直播截图已获取' });
        else Logger.add({ type: 'warning', source: 'ai', message: '直播截图获取失败，仅使用文字信息' });
        Logger.add({ type: 'info', source: 'ai', message: '正在调用DeepSeek生成评论...' });
        const comment = await this.deepseekClient.generateComment(this.config.aiPrompt, liveInfo, imageBase64, this.commentHistory);
        if (!comment || comment.length === 0) throw new Error('AI生成评论为空');
        Logger.add({ type: 'success', source: 'ai', message: `AI生成评论：「${comment}」` });
        this.state.isGenerating = false;
        await this.sendComment(comment);
      } catch (error) {
        this.state.isGenerating = false;
        Logger.add({ type: 'error', source: 'ai', message: 'AI生成评论失败: ' + error.message });
        this.handleRetry();
        return;
      }
      this.scheduleNextComment();
    }
    async sendComment(comment) {
      if (this.state.isSending) return;
      this.state.isSending = true;
      try {
        const input = ElementFinder.findCommentInput();
        if (!input) {
          Logger.add({ type: 'warning', source: 'ai', message: '未找到评论输入框' });
          this.state.isSending = false;
          this.handleRetry();
          return;
        }
        await this.simulateHumanInput(input, comment);
        this.state.totalComments++;
        this.state.todayComments++;
        this.state.lastComment = comment;
        this.state.retryCount = 0;
        // 记录到历史，最多保留最近15条，防止重复
        this.commentHistory.push(comment);
        if (this.commentHistory.length > 15) this.commentHistory.shift();
        Logger.add({ type: 'success', source: 'ai', message: `评论发送成功（第${this.state.totalComments}条）`, data: { comment, total: this.state.totalComments } });
        this.emit('comment:success', { text: comment, total: this.state.totalComments, today: this.state.todayComments });
      } catch (error) {
        Logger.add({ type: 'error', source: 'ai', message: '评论发送失败: ' + error.message });
        this.handleRetry();
      } finally {
        this.state.isSending = false;
      }
    }
    async simulateHumanInput(element, text) {
      await AntiDetection.simulateMouseMove(element);
      await this.delay(AntiDetection.humanDelay(100, 300));
      const rect = element.getBoundingClientRect();
      const clickX = rect.left + rect.width * (0.3 + Math.random() * 0.4);
      const clickY = rect.top + rect.height * (0.3 + Math.random() * 0.4);
      element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX: clickX, clientY: clickY }));
      await this.delay(AntiDetection.humanDelay(30, 80));
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, clientX: clickX, clientY: clickY }));
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: clickX, clientY: clickY }));
      element.focus();
      await this.delay(AntiDetection.humanDelay(150, 350));
      // 清空
      if (element.tagName === 'TEXTAREA') { element.value = ''; }
      else if (element.isContentEditable) { element.innerHTML = ''; }
      element.dispatchEvent(new Event('input', { bubbles: true }));
      await this.delay(AntiDetection.humanDelay(80, 150));
      // 设置内容
      if (element.tagName === 'TEXTAREA') {
        const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        valueSetter.call(element, text);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (element.isContentEditable) {
        element.textContent = text;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        // 将光标移到末尾
        const range = document.createRange();
        const sel = window.getSelection();
        range.selectNodeContents(element);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      await this.delay(AntiDetection.humanDelay(300, 600));
      // 回车发送
      element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
      await this.delay(AntiDetection.humanDelay(50, 120));
      element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
      // 清空
      await this.delay(AntiDetection.humanDelay(100, 200));
      if (element.tagName === 'TEXTAREA') { element.value = ''; }
      else if (element.isContentEditable) { element.innerHTML = ''; }
      element.dispatchEvent(new Event('input', { bubbles: true }));
      await this.delay(AntiDetection.humanDelay(400, 800));
    }
    handleRetry() {
      this.state.retryCount++;
      if (this.state.retryCount <= this.maxRetries) {
        Logger.add({ type: 'warning', source: 'ai', message: `第 ${this.state.retryCount} 次重试...` });
        setTimeout(() => { if (this.state.isRunning) this.generateAndSend(); }, 3000 * this.state.retryCount);
      } else {
        this.state.retryCount = 0;
        this.scheduleNextComment();
      }
    }
    delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
    updateConfig(config) {
      this.config = { ...this.config, ...config };
      // 每次updateConfig都重新创建客户端，确保apiKey最新
      this.deepseekClient = new DeepSeekClient(this.config.aiApiKey);
      if (this.state.isRunning && !this.config.enabled) this.stop();
      else if (!this.state.isRunning && this.config.enabled) this.start();
    }
    emit(event, data) { window.dispatchEvent(new CustomEvent(`douyin-helper:${event}`, { detail: data })); }
  }

  // ==================== UI 组件模块 ====================

  class FloatingButton {
    constructor(config = {}) {
      this.config = { visible: config.visible !== false, running: config.running || false, onClick: config.onClick || null };
      this.element = null; this.container = null; this.shadow = null;
    }
    create() {
      const existing = document.getElementById('douyin-helper-floating-btn-host');
      if (existing) existing.remove();
      this.container = document.createElement('div');
      this.container.id = 'douyin-helper-floating-btn-host';
      this.container.style.cssText = 'position: fixed; z-index: 2147483647 !important;';
      this.shadow = this.container.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = this.getStyles();
      this.shadow.appendChild(style);
      this.element = document.createElement('button');
      this.element.className = `douyin-helper-floating-btn ${this.config.running ? 'running' : ''}`;
      this.element.innerHTML = '<span class="btn-text">宝</span><span class="status-indicator"></span><span class="tooltip">打开AI助手</span>';
      this.shadow.appendChild(this.element);
      if (document.body) document.body.appendChild(this.container);
      else setTimeout(() => { if (document.body) document.body.appendChild(this.container); }, 1000);
      this.bindEvents();
      if (!this.config.visible) this.hide();
      this.bringToFront();
      return this;
    }
    bringToFront() {
      setInterval(() => { if (this.container && this.container.parentNode) this.container.parentNode.appendChild(this.container); }, 5000);
    }
    getStyles() {
      return `:host{position:fixed!important;z-index:2147483647!important;pointer-events:none!important}
.douyin-helper-floating-btn{position:fixed;left:24px;bottom:24px;width:56px;height:56px;border-radius:50%;background:#FE2C55;border:none;box-shadow:0 4px 12px rgba(0,0,0,.4);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:bold;color:white;z-index:2147483647;transition:all .25s ease;user-select:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif;pointer-events:auto!important}
.douyin-helper-floating-btn:hover{transform:scale(1.1);background:#FF4766;box-shadow:0 6px 20px rgba(254,44,85,.4)}
.douyin-helper-floating-btn:active{transform:scale(.95);background:#E6284D}
.douyin-helper-floating-btn .btn-text{font-size:22px;font-weight:700}
.douyin-helper-floating-btn .status-indicator{position:absolute;top:2px;right:2px;width:12px;height:12px;border-radius:50%;background:#5C5E6B;border:2px solid #FE2C55;transition:background .15s ease}
.douyin-helper-floating-btn.running .status-indicator{background:#00C853;box-shadow:0 0 8px #00C853}
.douyin-helper-floating-btn.running{animation:pulse 2s infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(254,44,85,.4)}50%{box-shadow:0 0 0 8px rgba(254,44,85,0)}}
.douyin-helper-floating-btn .tooltip{position:absolute;left:64px;bottom:50%;transform:translateY(50%);background:rgba(0,0,0,.8);color:white;padding:6px 12px;border-radius:8px;font-size:12px;white-space:nowrap;opacity:0;visibility:hidden;transition:all .15s ease;font-weight:normal}
.douyin-helper-floating-btn:hover .tooltip{opacity:1;visibility:visible}
.douyin-helper-floating-btn.hidden{transform:scale(0);opacity:0;pointer-events:none}`;
    }
    bindEvents() {
      this.element.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (this.config.onClick) { try { this.config.onClick(); } catch(err) { console.error('[大宝AI助手] FloatingButton点击错误:', err); } }
      }, true);
    }
    show() { this.config.visible = true; this.element.classList.remove('hidden'); }
    hide() { this.config.visible = false; this.element.classList.add('hidden'); }
    setRunning(running) { this.config.running = running; this.element.classList.toggle('running', running); }
  }

  class Sidebar {
    constructor(config = {}) {
      this.config = { width: config.width || 400, collapsed: config.collapsed || false };
      this.element = null; this.container = null; this.shadow = null;
      this.isDragging = false; this.startX = 0; this.startWidth = 0;
      this.onToggleLike = null; this.onToggleAIComment = null; this.onSave = null; this.onReset = null;
      this.monitorState = { startTime: null, timeInterval: null, statusInterval: null, isConnected: false };
    }
    create() {
      this.container = document.createElement('div');
      this.container.id = 'douyin-helper-sidebar-host';
      this.container.style.cssText = 'position: fixed; z-index: 2147483646 !important;';
      this.shadow = this.container.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = this.getStyles();
      this.shadow.appendChild(style);
      this.element = document.createElement('div');
      this.element.className = `douyin-helper-sidebar ${this.config.collapsed ? 'collapsed' : ''}`;
      this.element.style.width = `${this.config.width}px`;
      this.element.innerHTML = this.getHTML();
      this.shadow.appendChild(this.element);
      this.shadowRoot = this.shadow; // 暴露 shadowRoot 供外部访问
      document.body.appendChild(this.container);
      // 在宿主容器上拦截键盘事件，防止 Shadow DOM 内的键盘事件冒泡到 document
      // 注意：需要判断当前焦点元素是否是输入框，否则会阻断所有快捷键
      this.container.addEventListener('keydown', (e) => {
        const tag = e.composedPath && e.composedPath()[0];
        if (tag && (tag.tagName === 'INPUT' || tag.tagName === 'TEXTAREA')) {
          e.stopPropagation();
          e.stopImmediatePropagation();
        }
      }, true);
      this.container.addEventListener('keyup', (e) => {
        const tag = e.composedPath && e.composedPath()[0];
        if (tag && (tag.tagName === 'INPUT' || tag.tagName === 'TEXTAREA')) {
          e.stopPropagation();
          e.stopImmediatePropagation();
        }
      }, true);
      this.container.addEventListener('keypress', (e) => {
        const tag = e.composedPath && e.composedPath()[0];
        if (tag && (tag.tagName === 'INPUT' || tag.tagName === 'TEXTAREA')) {
          e.stopPropagation();
          e.stopImmediatePropagation();
        }
      }, true);
      this.bindEvents();
      this.startMonitoring();
      setTimeout(() => { this.element.classList.add('animate-fadeInLeft'); }, 10);
      return this;
    }
    startMonitoring() {
      this.monitorState.startTime = Date.now();
      this.monitorState.timeInterval = setInterval(() => { this.updateControlTime(); }, 1000);
      this.monitorState.statusInterval = setInterval(() => { this.checkLiveStatus(); }, 3000);
      this.updateControlTime();
      this.checkLiveStatus();
    }
    updateControlTime() {
      if (!this.monitorState.startTime) return;
      const elapsed = Math.floor((Date.now() - this.monitorState.startTime) / 1000);
      const h = Math.floor(elapsed / 3600), m = Math.floor((elapsed % 3600) / 60), s = elapsed % 60;
      const timeEl = this.element.querySelector('#control-time');
      if (timeEl) timeEl.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    }
    checkLiveStatus() {
      try {
        let isConnected = false;
        if (window.location.href.includes('live.douyin.com')) {
          for (const sel of ['video','.xgplayer-container video','[data-e2e="live-player"] video']) {
            const v = document.querySelector(sel);
            if (v && v.readyState >= 1) { isConnected = true; break; }
          }
          if (!isConnected) {
            for (const sel of ['[data-e2e="live-room"]','.room-container','.live-container','[class*="live-room"]']) {
              if (document.querySelector(sel)) { isConnected = true; break; }
            }
          }
        }
        if (this.monitorState.isConnected && !isConnected) this.handleLiveEnd();
        this.monitorState.isConnected = isConnected;
        const dotEl = this.element.querySelector('#status-dot');
        const textEl = this.element.querySelector('#status-text');
        if (dotEl && textEl) {
          dotEl.classList.toggle('connected', isConnected);
          textEl.textContent = isConnected ? '已连接' : '未连接';
        }
      } catch(e) {}
    }
    handleLiveEnd() {
      if (this.onToggleLike) this.onToggleLike(false);
      if (this.onToggleAIComment) this.onToggleAIComment(false);
      const likeToggle = this.element.querySelector('#like-toggle');
      const aiCommentToggle = this.element.querySelector('#ai-comment-toggle');
      if (likeToggle) likeToggle.checked = false;
      if (aiCommentToggle) aiCommentToggle.checked = false;
      this.logLiveEndStats();
    }
    logLiveEndStats() {
      const elapsed = this.monitorState.startTime ? Math.floor((Date.now() - this.monitorState.startTime) / 1000) : 0;
      const h = Math.floor(elapsed / 3600), m = Math.floor((elapsed % 3600) / 60), s = elapsed % 60;
      const timeStr = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
      const totalLikes = window.DouyinHelperState ? window.DouyinHelperState.totalLikes : 0;
      const totalComments = window.DouyinHelperState ? window.DouyinHelperState.totalComments : 0;
      Logger.add({ type: 'info', source: 'system', message: '========== 直播结束统计 ==========' });
      Logger.add({ type: 'info', source: 'system', message: `已中控时长: ${timeStr}` });
      Logger.add({ type: 'info', source: 'system', message: `已点赞总数: ${totalLikes} 次` });
      Logger.add({ type: 'info', source: 'system', message: `已AI评论总数: ${totalComments} 条` });
      Logger.add({ type: 'info', source: 'system', message: '================================' });
    }
    getHTML() {
      return `
        <div class="resize-handle"></div>
        <div class="sidebar-header">
          <div class="title-area">
            <div style="display:flex;flex-direction:column;gap:1px;">
              <h3 class="title">大宝抖音AI托评助手</h3>
              <span style="font-size:10px;color:#64748b;letter-spacing:0.2px;">1361098634@qq.com</span>
            </div>
            <span class="version-tag">v3.0.0</span>
          </div>
          <div class="header-right">
            <div class="member-avatar" id="member-avatar" title="点击查看会员信息">
              <div class="avatar-icon">👤</div>
              <div class="avatar-label" id="avatar-label">免费版</div>
            </div>
            <div class="header-actions">
              <button class="btn-collapse" title="折叠">›</button>
              <button class="btn-close" title="关闭">×</button>
            </div>
          </div>
        </div>
        <div class="monitor-section">
          <div class="monitor-item">
            <span class="monitor-icon">⏱️</span>
            <div class="monitor-info">
              <span class="monitor-label">已中控时间</span>
              <span class="monitor-value" id="control-time">00:00:00</span>
            </div>
          </div>
          <div class="monitor-item">
            <span class="monitor-icon">📡</span>
            <div class="monitor-info">
              <span class="monitor-label">直播间状态</span>
              <span class="monitor-value" id="live-status">
                <span class="status-dot" id="status-dot"></span>
                <span id="status-text">检测中...</span>
              </span>
            </div>
          </div>
        </div>
        <div class="sidebar-content">
          <div class="control-section">
            <div class="section-header">
              <span class="section-title"><span class="section-icon">❤️</span>自动点赞</span>
              <label class="toggle-switch"><input type="checkbox" id="like-toggle"><span class="toggle-slider"></span></label>
            </div>
            <div class="section-body">
              <div class="control-group">
                <label>每分钟次数</label>
                <div class="range-inputs">
                  <input type="number" id="like-min" min="1" max="60" value="20">
                  <span>-</span>
                  <input type="number" id="like-max" min="1" max="60" value="50">
                </div>
              </div>
              <div class="status-bar">
                <span class="status-indicator" id="like-status">已停止</span>
                <span class="count-badge" id="like-count">0 次</span>
              </div>
            </div>
          </div>
          <div class="control-section ai-section">
            <div class="section-header">
              <span class="section-title">
                <span class="section-icon">🤖</span>AI智能评论
                <span class="ai-badge">DeepSeek</span>
                <span class="vip-lock" id="vip-lock" title="会员专属">🔒</span>
              </span>
              <label class="toggle-switch"><input type="checkbox" id="ai-comment-toggle"><span class="toggle-slider ai-slider"></span></label>
            </div>
            <div class="section-body">
              <div class="control-group">
                <label>发送间隔（秒）</label>
                <input type="number" id="comment-interval" min="10" max="3600" value="90">
              </div>
              <div class="control-group">
                <label class="ai-prompt-label">
                  <span>AI预设提示词</span>
                  <span class="label-hint">可根据直播内容修改</span>
                </label>
                <textarea id="ai-prompt" class="ai-prompt-input" rows="4" placeholder="输入给AI的提示词，AI将根据直播标题、主播、弹幕和截图生成评论...">请根据以下文字和图片内容，以一个真实准备购买的35-55岁买家人设风格生成一条15个字以内的抖音直播间弹幕，只输出弹幕内容本身，不要任何解释</textarea>
              </div>
              <div class="status-bar">
                <span class="status-indicator" id="ai-comment-status">已停止</span>
                <span class="count-badge" id="comment-count">已发送 0 条</span>
              </div>
              <div class="ai-generating-hint" id="ai-generating-hint" style="display:none;">
                <span class="generating-dot"></span><span>AI生成中...</span>
              </div>
              <div class="last-comment-bar" id="last-comment-bar" style="display:none;">
                <span class="last-comment-label">上条评论：</span>
                <span class="last-comment-text" id="last-comment-text"></span>
              </div>
            </div>
          </div>
          <div class="log-section">
            <div class="section-header">
              <span class="section-title"><span class="section-icon">📝</span>操作日志</span>
              <button class="btn-clear-logs" id="btn-clear-logs">清空</button>
            </div>
            <div class="log-container" id="log-container">
              <div class="log-empty">暂无日志</div>
            </div>
          </div>
        </div>
        <div class="sidebar-footer">
          <button class="btn-save" id="btn-save">💾 保存配置</button>
          <button class="btn-reset" id="btn-reset">↺ 重置</button>
        </div>
      `;
    }
    getStyles() {
      return `
        :host {
          --color-bg-primary: #161823;
          --color-bg-secondary: #252733;
          --color-accent: #FE2C55;
          --color-accent-hover: #FF4766;
          --color-text-primary: #FFFFFF;
          --color-text-secondary: #8A8B99;
          --color-text-muted: #5C5E6B;
          --color-border: #3A3C4A;
          --color-success: #00C853;
          --color-warning: #FFC107;
          --color-error: #FF1744;
          --color-info: #2196F3;
          --color-ai: #7B68EE;
        }
        .douyin-helper-sidebar {
          position: fixed; left: 0; top: 0; height: 100vh;
          background: var(--color-bg-primary);
          border-right: 1px solid var(--color-border);
          box-shadow: 2px 0 10px rgba(0,0,0,.3);
          z-index: 9999; display: flex; flex-direction: column;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif;
          font-size: 14px; color: var(--color-text-primary);
          overflow: hidden; transition: width .25s ease;
        }
        .resize-handle { position: absolute; right: 0; top: 0; bottom: 0; width: 4px; cursor: col-resize; z-index: 10; }
        .resize-handle:hover, .douyin-helper-sidebar.resizing .resize-handle { background: var(--color-accent); }
        .sidebar-header {
          height: 64px; background: var(--color-bg-secondary);
          border-bottom: 1px solid var(--color-border);
          display: flex; align-items: center; justify-content: space-between;
          padding: 0 12px 0 16px; flex-shrink: 0; gap: 8px;
        }
        .title-area { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; }
        .sidebar-header .title {
          font-size: 13px; font-weight: 600; margin: 0; white-space: nowrap;
          background: linear-gradient(90deg, #FE2C55, #7B68EE);
          -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
        }
        .version-tag {
          font-size: 10px; color: var(--color-text-muted); font-weight: 400;
          background: var(--color-bg-primary); padding: 1px 5px; border-radius: 3px;
          border: 1px solid var(--color-border); white-space: nowrap; flex-shrink: 0;
        }
        .header-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
        .member-avatar {
          display: flex; flex-direction: column; align-items: center; gap: 1px;
          cursor: pointer; padding: 4px 6px; border-radius: 8px;
          border: 1px solid var(--color-border); background: var(--color-bg-primary);
          transition: all .15s ease; min-width: 48px;
        }
        .member-avatar:hover { border-color: var(--color-ai); background: rgba(123,104,238,.1); }
        .member-avatar.vip { border-color: rgba(255,193,7,.4); background: rgba(255,193,7,.08); }
        .avatar-icon { font-size: 16px; line-height: 1; }
        .avatar-label {
          font-size: 9px; color: var(--color-text-muted); white-space: nowrap;
          font-weight: 500; letter-spacing: 0.3px;
        }
        .member-avatar.vip .avatar-label { color: #FFC107; }
        .header-actions { display: flex; gap: 4px; }
        .header-actions button {
          width: 28px; height: 28px; border: none; background: transparent;
          color: var(--color-text-secondary); border-radius: 6px; cursor: pointer;
          font-size: 16px; transition: all .15s ease;
        }
        .header-actions button:hover { background: var(--color-bg-primary); color: var(--color-text-primary); }
        .vip-lock { font-size: 12px; cursor: pointer; }
        .vip-lock.unlocked { display: none; }
        .server-config-section {
          background: var(--color-bg-secondary); border-top: 1px solid var(--color-border);
          padding: 8px 16px; flex-shrink: 0;
        }
        .server-config-row { display: flex; align-items: center; gap: 8px; }
        .server-config-label { font-size: 11px; color: var(--color-text-muted); white-space: nowrap; }
        .server-url-input {
          flex: 1; background: var(--color-bg-primary); border: 1px solid var(--color-border);
          color: var(--color-text-primary); border-radius: 5px; padding: 5px 8px;
          font-size: 11px; outline: none; transition: border-color .15s;
        }
        .server-url-input:focus { border-color: var(--color-ai); }
        .server-url-input::placeholder { color: var(--color-text-muted); font-size: 10px; }
        .monitor-section {
          background: linear-gradient(135deg, rgba(254,44,85,.1) 0%, rgba(37,39,51,.8) 100%);
          border-bottom: 1px solid var(--color-border);
          padding: 12px 16px; display: flex; justify-content: space-around; gap: 12px;
        }
        .monitor-item { display: flex; align-items: center; gap: 8px; flex: 1; }
        .monitor-icon { font-size: 20px; }
        .monitor-info { display: flex; flex-direction: column; gap: 2px; }
        .monitor-label { font-size: 11px; color: var(--color-text-secondary); }
        .monitor-value {
          font-size: 14px; font-weight: 600; color: var(--color-accent);
          font-family: 'Courier New', monospace; display: flex; align-items: center; gap: 6px;
        }
        .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #5C5E6B; display: inline-block; transition: background .3s ease; }
        .status-dot.connected { background: #00C853; box-shadow: 0 0 6px #00C853; }
        .sidebar-content { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 12px; }
        .sidebar-content::-webkit-scrollbar { width: 6px; }
        .sidebar-content::-webkit-scrollbar-thumb { background: var(--color-border); border-radius: 9999px; }
        .sidebar-footer {
          height: 48px; background: var(--color-bg-secondary);
          border-top: 1px solid var(--color-border);
          display: flex; align-items: center; justify-content: center; gap: 12px; padding: 0 16px; flex-shrink: 0;
        }
        .control-section { background: var(--color-bg-secondary); border-radius: 8px; border: 1px solid var(--color-border); }
        .ai-section {
          border-color: rgba(123,104,238,.3);
          background: linear-gradient(135deg, rgba(123,104,238,.05) 0%, var(--color-bg-secondary) 100%);
        }
        .section-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 12px 16px; border-bottom: 1px solid var(--color-border);
        }
        .section-title { display: flex; align-items: center; gap: 8px; font-weight: 600; }
        .ai-badge {
          font-size: 10px; background: linear-gradient(90deg, #7B68EE, #FE2C55);
          color: white; padding: 2px 6px; border-radius: 4px; font-weight: 500;
        }
        .toggle-switch { position: relative; width: 44px; height: 24px; cursor: pointer; }
        .toggle-switch input { opacity: 0; width: 0; height: 0; }
        .toggle-slider {
          position: absolute; top: 0; left: 0; right: 0; bottom: 0;
          background: var(--color-border); border-radius: 9999px; transition: background .15s ease;
        }
        .toggle-slider::before {
          content: ''; position: absolute; height: 18px; width: 18px;
          left: 3px; bottom: 3px; background: white; border-radius: 50%; transition: transform .15s ease;
        }
        .toggle-switch input:checked + .toggle-slider { background: var(--color-accent); }
        .toggle-switch input:checked + .toggle-slider::before { transform: translateX(20px); }
        .toggle-switch input:checked + .ai-slider { background: var(--color-ai) !important; }
        .section-body { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
        .control-group { display: flex; flex-direction: column; gap: 6px; }
        .control-group label { font-size: 12px; color: var(--color-text-secondary); font-weight: 500; }
        .control-group input[type="number"] {
          background: var(--color-bg-primary); border: 1px solid var(--color-border);
          color: var(--color-text-primary); border-radius: 6px; padding: 8px 10px;
          font-size: 13px; width: 100%; box-sizing: border-box; outline: none; transition: border-color .15s ease;
        }
        .control-group input[type="number"]:focus { border-color: var(--color-accent); }
        .range-inputs { display: flex; align-items: center; gap: 8px; }
        .range-inputs input { flex: 1; }
        .range-inputs span { color: var(--color-text-secondary); }
        .ai-prompt-label { display: flex !important; flex-direction: row !important; align-items: center !important; justify-content: space-between !important; }
        .label-hint { font-size: 10px; color: var(--color-ai); font-weight: 400; }
        .ai-prompt-input {
          background: var(--color-bg-primary); border: 1px solid rgba(123,104,238,.3);
          color: var(--color-text-primary); border-radius: 6px; padding: 10px;
          font-size: 12px; width: 100%; box-sizing: border-box; outline: none;
          resize: vertical; min-height: 80px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif;
          line-height: 1.5; transition: border-color .15s ease;
        }
        .ai-prompt-input:focus { border-color: var(--color-ai); box-shadow: 0 0 0 2px rgba(123,104,238,.15); }
        .ai-prompt-input::placeholder { color: var(--color-text-muted); font-size: 11px; }
        .status-bar {
          display: flex; align-items: center; justify-content: space-between;
          padding: 6px 10px; background: var(--color-bg-primary);
          border-radius: 6px; border: 1px solid var(--color-border);
        }
        .status-indicator { font-size: 12px; color: var(--color-text-muted); }
        .status-indicator.running { color: var(--color-success); }
        .status-indicator.ai-running { color: var(--color-ai); }
        .count-badge { font-size: 12px; font-weight: 600; color: var(--color-accent); }
        .ai-generating-hint {
          display: flex; align-items: center; gap: 6px;
          font-size: 11px; color: var(--color-ai); padding: 4px 10px;
        }
        .generating-dot {
          width: 6px; height: 6px; border-radius: 50%;
          background: var(--color-ai); animation: blink 1s infinite;
        }
        @keyframes blink { 0%,100%{opacity:1}50%{opacity:.2} }
        .last-comment-bar {
          display: flex; align-items: flex-start; gap: 6px; padding: 6px 10px;
          background: rgba(123,104,238,.08); border-radius: 6px;
          border: 1px solid rgba(123,104,238,.2); font-size: 12px;
        }
        .last-comment-label { color: var(--color-ai); white-space: nowrap; font-weight: 500; }
        .last-comment-text { color: var(--color-text-primary); line-height: 1.4; }
        .log-section { background: var(--color-bg-secondary); border-radius: 8px; border: 1px solid var(--color-border); display: flex; flex-direction: column; flex: 1; min-height: 0; }
        .btn-clear-logs {
          font-size: 11px; padding: 4px 10px; border-radius: 4px;
          border: 1px solid var(--color-border); background: transparent;
          color: var(--color-text-secondary); cursor: pointer; transition: all .15s ease;
        }
        .btn-clear-logs:hover { border-color: var(--color-error); color: var(--color-error); }
        .log-container { flex: 1; min-height: 0; overflow-y: auto; padding: 8px; }
        .log-container::-webkit-scrollbar { width: 4px; }
        .log-container::-webkit-scrollbar-thumb { background: var(--color-border); border-radius: 9999px; }
        .log-empty { text-align: center; color: var(--color-text-muted); font-size: 12px; padding: 16px; }
        .log-item {
          display: flex; align-items: flex-start; gap: 6px; padding: 4px 6px;
          border-radius: 4px; font-size: 11px; line-height: 1.4; margin-bottom: 2px;
        }
        .log-item:hover { background: rgba(255,255,255,.03); }
        .log-time { color: var(--color-text-muted); white-space: nowrap; flex-shrink: 0; }
        .log-source {
          font-weight: 600; white-space: nowrap; flex-shrink: 0;
          font-size: 10px; padding: 1px 4px; border-radius: 3px;
        }
        .log-source.like { background: rgba(254,44,85,.15); color: var(--color-accent); }
        .log-source.ai { background: rgba(123,104,238,.15); color: var(--color-ai); }
        .log-source.system { background: rgba(33,150,243,.15); color: var(--color-info); }
        .log-source.comment { background: rgba(0,200,83,.15); color: var(--color-success); }
        .log-message { color: var(--color-text-secondary); flex: 1; word-break: break-all; }
        .log-item.success .log-message { color: var(--color-success); }
        .log-item.error .log-message { color: var(--color-error); }
        .log-item.warning .log-message { color: var(--color-warning); }
        .btn-save, .btn-reset {
          flex: 1; height: 32px; border-radius: 4px; font-size: 14px;
          font-weight: 500; cursor: pointer; border: none; transition: all .15s ease;
        }
        .btn-save { background: var(--color-accent); color: white; }
        .btn-save:hover { background: var(--color-accent-hover); }
        .btn-reset { background: transparent; color: var(--color-text-secondary); border: 1px solid var(--color-border) !important; }
        .btn-reset:hover { border-color: var(--color-text-secondary) !important; color: var(--color-text-primary); }
        @keyframes fadeInLeft { from{opacity:0;transform:translateX(-20px)}to{opacity:1;transform:translateX(0)} }
        .animate-fadeInLeft { animation: fadeInLeft .3s ease; }
        .douyin-helper-sidebar.collapsed { width: 40px !important; }
        .douyin-helper-sidebar.collapsed .sidebar-content,
        .douyin-helper-sidebar.collapsed .sidebar-footer { display: none; }
        .douyin-helper-sidebar.collapsed .sidebar-header { padding: 0; justify-content: center; }
        .douyin-helper-sidebar.collapsed .sidebar-header .title,
        .douyin-helper-sidebar.collapsed .btn-close { display: none; }
        .douyin-helper-sidebar .btn-collapse { transition: transform .25s ease; }
        .douyin-helper-sidebar.collapsed .btn-collapse { transform: rotate(180deg); }
      `;
    }
    bindEvents() {
      this.element.querySelector('.resize-handle').addEventListener('mousedown', this.onResizeStart.bind(this));
      this.element.querySelector('.btn-collapse').addEventListener('click', this.toggleCollapse.bind(this));
      this.element.querySelector('.btn-close').addEventListener('click', () => { this.stopMonitoring(); this.hide(); });
      this.element.querySelector('#like-toggle').addEventListener('change', (e) => { if (this.onToggleLike) this.onToggleLike(e.target.checked); });
      this.element.querySelector('#ai-comment-toggle').addEventListener('change', (e) => { if (this.onToggleAIComment) this.onToggleAIComment(e.target.checked); });
      this.element.querySelector('#btn-save').addEventListener('click', () => { if (this.onSave) this.onSave(this.getConfig()); });
      this.element.querySelector('#btn-reset').addEventListener('click', () => { if (this.onReset) this.onReset(); });
      this.element.querySelector('#btn-clear-logs').addEventListener('click', () => this.clearLogs());
      // 头像点击事件：弹出会员信息弹窗
      this.element.querySelector('#member-avatar').addEventListener('click', () => {
        if (this.onMemberAvatarClick) this.onMemberAvatarClick();
      });
      // 修复：阻止输入框的键盘事件冒泡到直播间，避免触发快捷键
      const stopKeyPropagation = (e) => {
        e.stopPropagation();
        e.stopImmediatePropagation();
      };
      const inputEls = this.element.querySelectorAll('input, textarea');
      inputEls.forEach(el => {
        el.addEventListener('keydown', stopKeyPropagation, true);
        el.addEventListener('keyup', stopKeyPropagation, true);
        el.addEventListener('keypress', stopKeyPropagation, true);
      });
    }
    onResizeStart(e) {
      this.isDragging = true; this.startX = e.clientX; this.startWidth = parseInt(this.element.style.width);
      this.element.classList.add('resizing');
      document.addEventListener('mousemove', this.onResizeMove.bind(this));
      document.addEventListener('mouseup', this.onResizeEnd.bind(this));
      e.preventDefault();
    }
    onResizeMove(e) {
      if (!this.isDragging) return;
      let newWidth = Math.max(320, Math.min(600, e.clientX));
      this.element.style.width = `${newWidth}px`; this.config.width = newWidth;
    }
    onResizeEnd() {
      this.isDragging = false; this.element.classList.remove('resizing');
      document.removeEventListener('mousemove', this.onResizeMove.bind(this));
      document.removeEventListener('mouseup', this.onResizeEnd.bind(this));
    }
    toggleCollapse() { this.config.collapsed = !this.config.collapsed; this.element.classList.toggle('collapsed', this.config.collapsed); }
    hide() { this.container.style.display = 'none'; }
    show() { this.container.style.display = 'block'; }
    stopMonitoring() {
      if (this.monitorState.timeInterval) { clearInterval(this.monitorState.timeInterval); this.monitorState.timeInterval = null; }
      if (this.monitorState.statusInterval) { clearInterval(this.monitorState.statusInterval); this.monitorState.statusInterval = null; }
    }
    getConfig() {
      const likeMin = parseInt(this.element.querySelector('#like-min').value) || 20;
      const likeMax = parseInt(this.element.querySelector('#like-max').value) || 50;
      const commentInterval = parseInt(this.element.querySelector('#comment-interval').value) || 90;
      const aiPrompt = this.element.querySelector('#ai-prompt').value.trim();
      return {
        likeEnabled: this.element.querySelector('#like-toggle').checked,
        likeMinPerMinute: Math.min(likeMin, likeMax),
        likeMaxPerMinute: Math.max(likeMin, likeMax),
        aiCommentEnabled: this.element.querySelector('#ai-comment-toggle').checked,
        commentInterval,
        aiPrompt,
        sidebarWidth: this.config.width,
        sidebarCollapsed: this.config.collapsed
      };
    }
    setConfig(config) {
      if (config.likeMinPerMinute !== undefined) this.element.querySelector('#like-min').value = Math.max(20, config.likeMinPerMinute);
      if (config.likeMaxPerMinute !== undefined) this.element.querySelector('#like-max').value = Math.max(20, config.likeMaxPerMinute);
      if (config.commentInterval !== undefined) this.element.querySelector('#comment-interval').value = config.commentInterval;
      if (config.aiPrompt) this.element.querySelector('#ai-prompt').value = config.aiPrompt;
      // serverUrl 已移除，无需设置
    }
    updateMemberStatus(isVip, expireFormatted, machineCode, expired) {
      const avatarEl = this.element.querySelector('#member-avatar');
      const labelEl = this.element.querySelector('#avatar-label');
      const lockEl = this.element.querySelector('#vip-lock');
      if (!avatarEl || !labelEl) return;
      if (isVip) {
        avatarEl.classList.add('vip');
        avatarEl.classList.remove('expired');
        labelEl.textContent = expireFormatted ? `VIP至${expireFormatted}` : 'VIP会员';
        labelEl.style.color = '';
        if (lockEl) lockEl.classList.add('unlocked');
      } else if (expired) {
        avatarEl.classList.remove('vip');
        avatarEl.classList.add('expired');
        labelEl.textContent = '已过期请联系开发者';
        labelEl.style.color = '#FF5252';
        labelEl.style.fontSize = '8px';
        if (lockEl) lockEl.classList.remove('unlocked');
      } else {
        avatarEl.classList.remove('vip');
        avatarEl.classList.remove('expired');
        labelEl.textContent = '免费版';
        labelEl.style.color = '';
        labelEl.style.fontSize = '';
        if (lockEl) lockEl.classList.remove('unlocked');
      }
    }
    updateLikeStatus(running, count) {
      const statusEl = this.element.querySelector('#like-status');
      const countEl = this.element.querySelector('#like-count');
      if (statusEl) { statusEl.textContent = running ? '运行中' : '已停止'; statusEl.className = `status-indicator ${running ? 'running' : ''}`; }
      if (countEl && count !== undefined) countEl.textContent = `${count} 次`;
    }
    updateCommentStatus(running, count, lastComment) {
      const statusEl = this.element.querySelector('#ai-comment-status');
      const countEl = this.element.querySelector('#comment-count');
      if (statusEl) { statusEl.textContent = running ? 'AI运行中' : '已停止'; statusEl.className = `status-indicator ${running ? 'ai-running' : ''}`; }
      if (countEl && count !== undefined) countEl.textContent = `已发送 ${count} 条`;
      if (lastComment) {
        const lastBar = this.element.querySelector('#last-comment-bar');
        const lastText = this.element.querySelector('#last-comment-text');
        if (lastBar && lastText) { lastBar.style.display = 'flex'; lastText.textContent = lastComment; }
      }
    }
    setAIGenerating(generating) {
      const hint = this.element.querySelector('#ai-generating-hint');
      if (hint) hint.style.display = generating ? 'flex' : 'none';
    }
    addLog(log) {
      const container = this.element.querySelector('#log-container');
      if (!container) return;
      const emptyEl = container.querySelector('.log-empty');
      if (emptyEl) emptyEl.remove();
      const item = document.createElement('div');
      item.className = `log-item ${log.type || 'info'}`;
      const sourceClass = log.source || 'system';
      item.innerHTML = `<span class="log-time">${log.time}</span><span class="log-source ${sourceClass}">${sourceClass.toUpperCase()}</span><span class="log-message">${this.escapeHtml(log.message)}</span>`;
      container.insertBefore(item, container.firstChild);
      const items = container.querySelectorAll('.log-item');
      if (items.length > 50) items[items.length - 1].remove();
    }
    clearLogs() {
      const container = this.element.querySelector('#log-container');
      if (container) container.innerHTML = '<div class="log-empty">暂无日志</div>';
      Logger.clear();
    }
    escapeHtml(text) {
      return String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
  }

  // ==================== 主程序 ====================

  if (window.douyinHelperLoaded) { console.log('[大宝AI助手] 已经加载，跳过'); return; }
  window.douyinHelperLoaded = true;

  AntiDetection.init();

  const state = {
    sidebar: null, floatingBtn: null, autoLike: null, aiAutoComment: null,
    config: null, stats: null, totalLikes: 0, totalComments: 0
  };

  window.DouyinHelperState = { totalLikes: 0, totalComments: 0 };

  async function init() {
    console.log('[大宝AI助手] 开始初始化...');
    try {
      await loadConfig();
      createFloatingButton();
      loadLogs();
      console.log('[大宝AI助手] 初始化完成 ✓');
    } catch (error) {
      console.error('[大宝AI助手] 初始化失败:', error);
    }
  }

  async function loadConfig() {
    try {
      state.config = await Storage.getConfig();
      state.stats = await Storage.getStats();
    } catch (error) {
      state.config = Storage.getDefaultConfig();
      state.stats = Storage.getDefaultStats();
    }
  }

  async function loadLogs() {
    try { const logs = await Storage.getLogs(); console.log(`[大宝AI助手] 加载 ${logs.length} 条历史日志`); } catch(e) {}
  }

  function createFloatingButton() {
    state.floatingBtn = new FloatingButton({ visible: true, running: false, onClick: () => toggleSidebar() });
    state.floatingBtn.create();
  }

  function createSidebar() {
    state.totalLikes = 0; state.totalComments = 0;
    window.DouyinHelperState.totalLikes = 0; window.DouyinHelperState.totalComments = 0;
    const existing = document.getElementById('douyin-helper-sidebar-host');
    if (existing) { existing.style.display = 'block'; if (state.floatingBtn) state.floatingBtn.hide(); return; }
    state.sidebar = new Sidebar({ width: state.config.sidebarWidth || 400, collapsed: state.config.sidebarCollapsed || false });
    state.sidebar.onToggleLike = (enabled) => handleLikeToggle(enabled);
    state.sidebar.onToggleAIComment = (enabled) => handleAICommentToggle(enabled);
    state.sidebar.onSave = async (config) => { await saveConfig(config); Logger.add({ type: 'success', source: 'system', message: '配置已保存' }); await refreshMemberStatus(); };
    state.sidebar.onReset = async () => { state.sidebar.setConfig(Storage.getDefaultConfig()); Logger.add({ type: 'info', source: 'system', message: '已重置为默认配置' }); };
    // 头像点击：弹出会员信息弹窗
    state.sidebar.onMemberAvatarClick = () => showMemberModal();
    state.sidebar.create();
    state.sidebar.setConfig(state.config);
    const likeToggle = state.sidebar.element.querySelector('#like-toggle');
    const aiCommentToggle = state.sidebar.element.querySelector('#ai-comment-toggle');
    if (likeToggle) likeToggle.checked = false;
    if (aiCommentToggle) aiCommentToggle.checked = false;
    if (state.floatingBtn) state.floatingBtn.hide();
    window.addEventListener('douyin-helper:log:added', (e) => { if (state.sidebar) state.sidebar.addLog(e.detail); });
    window.addEventListener('douyin-helper:ai:generating', () => { if (state.sidebar) state.sidebar.setAIGenerating(true); });
    // 初始化会员状态
    refreshMemberStatus();
    console.log('[大宝AI助手] 侧边栏创建完成 ✓');
  }

  function toggleSidebar() {
    if (state.sidebar) {
      const isVisible = state.sidebar.container.style.display !== 'none';
      if (isVisible) { state.sidebar.hide(); state.floatingBtn.show(); }
      else { state.sidebar.show(); state.floatingBtn.hide(); }
    } else {
      createSidebar();
    }
  }

  function handleLikeToggle(enabled) {
    state.config.likeEnabled = enabled;
    if (enabled) {
      if (!state.autoLike) {
        state.autoLike = new AutoLike({ enabled: true, minPerMinute: state.config.likeMinPerMinute, maxPerMinute: state.config.likeMaxPerMinute });
        state.autoLike.start();
      } else {
        state.autoLike.updateConfig({ enabled: true, minPerMinute: state.config.likeMinPerMinute, maxPerMinute: state.config.likeMaxPerMinute });
      }
      window.addEventListener('douyin-helper:like:success', handleLikeSuccess);
    } else {
      if (state.autoLike) { state.autoLike.stop(); window.removeEventListener('douyin-helper:like:success', handleLikeSuccess); }
      if (state.sidebar) state.sidebar.updateLikeStatus(false, state.totalLikes);
    }
    updateFloatingBtnStatus();
  }

  function handleAICommentToggle(enabled) {
    state.config.aiCommentEnabled = enabled;
    if (enabled) {
      // 会员权限检查：非 VIP 用户无法使用 AI 评论
      if (!state.memberStatus || !state.memberStatus.isVip) {
        // 关闭开关
        if (state.sidebar) {
          const toggle = state.sidebar.element.querySelector('#ai-comment-toggle');
          if (toggle) toggle.checked = false;
        }
        state.config.aiCommentEnabled = false;
        // 显示浮动提示
        showVipToast();
        return;
      }
      let currentConfig = state.config;
      if (state.sidebar) { const uiConfig = state.sidebar.getConfig(); currentConfig = { ...state.config, ...uiConfig }; state.config = currentConfig; }
      if (!currentConfig.aiApiKey) {
        Logger.add({ type: 'warning', source: 'ai', message: 'API Key未配置，请保存配置后重试' });
        if (state.sidebar) state.sidebar.element.querySelector('#ai-comment-toggle').checked = false;
        state.config.aiCommentEnabled = false;
        return;
      }
      if (!state.aiAutoComment) {
        state.aiAutoComment = new AIAutoComment({ enabled: true, interval: currentConfig.commentInterval, aiPrompt: currentConfig.aiPrompt, aiApiKey: currentConfig.aiApiKey });
        state.aiAutoComment.start();
      } else {
        state.aiAutoComment.updateConfig({ enabled: true, interval: currentConfig.commentInterval, aiPrompt: currentConfig.aiPrompt, aiApiKey: currentConfig.aiApiKey });
      }
      window.addEventListener('douyin-helper:comment:success', handleCommentSuccess);
      if (state.sidebar) state.sidebar.updateCommentStatus(true, state.totalComments);
    } else {
      if (state.aiAutoComment) { state.aiAutoComment.stop(); window.removeEventListener('douyin-helper:comment:success', handleCommentSuccess); }
      if (state.sidebar) { state.sidebar.updateCommentStatus(false, state.totalComments); state.sidebar.setAIGenerating(false); }
    }
    updateFloatingBtnStatus();
  }

  function handleLikeSuccess(e) {
    const { count, today } = e.detail;
    state.stats.totalLikes = count; state.stats.todayLikes = today || state.stats.todayLikes + 1;
    state.totalLikes++; window.DouyinHelperState.totalLikes = state.totalLikes;
    if (state.sidebar) state.sidebar.updateLikeStatus(true, count);
    saveStats();
  }

  function handleCommentSuccess(e) {
    const { text, total, today } = e.detail;
    state.stats.totalComments = total; state.stats.todayComments = today || state.stats.todayComments + 1;
    state.totalComments++; window.DouyinHelperState.totalComments = state.totalComments;
    if (state.sidebar) { state.sidebar.updateCommentStatus(true, total, text); state.sidebar.setAIGenerating(false); }
    saveStats();
  }

  function updateFloatingBtnStatus() {
    if (!state.floatingBtn) return;
    state.floatingBtn.setRunning(state.config.likeEnabled || state.config.aiCommentEnabled);
  }

  // ==================== 会员系统函数 ====================

  function showVipToast() {
    // 在侧边栏内显示浮动提示
    const shadowRoot = state.sidebar && state.sidebar.shadowRoot;
    if (!shadowRoot) return;
    let toast = shadowRoot.querySelector('#vip-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'vip-toast';
      toast.style.cssText = `
        position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
        background: linear-gradient(90deg,#FE2C55,#7B68EE);
        color: white; padding: 10px 18px; border-radius: 20px;
        font-size: 13px; font-weight: 500; z-index: 99999;
        box-shadow: 0 4px 20px rgba(254,44,85,.4);
        white-space: nowrap; pointer-events: none;
        animation: fadeInUp .3s ease;
      `;
      const style = document.createElement('style');
      style.textContent = '@keyframes fadeInUp{from{opacity:0;transform:translateX(-50%) translateY(10px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}';
      shadowRoot.appendChild(style);
      shadowRoot.appendChild(toast);
    }
    toast.textContent = '🔒 AI智能评论为会员专属，请点击右上角头像升级会员';
    toast.style.display = 'block';
    clearTimeout(state._vipToastTimer);
    state._vipToastTimer = setTimeout(() => { toast.style.display = 'none'; }, 3500);
  }

  async function refreshMemberStatus() {
    try {
      const machineCode = await MachineCode.getOrCreate();
      state.machineCode = machineCode;

      // 离线授权验证
      const authResult = await LicenseAuth.verify(machineCode);
      const isVip = authResult.isVip;
      const isExpired = !isVip && authResult.reason && (authResult.reason === 'expired' || authResult.reason === 'expired_net');

      state.memberStatus = {
        isVip,
        expireAt: authResult.expireAt || null,
        expired: isExpired,
        reason: authResult.reason || null
      };

      if (state.sidebar) {
        let expireLabel = null;
        if (isVip && authResult.expireAt) {
          const d = new Date(authResult.expireAt);
          expireLabel = `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
        }
        state.sidebar.updateMemberStatus(isVip, expireLabel, machineCode, isExpired);
      }
    } catch (e) {
      console.warn('[大宝AI助手] 授权验证失败:', e);
      state.memberStatus = { isVip: false };
    }
  }

  function showMemberModal() {
    const shadowRoot = state.sidebar && state.sidebar.shadowRoot;
    if (!shadowRoot) return;
    const existing = shadowRoot.querySelector('#member-modal-overlay');
    if (existing) { existing.remove(); return; }

    const machineCode = state.machineCode || '生成中...';
    const isVip = state.memberStatus && state.memberStatus.isVip;
    const isExpired = state.memberStatus && state.memberStatus.expired;
    let expireLabel = '未开通';
    if (isVip && state.memberStatus.expireAt) {
      const d = new Date(state.memberStatus.expireAt);
      expireLabel = `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
    }

    const qrSrc = chrome.runtime.getURL('images/wechat_qr.png');

    // 状态颜色和文字
    let statusColor = '#7B68EE';
    let statusText = '免费版';
    let statusSub = 'AI智能评论功能需升级会员';
    if (isVip) {
      statusColor = '#FFC107';
      statusText = '⭐ VIP会员';
      statusSub = `到期：${expireLabel}`;
    } else if (isExpired) {
      statusColor = '#FF5252';
      statusText = '已过期';
      statusSub = '请重新购买套餐开通会员';
    }

    const overlay = document.createElement('div');
    overlay.id = 'member-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:99998;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="background:#1e2130;border:1px solid #3A3C4A;border-radius:16px;padding:24px;width:320px;max-height:90vh;overflow-y:auto;position:relative;">
        <button id="modal-close" style="position:absolute;top:12px;right:12px;background:transparent;border:none;color:#8A8B99;font-size:20px;cursor:pointer;line-height:1;">×</button>
        <h3 style="font-size:16px;font-weight:700;background:linear-gradient(90deg,#FE2C55,#7B68EE);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin:0 0 4px;">大宝抖音AI托评助手</h3>
        <div style="font-size:11px;color:#64748b;margin-bottom:14px;">1361098634@qq.com</div>
        <div style="background:#0f1117;border-radius:10px;padding:14px;margin-bottom:14px;">
          <div style="font-size:11px;color:#64748b;margin-bottom:6px;">本机唯一识别码</div>
          <div style="display:flex;align-items:center;gap:8px;">
            <span id="modal-code" style="font-family:'Courier New',monospace;font-size:13px;color:#e2e8f0;letter-spacing:1px;flex:1;">${machineCode}</span>
            <button id="copy-code-btn" style="background:#252733;border:1px solid #3A3C4A;color:#8A8B99;padding:4px 10px;border-radius:5px;font-size:11px;cursor:pointer;white-space:nowrap;">复制</button>
          </div>
        </div>
        <div style="background:${isVip ? 'rgba(255,193,7,.08)' : isExpired ? 'rgba(255,82,82,.08)' : 'rgba(123,104,238,.08)'};border:1px solid ${isVip ? 'rgba(255,193,7,.3)' : isExpired ? 'rgba(255,82,82,.3)' : 'rgba(123,104,238,.3)'};border-radius:10px;padding:12px;margin-bottom:14px;text-align:center;">
          <div style="font-size:12px;color:#8A8B99;margin-bottom:4px;">当前状态</div>
          <div style="font-size:16px;font-weight:700;color:${statusColor}">${statusText}</div>
          <div style="font-size:11px;color:${statusColor};margin-top:4px;opacity:0.8;">${statusSub}</div>
        </div>
        <div style="margin-bottom:14px;">
          <div style="font-size:12px;color:#8A8B99;margin-bottom:8px;text-align:center;">选择套餐</div>
          <div style="display:grid;gap:8px;">
            <div style="background:#252733;border:1px solid #3A3C4A;border-radius:8px;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;">
              <span style="font-size:13px;color:#e2e8f0;">1个月</span>
              <span style="font-size:15px;font-weight:700;color:#FE2C55;">¥99</span>
            </div>
            <div style="background:#252733;border:1px solid #3A3C4A;border-radius:8px;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;">
              <span style="font-size:13px;color:#e2e8f0;">1个季度</span>
              <span style="font-size:15px;font-weight:700;color:#FE2C55;">¥199</span>
            </div>
            <div style="background:linear-gradient(90deg,rgba(254,44,85,.15),rgba(123,104,238,.15));border:1px solid rgba(123,104,238,.3);border-radius:8px;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;">
              <span style="font-size:13px;color:#e2e8f0;">1年 <span style="font-size:10px;color:#7B68EE;">推荐</span></span>
              <span style="font-size:15px;font-weight:700;color:#FE2C55;">¥699</span>
            </div>
          </div>
        </div>
        <div style="text-align:center;margin-bottom:14px;">
          <div style="font-size:12px;color:#8A8B99;margin-bottom:8px;">扫码加微信，发送识别码和套餐即可开通</div>
          <img src="${qrSrc}" style="width:160px;height:160px;border-radius:8px;border:2px solid #3A3C4A;" onerror="this.style.display='none'">
        </div>
        <div style="display:flex;gap:8px;">
          <button id="modal-close2" style="flex:1;padding:10px;background:linear-gradient(90deg,#FE2C55,#7B68EE);border:none;color:white;border-radius:8px;font-size:13px;cursor:pointer;font-weight:600;">确定</button>
        </div>
      </div>
    `;
    shadowRoot.appendChild(overlay);
    shadowRoot.querySelector('#modal-close').addEventListener('click', () => overlay.remove());
    shadowRoot.querySelector('#modal-close2').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    const copyBtn = shadowRoot.querySelector('#copy-code-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(machineCode).then(() => {
          copyBtn.textContent = '已复制✓';
          copyBtn.style.color = '#00C853';
          setTimeout(() => { copyBtn.textContent = '复制'; copyBtn.style.color = ''; }, 2000);
        }).catch(() => {
          const el = document.createElement('textarea');
          el.value = machineCode;
          document.body.appendChild(el);
          el.select();
          document.execCommand('copy');
          document.body.removeChild(el);
          copyBtn.textContent = '已复制✓';
          setTimeout(() => { copyBtn.textContent = '复制'; }, 2000);
        });
      });
    }
  }

  async function saveConfig(config) {
    state.config = { ...state.config, ...config };
    try { await Storage.setConfig(state.config); } catch(e) { console.error('[大宝AI助手] 保存配置失败:', e); }
  }

  async function saveStats() {
    try { await Storage.setStats(state.stats); } catch(e) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.DouyinHelper = {
    toggle: () => toggleSidebar(),
    getState: () => state,
    showBtn: () => state.floatingBtn && state.floatingBtn.show(),
    hideSidebar: () => state.sidebar && state.sidebar.hide(),
    reload: () => {
      if (state.floatingBtn) state.floatingBtn.container.remove();
      if (state.sidebar) state.sidebar.container.remove();
      window.douyinHelperLoaded = false;
      location.reload();
    }
  };

  console.log('[大宝AI助手] v2.2.2 初始化完成，调试接口：DouyinHelper.toggle()');

})();
