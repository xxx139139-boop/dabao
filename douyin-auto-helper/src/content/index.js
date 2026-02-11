/**
 * Content Script - 主入口文件
 * 包含所有模块的依赖注入
 */

// ==================== 工具类模块 ====================

/**
 * Storage 工具类
 */
class Storage {
  static async get(key) {
    try {
      const result = await chrome.storage.local.get(key);
      return result[key];
    } catch (error) {
      console.error('[Storage] 获取失败:', error);
      return null;
    }
  }
  
  static async set(key, value) {
    try {
      await chrome.storage.local.set({ [key]: value });
      return true;
    } catch (error) {
      console.error('[Storage] 保存失败:', error);
      return false;
    }
  }
  
  static async getConfig() {
    const config = await this.get('config');
    return config || this.getDefaultConfig();
  }
  
  static async setConfig(config) {
    return await this.set('config', config);
  }
  
  static async getStats() {
    const stats = await this.get('stats');
    return stats || this.getDefaultStats();
  }
  
  static async setStats(stats) {
    return await this.set('stats', stats);
  }
  
  static async getLogs() {
    const logs = await this.get('logs');
    return logs || [];
  }
  
  static async addLog(log) {
    const logs = await this.getLogs();
    logs.unshift({
      id: this.generateId(),
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      ...log
    });
    
    if (logs.length > 100) {
      logs.length = 100;
    }
    
    return await this.set('logs', logs);
  }
  
  static async clearLogs() {
    return await this.set('logs', []);
  }
  
  static getDefaultConfig() {
    return {
      likeEnabled: false,
      likeMinPerMinute: 20,
      likeMaxPerMinute: 50,
      commentEnabled: false,
      commentInterval: 90,
      commentMode: 'random',
      comments: [],
      smartHistorySize: 10,
      sidebarWidth: 400,
      sidebarCollapsed: false
    };
  }
  
  static getDefaultStats() {
    return {
      totalLikes: 0,
      totalComments: 0,
      todayLikes: 0,
      todayComments: 0,
      lastResetDate: new Date().toISOString().split('T')[0]
    };
  }
  
  static generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }
}

/**
 * Logger 日志系统
 */
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
    
    try {
      await Storage.addLog(logEntry);
    } catch (error) {
      console.error('[Logger] 保存日志失败:', error);
    }
    
    this.console(logEntry);
    this.emit('log:added', logEntry);
    
    return logEntry;
  }
  
  static console(log) {
    const prefix = `[${log.time}][${log.source.toUpperCase()}]`;
    switch (log.type) {
      case 'success':
        console.log(`%c${prefix} ${log.message}`, 'color: #00C853', log.data);
        break;
      case 'warning':
        console.warn(`${prefix} ${log.message}`, log.data);
        break;
      case 'error':
        console.error(`${prefix} ${log.message}`, log.data);
        break;
      default:
        console.log(`${prefix} ${log.message}`, log.data);
    }
  }
  
  static async getAll() {
    return await Storage.getLogs();
  }
  
  static async clear() {
    await Storage.clearLogs();
    this.emit('logs:cleared');
    return true;
  }
  
  static emit(event, data) {
    window.dispatchEvent(new CustomEvent(`douyin-helper:${event}`, { detail: data }));
  }
}

// ==================== 核心功能模块 ====================

/**
 * ElementFinder - 抖音直播间元素查找器
 */
class ElementFinder {
  static findLiveVideo() {
    const selectors = [
      '.xgplayer-container video',
      '[data-e2e="live-player"] video',
      '.live-player-video video',
      '.room-player video',
      'video[class*="player"]',
      'video[class*="xgplayer"]',
      '.player video',
      'video'
    ];
    
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element && this.isVisible(element)) {
        const rect = element.getBoundingClientRect();
        if (rect.width > 300 && rect.height > 200) {
          return element;
        }
      }
    }
    
    return this.findLargestVideo();
  }
  
  static findLargestVideo() {
    const videos = document.querySelectorAll('video');
    let largestVideo = null;
    let maxArea = 0;
    
    videos.forEach(video => {
      if (!this.isVisible(video)) return;
      
      const rect = video.getBoundingClientRect();
      const area = rect.width * rect.height;
      
      if (area > maxArea && rect.width > 300 && rect.height > 200) {
        maxArea = area;
        largestVideo = video;
      }
    });
    
    return largestVideo;
  }
  
  static findCommentInput() {
    const selectors = [
      '[contenteditable="true"][data-e2e="comment-input"]',
      '[contenteditable="true"][data-e2e="chat-input"]',
      '[contenteditable="true"][placeholder*="说点什么"]',
      '[contenteditable="true"][placeholder*="发条评论"]',
      '[contenteditable="true"][placeholder*="和大家聊点什么"]',
      '[contenteditable="true"][placeholder*="评论"]',
      '.comment-input [contenteditable="true"]',
      '.chat-input [contenteditable="true"]',
      '.room-right [contenteditable="true"]',
      '[class*="comment"] [contenteditable="true"]',
      '[class*="chat"] [contenteditable="true"]',
      'textarea[data-e2e="comment-input"]',
      'textarea[data-e2e="chat-input"]',
      'textarea[placeholder*="说点什么"]',
      'textarea[placeholder*="发条评论"]',
      '.comment-input textarea',
      '.chat-input textarea',
      '#comment-input',
      '#chat-input'
    ];
    
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element && this.isVisible(element)) {
        const rect = element.getBoundingClientRect();
        if (rect.width > 100 && rect.height > 20) {
          return element;
        }
      }
    }
    
    return this.findAnyEditableInput();
  }
  
  static findAnyEditableInput() {
    const editables = document.querySelectorAll('[contenteditable="true"]');
    if (editables.length > 0) {
      const sorted = Array.from(editables).sort((a, b) => {
        return b.getBoundingClientRect().top - a.getBoundingClientRect().top;
      });
      
      for (const el of sorted) {
        if (this.isVisible(el)) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 100 && rect.height > 20) {
            return el;
          }
        }
      }
    }
    
    const textareas = document.querySelectorAll('textarea');
    if (textareas.length > 0) {
      const sorted = Array.from(textareas).sort((a, b) => {
        return b.getBoundingClientRect().top - a.getBoundingClientRect().top;
      });
      
      for (const el of sorted) {
        if (this.isVisible(el)) {
          return el;
        }
      }
    }
    
    return null;
  }
  
  static isVisible(element) {
    if (!element) return false;
    
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    
    return rect.width > 0 && 
           rect.height > 0 && 
           style.display !== 'none' && 
           style.visibility !== 'hidden' &&
           style.opacity !== '0';
  }
}

/**
 * AntiDetection - 反检测机制
 */
class AntiDetection {
  static init() {
    this.hideWebdriver();
    this.hideChrome();
    this.randomizeBehavior();
  }
  
  static hideWebdriver() {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true
    });
    delete navigator.webdriver;
  }
  
  static hideChrome() {
    if (window.chrome) {
      if (window.chrome.loadTimes) {
        window.chrome.loadTimes = function() {
          return {
            requestTime: performance.now(),
            startLoadTime: performance.now(),
            commitLoadTime: performance.now(),
            finishDocumentLoadTime: performance.now(),
            finishLoadTime: performance.now(),
            firstPaintTime: 0,
            firstPaintAfterLoadTime: 0,
            navigationType: 'Other'
          };
        };
      }
      
      if (window.chrome.csi) {
        window.chrome.csi = function() {
          return {
            startE: performance.now(),
            onloadT: Date.now(),
            pageT: performance.now()
          };
        };
      }
    }
  }
  
  static randomizeBehavior() {
    try {
      Object.defineProperty(navigator, 'plugins', {
        get: function() {
          return [{ name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' }];
        }
      });
    } catch (e) {}
  }
}

/**
 * AutoLike - 自动点赞核心模块
 */
class AutoLike {
  constructor(config = {}) {
    this.config = {
      enabled: config.enabled || false,
      minPerMinute: config.minPerMinute || 10,
      maxPerMinute: config.maxPerMinute || 50
    };
    
    this.state = {
      isRunning: false,
      totalLikes: 0,
      todayLikes: 0
    };
    
    this.timers = [];
  }
  
  start() {
    if (this.state.isRunning) return;
    if (!this.config.enabled) return;
    
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
    
    const clickCount = this.generateClickCount();
    const intervals = this.generateIntervals(clickCount);
    
    Logger.add({ 
      type: 'info', 
      source: 'like', 
      message: `本分钟计划点赞 ${clickCount} 次，间隔: ${Math.round(intervals[0]/1000)}s - ${Math.round(intervals[intervals.length-1]/1000)}s` 
    });
    
    // 立即执行第一次点赞
    if (intervals.length > 0) {
      const firstTimer = setTimeout(() => {
        if (!this.state.isRunning) return;
        this.performLike();
      }, 0);
      this.timers.push(firstTimer);
      
      // 安排剩余的点击
      for (let i = 1; i < intervals.length; i++) {
        const timer = setTimeout(() => {
          if (!this.state.isRunning) return;
          this.performLike();
        }, intervals[i]);
        this.timers.push(timer);
      }
    }
    
    const nextTimer = setTimeout(() => {
      this.scheduleNextMinute();
    }, 60000);
    this.timers.push(nextTimer);
  }
  
  generateClickCount() {
    const { minPerMinute, maxPerMinute } = this.config;
    return this.normalDistribution(minPerMinute, maxPerMinute);
  }
  
  generateIntervals(count) {
    const intervals = [];
    const minuteMs = 60000;
    
    for (let i = 0; i < count; i++) {
      intervals.push(Math.random() * minuteMs);
    }
    
    intervals.sort((a, b) => a - b);
    
    const minGap = 500;
    for (let i = 1; i < intervals.length; i++) {
      if (intervals[i] - intervals[i - 1] < minGap) {
        intervals[i] = intervals[i - 1] + minGap;
      }
    }
    
    return intervals;
  }
  
  async performLike() {
    try {
      // 查找直播间红心按钮元素
      const heartBtn = this.findHeartButton();
      const container = this.findLiveContainer();
      const video = ElementFinder.findLiveVideo();
      
      if (!container || !video) {
        Logger.add({ type: 'warning', source: 'like', message: '未找到直播容器' });
        return;
      }
      
      const rect = container.getBoundingClientRect();
      
      // 计算点击位置：直播间中央偏下的位置（红心区域）
      // 抖音红心通常在视频中央下方 20-30% 的位置
      let clickX, clickY;
      
      if (heartBtn) {
        // 如果找到红心按钮，点击红心位置
        const heartRect = heartBtn.getBoundingClientRect();
        clickX = heartRect.left + heartRect.width / 2;
        clickY = heartRect.top + heartRect.height / 2;
        Logger.add({ type: 'info', source: 'like', message: `找到红心按钮，点击红心位置` });
      } else {
        // 没有找到红心，点击视频中央偏下位置
        // 随机偏移范围 40-80px，模拟真人操作
        const offsetX = 40 + Math.random() * 40;
        const offsetY = 40 + Math.random() * 40;
        
        // 在中央位置左右随机偏移
        const dirX = Math.random() > 0.5 ? 1 : -1;
        const dirY = Math.random() > 0.5 ? 1 : -1;
        
        clickX = rect.left + rect.width / 2 + offsetX * dirX;
        clickY = rect.top + rect.height * 0.65 + offsetY * dirY; // 偏下位置
        
        // 确保点击在容器范围内
        clickX = Math.max(rect.left + 20, Math.min(rect.right - 20, clickX));
        clickY = Math.max(rect.top + 20, Math.min(rect.bottom - 20, clickY));
      }
      
      Logger.add({ type: 'info', source: 'like', message: `双击位置: X=${Math.round(clickX)}, Y=${Math.round(clickY)}` });
      
      // 优先点击红心按钮
      let success = false;
      if (heartBtn) {
        success = await this.simulateDoubleClick(heartBtn, clickX, clickY);
      }
      
      // 如果失败，尝试点击容器
      if (!success) {
        success = await this.simulateDoubleClick(container, clickX, clickY);
      }
      
      // 最后尝试点击视频
      if (!success) {
        success = await this.simulateDoubleClick(video, clickX, clickY);
      }
      
      if (success) {
        this.state.totalLikes++;
        this.state.todayLikes++;
        
        Logger.add({ 
          type: 'success', 
          source: 'like', 
          message: '点赞成功',
          data: { total: this.state.totalLikes }
        });
        
        this.emit('like:success', {
          count: this.state.totalLikes,
          today: this.state.todayLikes
        });
      } else {
        Logger.add({ type: 'warning', source: 'like', message: '点赞事件未触发' });
      }
      
    } catch (error) {
      Logger.add({ 
        type: 'error', 
        source: 'like', 
        message: '点赞失败',
        data: { error: error.message }
      });
    }
  }
  
  // 查找红心点赞按钮
  findHeartButton() {
    const selectors = [
      '[data-e2e="live-like"]',
      '[class*="like-btn"]',
      '[class*="heart"]',
      '.like-button',
      '.heart-btn',
      '[class*="like-icon"]'
    ];
    
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && this.isVisible(el)) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 20 && rect.height > 20) {
          return el;
        }
      }
    }
    
    return null;
  }
  
  findLiveContainer() {
    const selectors = [
      '.xgplayer-container',
      '[data-e2e="live-player"]',
      '.live-player-video',
      '.room-player',
      '.player-container',
      '.room-container'
    ];
    
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && this.isVisible(el)) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 300 && rect.height > 200) {
          return el;
        }
      }
    }
    
    return document.body;
  }
  
  isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && 
           style.display !== 'none' && 
           style.visibility !== 'hidden' &&
           style.opacity !== '0';
  }
  
  async simulateDoubleClick(element, x, y) {
    try {
      await this.dispatchMouseEvent(element, 'mousedown', x, y, 1);
      await this.delay(30 + Math.random() * 40);
      await this.dispatchMouseEvent(element, 'mouseup', x, y, 1);
      await this.delay(10 + Math.random() * 20);
      await this.dispatchMouseEvent(element, 'click', x, y, 1);
      
      await this.delay(80 + Math.random() * 70);
      await this.dispatchMouseEvent(element, 'mousedown', x, y, 2);
      await this.delay(30 + Math.random() * 40);
      await this.dispatchMouseEvent(element, 'mouseup', x, y, 2);
      await this.delay(10 + Math.random() * 20);
      await this.dispatchMouseEvent(element, 'click', x, y, 2);
      await this.dispatchMouseEvent(element, 'dblclick', x, y, 2);
      
      return true;
    } catch (error) {
      return false;
    }
  }
  
  async dispatchMouseEvent(element, type, x, y, detail) {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x + window.screenX,
      screenY: y + window.screenY,
      button: 0,
      buttons: 1,
      detail: detail
    });
    
    element.dispatchEvent(event);
  }
  
  normalDistribution(min, max) {
    let u = 0, v = 0;
    while(u === 0) u = Math.random();
    while(v === 0) v = Math.random();
    
    const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    const mean = (min + max) / 2;
    const stdDev = (max - min) / 4;
    
    let result = Math.round(mean + z * stdDev);
    return Math.max(min, Math.min(max, result));
  }
  
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  updateConfig(config) {
    this.config = { ...this.config, ...config };
    if (this.state.isRunning && !this.config.enabled) {
      this.stop();
    } else if (!this.state.isRunning && this.config.enabled) {
      this.start();
    }
  }
  
  emit(event, data) {
    window.dispatchEvent(new CustomEvent(`douyin-helper:${event}`, { detail: data }));
  }
}

/**
 * AutoComment - 自动评论核心模块
 */
class AutoComment {
  constructor(config = {}) {
    this.config = {
      enabled: config.enabled || false,
      interval: config.interval || 90,
      mode: config.mode || 'random',
      comments: config.comments || [],
      smartHistorySize: 10
    };
    
    this.state = {
      isRunning: false,
      isSending: false,  // 防止重复发送
      totalComments: 0,
      todayComments: 0,
      currentIndex: 0,
      recentComments: [],
      retryCount: 0,
      timerId: null
    };
    
    this.maxRetries = 3;
  }
  
  start() {
    if (this.state.isRunning) return;
    if (!this.config.enabled) return;
    if (this.config.comments.length === 0) {
      Logger.add({ type: 'warning', source: 'comment', message: '评论列表为空' });
      return;
    }
    
    this.state.isRunning = true;
    Logger.add({ 
      type: 'info', 
      source: 'comment', 
      message: '自动评论已启动',
      data: { mode: this.config.mode }
    });
    
    this.scheduleNextComment();
    this.emit('comment:started');
  }
  
  stop() {
    if (!this.state.isRunning) return;
    
    this.state.isRunning = false;
    if (this.state.timerId) {
      clearTimeout(this.state.timerId);
      this.state.timerId = null;
    }
    
    Logger.add({ type: 'info', source: 'comment', message: '自动评论已停止' });
    this.emit('comment:stopped');
  }
  
  scheduleNextComment() {
    if (!this.state.isRunning) return;
    
    // 清除之前的定时器
    if (this.state.timerId) {
      clearTimeout(this.state.timerId);
      this.state.timerId = null;
    }
    
    const baseInterval = this.config.interval * 1000;
    const variance = baseInterval * 0.2;
    const nextInterval = baseInterval + (Math.random() - 0.5) * variance;
    // 最小间隔改为 3 秒，允许更短的发送间隔
    const finalInterval = Math.max(3000, nextInterval);
    
    Logger.add({ type: 'info', source: 'comment', message: `下次评论将在 ${Math.round(finalInterval / 1000)} 秒后发送` });
    
    this.state.timerId = setTimeout(() => {
      this.sendComment();
    }, finalInterval);
  }
  
  async sendComment() {
    // 防止重复发送
    if (this.state.isSending) {
      Logger.add({ type: 'warning', source: 'comment', message: '评论发送中，跳过本次' });
      return;
    }
    
    this.state.isSending = true;
    
    try {
      const input = ElementFinder.findCommentInput();
      if (!input) {
        Logger.add({ type: 'warning', source: 'comment', message: '未找到评论输入框' });
        this.handleRetry();
        this.state.isSending = false;
        return;
      }
      
      const comment = this.selectComment();
      if (!comment) {
        this.state.isSending = false;
        this.scheduleNextComment();
        return;
      }
      
      await this.simulateInput(input, comment);
      
      this.state.totalComments++;
      this.state.todayComments++;
      this.recordComment(comment);
      
      Logger.add({ 
        type: 'success', 
        source: 'comment', 
        message: '评论发送成功',
        data: { total: this.state.totalComments }
      });
      
      this.emit('comment:success', {
        text: comment,
        total: this.state.totalComments,
        today: this.state.todayComments
      });
      
      this.state.retryCount = 0;
      
    } catch (error) {
      Logger.add({ 
        type: 'error', 
        source: 'comment', 
        message: '评论发送失败',
        data: { error: error.message }
      });
      this.handleRetry();
    } finally {
      this.state.isSending = false;
    }
    
    this.scheduleNextComment();
  }
  
  selectComment() {
    const { comments, mode } = this.config;
    const { recentComments } = this.state;
    
    if (comments.length === 0) return null;
    
    switch (mode) {
      case 'random':
        return comments[Math.floor(Math.random() * comments.length)];
      case 'sequence':
        const seqComment = comments[this.state.currentIndex % comments.length];
        this.state.currentIndex++;
        return seqComment;
      case 'smart':
        const available = comments.filter(c => !recentComments.includes(c));
        const pool = available.length > 0 ? available : comments;
        return pool[Math.floor(Math.random() * pool.length)];
      default:
        return comments[0];
    }
  }
  
  recordComment(comment) {
    this.state.recentComments.unshift(comment);
    if (this.state.recentComments.length > this.config.smartHistorySize) {
      this.state.recentComments.pop();
    }
  }
  
  async simulateInput(element, text) {
    element.focus();
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await this.delay(100 + Math.random() * 200);
    
    // 完全清空输入框
    if (element.tagName === 'TEXTAREA') {
      element.value = '';
    } else if (element.isContentEditable) {
      element.innerHTML = '';
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    
    await this.delay(100);
    
    // 设置内容 - 只设置一次
    if (element.tagName === 'TEXTAREA') {
      const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      ).set;
      valueSetter.call(element, text);
    } else if (element.isContentEditable) {
      element.innerHTML = text;
    }
    
    // 只触发一次 input 事件
    element.dispatchEvent(new Event('input', { bubbles: true }));
    
    await this.delay(300 + Math.random() * 400);
    
    // 模拟回车 - 只触发 keydown
    const enterEvent = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13
    });
    element.dispatchEvent(enterEvent);
    
    // 立即清空输入框，防止再次发送
    await this.delay(100);
    if (element.tagName === 'TEXTAREA') {
      element.value = '';
    } else if (element.isContentEditable) {
      element.innerHTML = '';
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    
    // 等待确保发送完成
    await this.delay(500);
  }
  
  handleRetry() {
    this.state.retryCount++;
    if (this.state.retryCount <= this.maxRetries) {
      setTimeout(() => this.sendComment(), 2000 * this.state.retryCount);
    } else {
      this.state.retryCount = 0;
      this.scheduleNextComment();
    }
  }
  
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  updateConfig(config) {
    const wasRunning = this.state.isRunning;
    const oldInterval = this.config.interval;
    
    this.config = { ...this.config, ...config };
    
    if (this.state.isRunning && !this.config.enabled) {
      this.stop();
    } else if (!this.state.isRunning && this.config.enabled) {
      this.start();
    } else if (wasRunning && this.config.enabled && config.interval !== undefined && config.interval !== oldInterval) {
      // 间隔时间改变，重新调度
      Logger.add({ type: 'info', source: 'comment', message: `评论间隔已更新为 ${config.interval} 秒` });
      this.scheduleNextComment();
    }
  }
  
  emit(event, data) {
    window.dispatchEvent(new CustomEvent(`douyin-helper:${event}`, { detail: data }));
  }
}

// ==================== UI 组件模块 ====================

/**
 * FloatingButton - 浮动按钮组件
 */
class FloatingButton {
  constructor(config = {}) {
    this.config = {
      visible: config.visible !== false,
      running: config.running || false,
      onClick: config.onClick || null
    };
    this.element = null;
    this.container = null;
    this.shadow = null;
  }
  
  create() {
    console.log('[大宝抖音助手] FloatingButton: 开始创建...');
    
    // 检查是否已存在
    const existing = document.getElementById('douyin-helper-floating-btn-host');
    if (existing) {
      console.log('[大宝抖音助手] FloatingButton: 已存在，移除旧按钮');
      existing.remove();
    }
    
    this.container = document.createElement('div');
    this.container.id = 'douyin-helper-floating-btn-host';
    // 确保容器在最上层
    this.container.style.cssText = 'position: fixed; z-index: 2147483647 !important;';
    
    this.shadow = this.container.attachShadow({ mode: 'open' });
    
    const style = document.createElement('style');
    style.textContent = this.getStyles();
    this.shadow.appendChild(style);
    
    this.element = document.createElement('button');
    this.element.className = `douyin-helper-floating-btn ${this.config.running ? 'running' : ''}`;
    this.element.innerHTML = `
      <span class="btn-text">宝</span>
      <span class="status-indicator"></span>
      <span class="tooltip">打开助手</span>
    `;
    
    this.shadow.appendChild(this.element);
    
    // 确保添加到 body 最末尾
    if (document.body) {
      document.body.appendChild(this.container);
      console.log('[大宝抖音助手] FloatingButton: 已添加到 body');
    } else {
      // 如果 body 不存在，等待 DOM 加载
      console.log('[大宝抖音助手] FloatingButton: 等待 body 加载...');
      setTimeout(() => {
        if (document.body) {
          document.body.appendChild(this.container);
          console.log('[大宝抖音助手] FloatingButton: 已添加到 body (延迟)');
        }
      }, 1000);
    }
    
    this.bindEvents();
    
    if (!this.config.visible) {
      this.hide();
    }
    
    // 确保在最上层
    this.bringToFront();
    
    console.log('[大宝抖音助手] FloatingButton: 创建完成');
    return this;
  }
  
  bringToFront() {
    // 定期检查并确保按钮在最上层
    setInterval(() => {
      if (this.container && this.container.parentNode) {
        this.container.parentNode.appendChild(this.container);
      }
    }, 5000);
  }
  
  getStyles() {
    return `
      :host {
        position: fixed !important;
        z-index: 2147483647 !important;
        pointer-events: none !important;
      }
      
      .douyin-helper-floating-btn {
        position: fixed;
        left: 24px;
        bottom: 24px;
        width: 56px;
        height: 56px;
        border-radius: 50%;
        background: #FE2C55;
        border: none;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 24px;
        font-weight: bold;
        color: white;
        z-index: 2147483647;
        transition: all 0.25s ease;
        user-select: none;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif;
        pointer-events: auto !important;
      }
      
      .douyin-helper-floating-btn:hover {
        transform: scale(1.1);
        background: #FF4766;
        box-shadow: 0 6px 20px rgba(254, 44, 85, 0.4);
      }
      
      .douyin-helper-floating-btn:active {
        transform: scale(0.95);
        background: #E6284D;
      }
      
      .douyin-helper-floating-btn .btn-text {
        font-size: 22px;
        font-weight: 700;
      }
      
      .douyin-helper-floating-btn .status-indicator {
        position: absolute;
        top: 2px;
        right: 2px;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: #5C5E6B;
        border: 2px solid #FE2C55;
        transition: background 0.15s ease;
      }
      
      .douyin-helper-floating-btn.running .status-indicator {
        background: #00C853;
        box-shadow: 0 0 8px #00C853;
      }
      
      .douyin-helper-floating-btn.running {
        animation: pulse 2s infinite;
      }
      
      @keyframes pulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(254, 44, 85, 0.4); }
        50% { box-shadow: 0 0 0 8px rgba(254, 44, 85, 0); }
      }
      
      .douyin-helper-floating-btn .tooltip {
        position: absolute;
        left: 64px;
        bottom: 50%;
        transform: translateY(50%);
        background: rgba(0, 0, 0, 0.8);
        color: white;
        padding: 6px 12px;
        border-radius: 8px;
        font-size: 12px;
        white-space: nowrap;
        opacity: 0;
        visibility: hidden;
        transition: all 0.15s ease;
        font-weight: normal;
      }
      
      .douyin-helper-floating-btn:hover .tooltip {
        opacity: 1;
        visibility: visible;
      }
      
      .douyin-helper-floating-btn.hidden {
        transform: scale(0);
        opacity: 0;
        pointer-events: none;
      }
    `;
  }
  
  bindEvents() {
    console.log('[大宝抖音助手] FloatingButton: 绑定点击事件');
    
    // 使用 capture 阶段确保事件被捕获
    this.element.addEventListener('click', (e) => {
      console.log('[大宝抖音助手] FloatingButton: 按钮被点击！');
      e.preventDefault();
      e.stopPropagation();
      
      if (this.config.onClick) {
        try {
          this.config.onClick();
        } catch (err) {
          console.error('[大宝抖音助手] FloatingButton: 点击处理错误:', err);
        }
      }
    }, true);
    
    // 同时绑定 mousedown 作为备选
    this.element.addEventListener('mousedown', (e) => {
      if (e.button === 0) { // 左键
        console.log('[大宝抖音助手] FloatingButton: mousedown 触发');
      }
    });
  }
  
  show() {
    this.config.visible = true;
    this.element.classList.remove('hidden');
  }
  
  hide() {
    this.config.visible = false;
    this.element.classList.add('hidden');
  }
  
  setRunning(running) {
    this.config.running = running;
    this.element.classList.toggle('running', running);
  }
}

/**
 * Sidebar - 侧边栏组件
 */
class Sidebar {
  constructor(config = {}) {
    this.config = {
      width: config.width || 400,
      collapsed: config.collapsed || false
    };
    this.element = null;
    this.container = null;
    this.shadow = null;
    this.isDragging = false;
    this.startX = 0;
    this.startWidth = 0;
    
    this.onToggleLike = null;
    this.onToggleComment = null;
    this.onSave = null;
    this.onReset = null;
    
    // 监测相关状态
    this.monitorState = {
      startTime: null,
      timeInterval: null,
      statusInterval: null,
      isConnected: false
    };
  }
  
  create() {
    console.log('[大宝抖音助手] Sidebar: 开始创建侧边栏...');
    
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
    document.body.appendChild(this.container);
    
    this.bindEvents();
    
    // 启动监测功能
    this.startMonitoring();
    
    setTimeout(() => {
      this.element.classList.add('animate-fadeInLeft');
    }, 10);
    
    return this;
  }
  
  // 启动监测功能
  startMonitoring() {
    // 记录开始时间
    this.monitorState.startTime = Date.now();
    
    // 每秒更新时间显示
    this.monitorState.timeInterval = setInterval(() => {
      this.updateControlTime();
    }, 1000);
    
    // 每3秒检查一次直播间状态
    this.monitorState.statusInterval = setInterval(() => {
      this.checkLiveStatus();
    }, 3000);
    
    // 立即执行一次
    this.updateControlTime();
    this.checkLiveStatus();
  }
  
  // 更新中控时间显示
  updateControlTime() {
    if (!this.monitorState.startTime) return;
    
    const elapsed = Math.floor((Date.now() - this.monitorState.startTime) / 1000);
    const hours = Math.floor(elapsed / 3600);
    const minutes = Math.floor((elapsed % 3600) / 60);
    const seconds = elapsed % 60;
    
    const timeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    
    const timeEl = this.element.querySelector('#control-time');
    if (timeEl) {
      timeEl.textContent = timeStr;
    }
  }
  
  // 检查直播间连接状态
  checkLiveStatus() {
    try {
      let isConnected = false;
      
      // 方法1：检查URL
      if (window.location.href.includes('live.douyin.com')) {
        // 方法2：检查直播视频元素
        const videoSelectors = [
          'video',
          '.xgplayer-container video',
          '[data-e2e="live-player"] video',
          '.live-player-video'
        ];
        
        for (const selector of videoSelectors) {
          const video = document.querySelector(selector);
          if (video && video.readyState >= 1) {
            isConnected = true;
            break;
          }
        }
        
        // 方法3：检查直播间特征元素
        if (!isConnected) {
          const liveIndicators = [
            '[data-e2e="live-room"]',
            '.room-container',
            '.live-container',
            '[class*="live-room"]',
            '.audience-list'
          ];
          
          for (const selector of liveIndicators) {
            if (document.querySelector(selector)) {
              isConnected = true;
              break;
            }
          }
        }
      }
      
      // 检测到下播（从连接到未连接）
      if (this.monitorState.isConnected && !isConnected) {
        console.log('[大宝抖音助手] 检测到直播间已结束，自动停止自动化');
        this.handleLiveEnd();
      }
      
      // 保存连接状态
      this.monitorState.isConnected = isConnected;
      
      // 更新状态显示
      const dotEl = this.element.querySelector('#status-dot');
      const textEl = this.element.querySelector('#status-text');
      
      if (dotEl && textEl) {
        if (isConnected) {
          dotEl.classList.add('connected');
          textEl.textContent = '已连接';
        } else {
          dotEl.classList.remove('connected');
          textEl.textContent = '未连接';
        }
      }
    } catch (error) {
      console.log('[大宝抖音助手] 检查直播间状态失败:', error);
    }
  }
  
  // 处理直播结束
  handleLiveEnd() {
    // 停止自动点赞和评论
    if (this.onToggleLike) {
      this.onToggleLike(false);
    }
    if (this.onToggleComment) {
      this.onToggleComment(false);
    }
    
    // 关闭开关UI
    const likeToggle = this.element.querySelector('#like-toggle');
    const commentToggle = this.element.querySelector('#comment-toggle');
    if (likeToggle) likeToggle.checked = false;
    if (commentToggle) commentToggle.checked = false;
    
    // 在日志里显示统计数据
    this.logLiveEndStats();
  }
  
  // 记录直播结束统计到日志
  logLiveEndStats() {
    // 获取统计数据
    const elapsed = this.monitorState.startTime ? 
      Math.floor((Date.now() - this.monitorState.startTime) / 1000) : 0;
    const hours = Math.floor(elapsed / 3600);
    const minutes = Math.floor((elapsed % 3600) / 60);
    const seconds = elapsed % 60;
    const timeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    
    // 获取统计数据
    const totalLikes = window.DouyinHelperState ? window.DouyinHelperState.totalLikes : 0;
    const totalComments = window.DouyinHelperState ? window.DouyinHelperState.totalComments : 0;
    
    // 记录到日志
    Logger.add({ type: 'info', source: 'system', message: '========== 直播结束统计 ==========' });
    Logger.add({ type: 'info', source: 'system', message: `已中控时长: ${timeStr}` });
    Logger.add({ type: 'info', source: 'system', message: `已点赞总数: ${totalLikes} 次` });
    Logger.add({ type: 'info', source: 'system', message: `已评论总数: ${totalComments} 条` });
    Logger.add({ type: 'info', source: 'system', message: '================================' });
  }
  
  // 显示直播结束统计
  showLiveEndSummary() {
    // 获取统计数据
    const elapsed = this.monitorState.startTime ? 
      Math.floor((Date.now() - this.monitorState.startTime) / 1000) : 0;
    const hours = Math.floor(elapsed / 3600);
    const minutes = Math.floor((elapsed % 3600) / 60);
    const seconds = elapsed % 60;
    const timeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    
    // 获取总点赞数和总评论数（从state中获取）
    const totalLikes = window.DouyinHelperState ? window.DouyinHelperState.totalLikes : 0;
    const totalComments = window.DouyinHelperState ? window.DouyinHelperState.totalComments : 0;
    
    // 创建统计弹窗
    const summaryDiv = document.createElement('div');
    summaryDiv.className = 'live-end-summary';
    summaryDiv.innerHTML = `
      <div class="summary-overlay"></div>
      <div class="summary-content">
        <h3>🎉 直播已结束</h3>
        <div class="summary-stats">
          <div class="stat-item">
            <span class="stat-label">已中控时间</span>
            <span class="stat-value">${timeStr}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">已点赞总数</span>
            <span class="stat-value">${totalLikes} 次</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">已评论总数</span>
            <span class="stat-value">${totalComments} 条</span>
          </div>
        </div>
        <button class="btn-close-summary" onclick="this.closest('.live-end-summary').remove()">关闭</button>
      </div>
    `;
    
    this.shadow.appendChild(summaryDiv);
    
    // 5秒后自动关闭
    setTimeout(() => {
      if (summaryDiv.parentNode) {
        summaryDiv.remove();
      }
    }, 10000);
  }
  
  getHTML() {
    return `
      <div class="resize-handle"></div>
      <div class="sidebar-header">
        <h3 class="title">大宝抖音全自动中控助手</h3>
        <div class="header-actions">
          <button class="btn-collapse" title="折叠">›</button>
          <button class="btn-close" title="关闭">×</button>
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
            <label class="toggle-switch">
              <input type="checkbox" id="like-toggle">
              <span class="toggle-slider"></span>
            </label>
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
        <div class="control-section">
          <div class="section-header">
            <span class="section-title"><span class="section-icon">💬</span>自动评论</span>
            <label class="toggle-switch">
              <input type="checkbox" id="comment-toggle">
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="section-body">
            <div class="control-group">
              <label>发送间隔（秒）</label>
              <input type="number" id="comment-interval" min="5" max="3600" value="90">
            </div>
            <div class="control-group">
              <label>发送模式</label>
              <select id="comment-mode">
                <option value="random">随机循环</option>
                <option value="sequence">按顺序</option>
                <option value="smart">智能去重</option>
              </select>
            </div>
            <div class="control-group">
              <label>评论列表（<span id="comment-count-display">0</span>/50）</label>
              <div id="comment-list" class="comment-list-container" contenteditable="true" placeholder="输入评论，每行一条..."></div>
              <div class="control-actions">
                <button class="btn-import" id="btn-import">📁 导入</button>
                <button class="btn-clear" id="btn-clear-comments">🗑️ 清空</button>
              </div>
              <input type="file" id="file-import" accept=".txt" style="display: none;">
            </div>
            <div class="status-bar">
              <span class="status-indicator" id="comment-status">已停止</span>
              <span class="count-badge" id="comment-count">0 条</span>
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
      }
      
      .douyin-helper-sidebar {
        position: fixed;
        left: 0;
        top: 0;
        height: 100vh;
        background: var(--color-bg-primary);
        border-right: 1px solid var(--color-border);
        box-shadow: 2px 0 10px rgba(0, 0, 0, 0.3);
        z-index: 9999;
        display: flex;
        flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif;
        font-size: 14px;
        color: var(--color-text-primary);
        overflow: hidden;
        transition: width 0.25s ease;
      }
      
      .resize-handle {
        position: absolute;
        right: 0;
        top: 0;
        bottom: 0;
        width: 4px;
        cursor: col-resize;
        z-index: 10;
      }
      
      .resize-handle:hover, .douyin-helper-sidebar.resizing .resize-handle {
        background: var(--color-accent);
      }
      
      .sidebar-header {
        height: 56px;
        background: var(--color-bg-secondary);
        border-bottom: 1px solid var(--color-border);
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 16px;
        flex-shrink: 0;
      }
      
      .sidebar-header .title {
        font-size: 16px;
        font-weight: 600;
        margin: 0;
      }
      
      .header-actions {
        display: flex;
        gap: 8px;
      }
      
      .header-actions button {
        width: 32px;
        height: 32px;
        border: none;
        background: transparent;
        color: var(--color-text-secondary);
        border-radius: 8px;
        cursor: pointer;
        font-size: 18px;
        transition: all 0.15s ease;
      }
      
      .header-actions button:hover {
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
      }
      
      .monitor-section {
        background: linear-gradient(135deg, rgba(254, 44, 85, 0.1) 0%, rgba(37, 39, 51, 0.8) 100%);
        border-bottom: 1px solid var(--color-border);
        padding: 12px 16px;
        display: flex;
        justify-content: space-around;
        gap: 12px;
      }
      
      .monitor-item {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: 1;
      }
      
      .monitor-icon {
        font-size: 20px;
      }
      
      .monitor-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      
      .monitor-label {
        font-size: 11px;
        color: var(--color-text-secondary);
      }
      
      .monitor-value {
        font-size: 14px;
        font-weight: 600;
        color: var(--color-accent);
        font-family: 'Courier New', monospace;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      
      .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #5C5E6B;
        display: inline-block;
        transition: background 0.3s ease;
      }
      
      .status-dot.connected {
        background: #00C853;
        box-shadow: 0 0 6px #00C853;
      }
      
      .sidebar-content {
        flex: 1;
        overflow-y: auto;
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      
      .sidebar-content::-webkit-scrollbar {
        width: 6px;
      }
      
      .sidebar-content::-webkit-scrollbar-thumb {
        background: var(--color-border);
        border-radius: 9999px;
      }
      
      .sidebar-footer {
        height: 48px;
        background: var(--color-bg-secondary);
        border-top: 1px solid var(--color-border);
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 12px;
        padding: 0 16px;
        flex-shrink: 0;
      }
      
      .control-section {
        background: var(--color-bg-secondary);
        border-radius: 8px;
        border: 1px solid var(--color-border);
      }
      
      .section-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid var(--color-border);
      }
      
      .section-title {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 600;
      }
      
      .toggle-switch {
        position: relative;
        width: 44px;
        height: 24px;
        cursor: pointer;
      }
      
      .toggle-switch input {
        opacity: 0;
        width: 0;
        height: 0;
      }
      
      .toggle-slider {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: var(--color-border);
        border-radius: 9999px;
        transition: background 0.15s ease;
      }
      
      .toggle-slider::before {
        content: '';
        position: absolute;
        height: 18px;
        width: 18px;
        left: 3px;
        bottom: 3px;
        background: white;
        border-radius: 50%;
        transition: transform 0.15s ease;
      }
      
      .toggle-switch input:checked + .toggle-slider {
        background: var(--color-accent);
      }
      
      .toggle-switch input:checked + .toggle-slider::before {
        transform: translateX(20px);
      }
      
      .section-body {
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      
      /* 直播结束统计弹窗 */
      .live-end-summary {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      
      .live-end-summary .summary-overlay {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.7);
      }
      
      .live-end-summary .summary-content {
        position: relative;
        background: var(--color-bg-secondary);
        border: 1px solid var(--color-border);
        border-radius: 12px;
        padding: 24px;
        min-width: 280px;
        text-align: center;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      }
      
      .live-end-summary h3 {
        color: var(--color-accent);
        font-size: 18px;
        margin: 0 0 20px 0;
      }
      
      .live-end-summary .summary-stats {
        display: flex;
        flex-direction: column;
        gap: 12px;
        margin-bottom: 20px;
      }
      
      .live-end-summary .stat-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 12px;
        background: var(--color-bg-primary);
        border-radius: 6px;
      }
      
      .live-end-summary .stat-label {
        color: var(--color-text-secondary);
        font-size: 13px;
      }
      
      .live-end-summary .stat-value {
        color: var(--color-accent);
        font-size: 15px;
        font-weight: 600;
        font-family: 'Courier New', monospace;
      }
      
      .live-end-summary .btn-close-summary {
        background: var(--color-accent);
        color: white;
        border: none;
        padding: 10px 24px;
        border-radius: 6px;
        font-size: 14px;
        cursor: pointer;
        transition: background 0.2s;
      }
      
      .live-end-summary .btn-close-summary:hover {
        background: var(--color-accent-hover);
      }
      
      .control-group {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      
      .control-group label {
        font-size: 12px;
        color: var(--color-text-secondary);
      }
      
      .control-group input, .control-group select, .control-group textarea {
        background: var(--color-bg-primary);
        border: 1px solid var(--color-border);
        border-radius: 4px;
        padding: 8px 12px;
        color: var(--color-text-primary);
        font-size: 14px;
        outline: none;
      }
      
      .control-group input:focus, .control-group select:focus, .control-group textarea:focus {
        border-color: var(--color-accent);
      }
      
      .comment-list-container {
        min-height: 100px;
        max-height: 200px;
        overflow-y: auto;
        background: var(--color-bg-primary);
        border: 1px solid var(--color-border);
        border-radius: 4px;
        padding: 8px;
        font-family: inherit;
        font-size: 14px;
        color: var(--color-text-primary);
        outline: none;
      }
      
      .comment-list-container:focus {
        border-color: var(--color-accent);
      }
      
      .comment-list-container .comment-line {
        display: block;
        line-height: 24px;
        height: 24px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        padding: 0 4px;
        border-bottom: 1px dashed var(--color-border);
      }
      
      .comment-list-container .comment-line:last-child {
        border-bottom: none;
      }
      
      .comment-list-container .comment-line:hover {
        background: rgba(254, 44, 85, 0.1);
      }
      
      .comment-list-container:empty:before {
        content: attr(placeholder);
        color: var(--color-text-muted);
        display: block;
        line-height: 24px;
        padding: 0 4px;
      }
      
      .range-inputs {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      
      .range-inputs input {
        width: 80px;
      }
      
      .control-actions {
        display: flex;
        gap: 8px;
      }
      
      .control-actions button {
        flex: 1;
        padding: 8px 12px;
        border: 1px solid var(--color-border);
        background: var(--color-bg-primary);
        color: var(--color-text-secondary);
        border-radius: 4px;
        font-size: 12px;
        cursor: pointer;
      }
      
      .status-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        background: var(--color-bg-primary);
        border-radius: 4px;
      }
      
      .status-indicator {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: var(--color-text-secondary);
      }
      
      .status-indicator::before {
        content: '';
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--color-text-muted);
      }
      
      .status-indicator.running::before {
        background: var(--color-success);
      }
      
      .count-badge {
        font-size: 12px;
        color: var(--color-accent);
        font-weight: 600;
      }
      
      .log-section {
        background: var(--color-bg-secondary);
        border-radius: 8px;
        border: 1px solid var(--color-border);
        flex: 1;
        min-height: 150px;
        display: flex;
        flex-direction: column;
      }
      
      .log-section .section-header {
        flex-shrink: 0;
      }
      
      .btn-clear-logs {
        padding: 4px 8px;
        border: 1px solid var(--color-border);
        background: transparent;
        color: var(--color-text-secondary);
        border-radius: 4px;
        font-size: 11px;
        cursor: pointer;
      }
      
      .log-container {
        flex: 1;
        overflow-y: auto;
        padding: 8px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      
      .log-item {
        display: flex;
        gap: 8px;
        padding: 6px 8px;
        border-radius: 4px;
        font-size: 11px;
      }
      
      .log-time {
        color: var(--color-text-muted);
        font-family: monospace;
        white-space: nowrap;
      }
      
      .log-item > span:first-of-type {
        width: 4px;
        border-radius: 2px;
        flex-shrink: 0;
      }
      
      .log-item.success > span:first-of-type { background: var(--color-success); }
      .log-item.warning > span:first-of-type { background: var(--color-warning); }
      .log-item.error > span:first-of-type { background: var(--color-error); }
      .log-item.info > span:first-of-type { background: var(--color-info); }
      
      .log-content {
        flex: 1;
        display: flex;
        flex-direction: column;
      }
      
      .log-message {
        color: var(--color-text-primary);
      }
      
      .log-data {
        color: var(--color-text-muted);
        font-size: 10px;
      }
      
      .log-source {
        font-size: 9px;
        padding: 1px 4px;
        border-radius: 2px;
        background: var(--color-bg-primary);
        color: var(--color-text-muted);
        text-transform: uppercase;
      }
      
      .log-empty {
        text-align: center;
        color: var(--color-text-muted);
        padding: 20px;
        font-size: 12px;
      }
      
      .btn-save, .btn-reset {
        padding: 8px 16px;
        border: none;
        border-radius: 4px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
      }
      
      .btn-save {
        background: var(--color-accent);
        color: white;
      }
      
      .btn-reset {
        background: transparent;
        color: var(--color-text-secondary);
        border: 1px solid var(--color-border);
      }
      
      @keyframes fadeInLeft {
        from { opacity: 0; transform: translateX(-20px); }
        to { opacity: 1; transform: translateX(0); }
      }
      
      .animate-fadeInLeft {
        animation: fadeInLeft 0.3s ease;
      }
      
      .douyin-helper-sidebar.collapsed {
        width: 40px !important;
      }
      
      .douyin-helper-sidebar.collapsed .sidebar-content,
      .douyin-helper-sidebar.collapsed .sidebar-footer {
        display: none;
      }
      
      .douyin-helper-sidebar.collapsed .sidebar-header {
        padding: 0;
        justify-content: center;
      }
      
      .douyin-helper-sidebar.collapsed .sidebar-header .title,
      .douyin-helper-sidebar.collapsed .btn-close {
        display: none;
      }
      
      .douyin-helper-sidebar .btn-collapse {
        transition: transform 0.25s ease;
      }
      
      .douyin-helper-sidebar.collapsed .btn-collapse {
        transform: rotate(180deg);
      }
    `;
  }
  
  bindEvents() {
    const resizeHandle = this.element.querySelector('.resize-handle');
    resizeHandle.addEventListener('mousedown', this.onResizeStart.bind(this));
    
    const collapseBtn = this.element.querySelector('.btn-collapse');
    collapseBtn.addEventListener('click', this.toggleCollapse.bind(this));
    
    const closeBtn = this.element.querySelector('.btn-close');
    closeBtn.addEventListener('click', () => {
      this.stopMonitoring();
      this.hide();
    });
    
    const likeToggle = this.element.querySelector('#like-toggle');
    likeToggle.addEventListener('change', (e) => {
      if (this.onToggleLike) this.onToggleLike(e.target.checked);
    });
    
    const commentToggle = this.element.querySelector('#comment-toggle');
    commentToggle.addEventListener('change', (e) => {
      if (this.onToggleComment) this.onToggleComment(e.target.checked);
    });
    
    const saveBtn = this.element.querySelector('#btn-save');
    saveBtn.addEventListener('click', () => {
      if (this.onSave) this.onSave(this.getConfig());
    });
    
    const resetBtn = this.element.querySelector('#btn-reset');
    resetBtn.addEventListener('click', () => {
      if (this.onReset) this.onReset();
    });
    
    const importBtn = this.element.querySelector('#btn-import');
    const fileInput = this.element.querySelector('#file-import');
    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', this.handleFileImport.bind(this));
    
    const clearCommentsBtn = this.element.querySelector('#btn-clear-comments');
    clearCommentsBtn.addEventListener('click', () => {
      this.element.querySelector('#comment-list').innerHTML = '';
      this.updateCommentCount(0);
    });
    
    const clearLogsBtn = this.element.querySelector('#btn-clear-logs');
    clearLogsBtn.addEventListener('click', () => this.clearLogs());
    
    const commentList = this.element.querySelector('#comment-list');
    commentList.addEventListener('input', () => {
      const lines = this.getCommentLines();
      this.updateCommentCount(lines.length);
    });
  }
  
  onResizeStart(e) {
    this.isDragging = true;
    this.startX = e.clientX;
    this.startWidth = parseInt(this.element.style.width);
    this.element.classList.add('resizing');
    
    document.addEventListener('mousemove', this.onResizeMove.bind(this));
    document.addEventListener('mouseup', this.onResizeEnd.bind(this));
    e.preventDefault();
  }
  
  onResizeMove(e) {
    if (!this.isDragging) return;
    // 改为右侧调节：新的宽度 = 当前鼠标位置（因为左侧固定在0）
    let newWidth = e.clientX;
    newWidth = Math.max(320, Math.min(600, newWidth));
    this.element.style.width = `${newWidth}px`;
    this.config.width = newWidth;
  }
  
  onResizeEnd() {
    this.isDragging = false;
    this.element.classList.remove('resizing');
    document.removeEventListener('mousemove', this.onResizeMove.bind(this));
    document.removeEventListener('mouseup', this.onResizeEnd.bind(this));
  }
  
  toggleCollapse() {
    this.config.collapsed = !this.config.collapsed;
    this.element.classList.toggle('collapsed', this.config.collapsed);
  }
  
  hide() {
    this.container.style.display = 'none';
  }
  
  show() {
    this.container.style.display = 'block';
  }
  
  handleFileImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target.result;
      const container = this.element.querySelector('#comment-list');
      const existingComments = this.getCommentLines();
      const newComments = content.split('\n').map(line => line.trim()).filter(line => line);
      
      // 合并现有评论和新评论
      let allComments;
      if (existingComments.length > 0) {
        allComments = [...existingComments, ...newComments];
      } else {
        allComments = newComments;
      }
      
      // 限制最多50条
      if (allComments.length > 50) {
        allComments = allComments.slice(0, 50);
      }
      
      // 设置到容器
      this.setCommentLines(allComments);
      this.updateCommentCount(allComments.length);
    };
    
    reader.readAsText(file);
    e.target.value = '';
  }
  
  // 停止监测功能
  stopMonitoring() {
    if (this.monitorState.timeInterval) {
      clearInterval(this.monitorState.timeInterval);
      this.monitorState.timeInterval = null;
    }
    if (this.monitorState.statusInterval) {
      clearInterval(this.monitorState.statusInterval);
      this.monitorState.statusInterval = null;
    }
  }
  
  // 获取评论列表中的所有行
  getCommentLines() {
    const container = this.element.querySelector('#comment-list');
    if (!container) return [];
    
    // 获取所有评论行
    const lines = [];
    const commentDivs = container.querySelectorAll('.comment-line');
    
    commentDivs.forEach(div => {
      const text = div.textContent.trim();
      if (text) lines.push(text);
    });
    
    return lines;
  }
  
  // 设置评论列表内容
  setCommentLines(comments) {
    const container = this.element.querySelector('#comment-list');
    if (!container) return;
    
    if (!comments || comments.length === 0) {
      container.innerHTML = '';
      return;
    }
    
    // 创建结构化的评论行
    const html = comments.map(comment => 
      `<div class="comment-line">${this.escapeHtml(comment)}</div>`
    ).join('');
    
    container.innerHTML = html;
  }
  
  getConfig() {
    const likeMin = parseInt(this.element.querySelector('#like-min').value) || 10;
    const likeMax = parseInt(this.element.querySelector('#like-max').value) || 50;
    const commentInterval = parseInt(this.element.querySelector('#comment-interval').value) || 90;
    const commentMode = this.element.querySelector('#comment-mode').value;
    const comments = this.getCommentLines();
    
    return {
      likeEnabled: this.element.querySelector('#like-toggle').checked,
      likeMinPerMinute: Math.min(likeMin, likeMax),
      likeMaxPerMinute: Math.max(likeMin, likeMax),
      commentEnabled: this.element.querySelector('#comment-toggle').checked,
      commentInterval: commentInterval,
      commentMode: commentMode,
      comments: comments,
      sidebarWidth: this.config.width,
      sidebarCollapsed: this.config.collapsed
    };
  }
  
  setConfig(config) {
    if (config.likeMinPerMinute !== undefined) {
      // 如果旧配置小于20，使用新的默认值20
      let minValue = config.likeMinPerMinute;
      if (minValue < 20) minValue = 20;
      this.element.querySelector('#like-min').value = minValue;
    }
    if (config.likeMaxPerMinute !== undefined) {
      // 确保最大值不小于最小值
      let maxValue = config.likeMaxPerMinute;
      if (maxValue < 20) maxValue = 50;
      this.element.querySelector('#like-max').value = maxValue;
    }
    if (config.commentInterval !== undefined) {
      this.element.querySelector('#comment-interval').value = config.commentInterval;
    }
    if (config.commentMode !== undefined) {
      this.element.querySelector('#comment-mode').value = config.commentMode;
    }
    if (config.comments !== undefined) {
      this.setCommentLines(config.comments);
      this.updateCommentCount(config.comments.length);
    }
    if (config.likeEnabled !== undefined) {
      this.element.querySelector('#like-toggle').checked = config.likeEnabled;
    }
    if (config.commentEnabled !== undefined) {
      this.element.querySelector('#comment-toggle').checked = config.commentEnabled;
    }
  }
  
  updateLikeStatus(running, count) {
    const statusEl = this.element.querySelector('#like-status');
    const countEl = this.element.querySelector('#like-count');
    statusEl.textContent = running ? '运行中' : '已停止';
    statusEl.classList.toggle('running', running);
    countEl.textContent = `${count} 次`;
  }
  
  updateCommentStatus(running, count) {
    const statusEl = this.element.querySelector('#comment-status');
    const countEl = this.element.querySelector('#comment-count');
    statusEl.textContent = running ? '运行中' : '已停止';
    statusEl.classList.toggle('running', running);
    countEl.textContent = `${count} 条`;
  }
  
  updateCommentCount(count) {
    this.element.querySelector('#comment-count-display').textContent = count;
  }
  
  addLog(log) {
    const container = this.element.querySelector('#log-container');
    const emptyEl = container.querySelector('.log-empty');
    if (emptyEl) emptyEl.remove();
    
    const logItem = document.createElement('div');
    logItem.className = `log-item ${log.type}`;
    logItem.innerHTML = `
      <span class="log-time">${log.time}</span>
      <span></span>
      <div class="log-content">
        <span class="log-message">${this.escapeHtml(log.message)}</span>
        ${log.data ? `<span class="log-data">${JSON.stringify(log.data)}</span>` : ''}
      </div>
      <span class="log-source">${log.source}</span>
    `;
    
    container.insertBefore(logItem, container.firstChild);
    while (container.children.length > 100) {
      container.removeChild(container.lastChild);
    }
    container.scrollTop = 0;
  }
  
  clearLogs() {
    const container = this.element.querySelector('#log-container');
    container.innerHTML = '<div class="log-empty">暂无日志</div>';
  }
  
  showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    const colors = {
      success: '#00C853',
      warning: '#FFC107',
      error: '#FF1744',
      info: '#2196F3'
    };
    
    // 获取侧边栏元素以定位通知位置
    const sidebarElement = document.querySelector('#douyin-helper-sidebar');
    let positionStyles;
    
    if (sidebarElement) {
      // 如果有侧边栏，显示在侧边栏内保存配置按钮上方约10厘米(100px)处
      const sidebarRect = sidebarElement.getBoundingClientRect();
      const bottomOffset = 120; // 距离侧边栏底部120px（约10厘米）
      positionStyles = `
        position: fixed;
        bottom: ${bottomOffset}px;
        left: ${sidebarRect.left + sidebarRect.width / 2}px;
        transform: translateX(-50%);
      `;
    } else {
      // 默认位置：页面底部上方
      positionStyles = `
        position: fixed;
        bottom: 120px;
        left: 160px;
        transform: translateX(-50%);
      `;
    }
    
    notification.style.cssText = `
      ${positionStyles}
      background: ${colors[type] || colors.info};
      color: white;
      padding: 12px 24px;
      border-radius: 8px;
      z-index: 10000;
      animation: fadeInUp 0.3s ease;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      white-space: nowrap;
    `;
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
      notification.style.animation = 'fadeIn 0.3s ease reverse';
      setTimeout(() => notification.remove(), 300);
    }, 3000);
  }
  
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// ==================== 主程序入口 ====================

(function() {
  'use strict';
  
  console.log('[大宝抖音助手] ======================================');
  console.log('[大宝抖音助手] 内容脚本已加载');
  console.log('[大宝抖音助手] 当前页面:', window.location.href);
  console.log('[大宝抖音助手] ======================================');
  
  // 防止重复加载
  if (window.douyinHelperLoaded) {
    console.log('[大宝抖音助手] 已经加载，跳过');
    return;
  }
  window.douyinHelperLoaded = true;
  
  // 初始化反检测
  AntiDetection.init();
  
  // 全局状态
  const state = {
    sidebar: null,
    floatingBtn: null,
    autoLike: null,
    autoComment: null,
    config: null,
    stats: null,
    totalLikes: 0,
    totalComments: 0
  };
  
  // 初始化全局状态对象（用于统计）
  window.DouyinHelperState = {
    totalLikes: 0,
    totalComments: 0
  };
  
  // 初始化
  async function init() {
    console.log('[大宝抖音助手] 开始初始化...');
    
    try {
      // 加载配置
      await loadConfig();
      
      // 创建浮动按钮
      createFloatingButton();
      
      // 加载历史日志
      loadLogs();
      
      console.log('[大宝抖音助手] 初始化完成 ✓');
      console.log('[大宝抖音助手] 点击右下角"宝"字按钮打开侧边栏');
      
    } catch (error) {
      console.error('[大宝抖音助手] 初始化失败:', error);
    }
  }
  
  // 加载配置
  async function loadConfig() {
    try {
      state.config = await Storage.getConfig();
      state.stats = await Storage.getStats();
      console.log('[大宝抖音助手] 配置加载完成:', state.config);
    } catch (error) {
      console.error('[大宝抖音助手] 加载配置失败:', error);
      state.config = Storage.getDefaultConfig();
      state.stats = Storage.getDefaultStats();
    }
  }
  
  // 加载历史日志
  async function loadLogs() {
    try {
      const logs = await Storage.getLogs();
      console.log(`[大宝抖音助手] 加载 ${logs.length} 条历史日志`);
    } catch (error) {
      console.error('[大宝抖音助手] 加载日志失败:', error);
    }
  }
  
  // 创建浮动按钮
  function createFloatingButton() {
    console.log('[大宝抖音助手] 创建浮动按钮...');
    
    state.floatingBtn = new FloatingButton({
      visible: true,
      running: false,
      onClick: () => {
        console.log('[大宝抖音助手] 浮动按钮被点击');
        toggleSidebar();
      }
    });
    
    state.floatingBtn.create();
    console.log('[大宝抖音助手] 浮动按钮创建完成 ✓');
  }
  
  // 创建侧边栏
  function createSidebar() {
    console.log('[大宝抖音助手] 创建侧边栏...');
    
    // 重置本次中控统计
    state.totalLikes = 0;
    state.totalComments = 0;
    window.DouyinHelperState.totalLikes = 0;
    window.DouyinHelperState.totalComments = 0;
    
    // 检查是否已存在
    const existing = document.getElementById('douyin-helper-sidebar-host');
    if (existing) {
      console.log('[大宝抖音助手] 侧边栏已存在，显示它');
      existing.style.display = 'block';
      if (state.floatingBtn) state.floatingBtn.hide();
      // 重置统计（重新打开侧边栏视为新的中控会话）
      state.totalLikes = 0;
      state.totalComments = 0;
      window.DouyinHelperState.totalLikes = 0;
      window.DouyinHelperState.totalComments = 0;
      return;
    }
    
    state.sidebar = new Sidebar({
      width: state.config.sidebarWidth || 400,
      collapsed: state.config.sidebarCollapsed || false
    });
    
    // 绑定回调
    state.sidebar.onToggleLike = (enabled) => {
      console.log('[大宝抖音助手] 点赞开关:', enabled);
      handleLikeToggle(enabled);
    };
    
    state.sidebar.onToggleComment = (enabled) => {
      console.log('[大宝抖音助手] 评论开关:', enabled);
      handleCommentToggle(enabled);
    };
    
    state.sidebar.onSave = async (config) => {
      console.log('[大宝抖音助手] 保存配置:', config);
      await saveConfig(config);
      // 将保存成功的提示添加到操作日志
      Logger.add({ type: 'success', source: 'system', message: '配置已保存' });
    };
    
    state.sidebar.onReset = async () => {
      console.log('[大宝抖音助手] 重置配置');
      const defaultConfig = Storage.getDefaultConfig();
      state.sidebar.setConfig(defaultConfig);
      // 将重置成功的提示添加到操作日志
      Logger.add({ type: 'info', source: 'system', message: '已重置为默认配置' });
    };
    
    state.sidebar.create();
    state.sidebar.setConfig(state.config);
    
    // 强制关闭自动点赞和评论开关（默认关闭）
    const likeToggle = state.sidebar.element.querySelector('#like-toggle');
    const commentToggle = state.sidebar.element.querySelector('#comment-toggle');
    if (likeToggle) likeToggle.checked = false;
    if (commentToggle) commentToggle.checked = false;
    
    // 隐藏浮动按钮
    if (state.floatingBtn) {
      state.floatingBtn.hide();
    }
    
    // 绑定日志事件
    window.addEventListener('douyin-helper:log:added', (e) => {
      if (state.sidebar) {
        state.sidebar.addLog(e.detail);
      }
    });
    
    console.log('[大宝抖音助手] 侧边栏创建完成 ✓');
  }
  
  // 切换侧边栏
  function toggleSidebar() {
    console.log('[大宝抖音助手] 切换侧边栏显示');
    
    if (state.sidebar) {
      const isVisible = state.sidebar.container.style.display !== 'none';
      if (isVisible) {
        state.sidebar.hide();
        state.floatingBtn.show();
      } else {
        state.sidebar.show();
        state.floatingBtn.hide();
      }
    } else {
      createSidebar();
    }
  }
  
  // 处理点赞开关
  function handleLikeToggle(enabled) {
    state.config.likeEnabled = enabled;
    
    if (enabled) {
      if (!state.autoLike) {
        state.autoLike = new AutoLike({
          enabled: true,
          minPerMinute: state.config.likeMinPerMinute,
          maxPerMinute: state.config.likeMaxPerMinute
        });
        state.autoLike.start();
      } else {
        state.autoLike.updateConfig({
          enabled: true,
          minPerMinute: state.config.likeMinPerMinute,
          maxPerMinute: state.config.likeMaxPerMinute
        });
        // updateConfig 已自动调用 start，无需手动调用
      }
      
      window.addEventListener('douyin-helper:like:success', handleLikeSuccess);
    } else {
      if (state.autoLike) {
        state.autoLike.stop();
        window.removeEventListener('douyin-helper:like:success', handleLikeSuccess);
      }
    }
    
    updateFloatingBtnStatus();
  }
  
  // 处理评论开关
  function handleCommentToggle(enabled) {
    state.config.commentEnabled = enabled;
    
    if (enabled) {
      // 从UI获取最新的评论列表
      let currentComments = state.config.comments;
      if (state.sidebar) {
        const commentsFromUI = state.sidebar.getConfig().comments;
        if (commentsFromUI && commentsFromUI.length > 0) {
          currentComments = commentsFromUI;
          // 更新state.config中的评论列表
          state.config.comments = currentComments;
        }
      }
      
      if (currentComments.length === 0) {
        Logger.add({ 
          type: 'warning', 
          source: 'comment', 
          message: '评论列表为空，请先输入评论内容' 
        });
        // 自动关闭开关
        state.config.commentEnabled = false;
        if (state.sidebar) {
          state.sidebar.element.querySelector('#comment-toggle').checked = false;
        }
        return;
      }
      
      if (!state.autoComment) {
        state.autoComment = new AutoComment({
          enabled: true,
          interval: state.config.commentInterval,
          mode: state.config.commentMode,
          comments: currentComments,
          smartHistorySize: 10
        });
        state.autoComment.start();
      } else {
        state.autoComment.updateConfig({
          enabled: true,
          interval: state.config.commentInterval,
          mode: state.config.commentMode,
          comments: currentComments
        });
        // updateConfig 已自动调用 start，无需手动调用
      }
      
      window.addEventListener('douyin-helper:comment:success', handleCommentSuccess);
    } else {
      if (state.autoComment) {
        state.autoComment.stop();
        window.removeEventListener('douyin-helper:comment:success', handleCommentSuccess);
      }
    }
    
    updateFloatingBtnStatus();
  }
  
  // 点赞成功处理
  function handleLikeSuccess(e) {
    const { count, today } = e.detail;
    state.stats.totalLikes = count;
    state.stats.todayLikes = today || state.stats.todayLikes + 1;
    
    // 更新本次中控统计
    state.totalLikes++;
    window.DouyinHelperState.totalLikes = state.totalLikes;
    
    if (state.sidebar) {
      state.sidebar.updateLikeStatus(true, count);
    }
    
    saveStats();
  }
  
  // 评论成功处理
  function handleCommentSuccess(e) {
    const { text, total, today } = e.detail;
    state.stats.totalComments = total;
    state.stats.todayComments = today || state.stats.todayComments + 1;
    
    // 更新本次中控统计
    state.totalComments++;
    window.DouyinHelperState.totalComments = state.totalComments;
    
    if (state.sidebar) {
      state.sidebar.updateCommentStatus(true, total);
    }
    
    saveStats();
  }
  
  // 更新浮动按钮状态
  function updateFloatingBtnStatus() {
    if (!state.floatingBtn) return;
    const isRunning = state.config.likeEnabled || state.config.commentEnabled;
    state.floatingBtn.setRunning(isRunning);
  }
  
  // 保存配置
  async function saveConfig(config) {
    state.config = { ...state.config, ...config };
    try {
      await Storage.setConfig(state.config);
    } catch (error) {
      console.error('[大宝抖音助手] 保存配置失败:', error);
    }
  }
  
  // 保存统计
  async function saveStats() {
    try {
      await Storage.setStats(state.stats);
    } catch (error) {
      console.error('[大宝抖音助手] 保存统计失败:', error);
    }
  }
  
  // 页面加载完成后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  
  // 暴露全局调试接口
  window.DouyinHelper = {
    toggle: () => {
      console.log('[大宝抖音助手] 手动触发 toggleSidebar');
      toggleSidebar();
    },
    getState: () => state,
    showBtn: () => state.floatingBtn && state.floatingBtn.show(),
    hideBtn: () => state.floatingBtn && state.floatingBtn.hide(),
    showSidebar: () => state.sidebar && state.sidebar.show(),
    hideSidebar: () => state.sidebar && state.sidebar.hide(),
    reload: () => {
      console.log('[大宝抖音助手] 手动重新加载...');
      if (state.floatingBtn) {
        state.floatingBtn.container.remove();
      }
      if (state.sidebar) {
        state.sidebar.container.remove();
      }
      window.douyinHelperLoaded = false;
      location.reload();
    }
  };
  
  console.log('[大宝抖音助手] 调试接口已暴露，在控制台输入 DouyinHelper.toggle() 可以手动打开侧边栏');
  
})();
