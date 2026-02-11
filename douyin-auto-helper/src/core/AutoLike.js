/**
 * AutoLike - 自动点赞核心模块
 * 模拟人类双击行为，随机时间间隔
 */

class AutoLike {
  constructor(config = {}) {
    this.config = {
      enabled: config.enabled || false,
      minPerMinute: config.minPerMinute || 10,
      maxPerMinute: config.maxPerMinute || 50,
      ...config
    };
    
    this.state = {
      isRunning: false,
      totalLikes: 0,
      todayLikes: 0,
      lastMinuteLikes: 0,
      currentSchedule: [],
      timerId: null
    };
    
    this.timers = [];
  }
  
  /**
   * 启动自动点赞
   */
  start() {
    if (this.state.isRunning) {
      console.log('[AutoLike] 已经是运行状态');
      return;
    }
    
    if (!this.config.enabled) {
      console.log('[AutoLike] 未启用，无法启动');
      return;
    }
    
    this.state.isRunning = true;
    this.log('info', '自动点赞已启动', {
      min: this.config.minPerMinute,
      max: this.config.maxPerMinute
    });
    
    // 开始调度
    this.scheduleNextMinute();
    
    // 触发启动事件
    this.emit('like:started');
  }
  
  /**
   * 停止自动点赞
   */
  stop() {
    if (!this.state.isRunning) {
      return;
    }
    
    this.state.isRunning = false;
    
    // 清除所有定时器
    this.timers.forEach(timer => clearTimeout(timer));
    this.timers = [];
    
    if (this.state.timerId) {
      clearTimeout(this.state.timerId);
      this.state.timerId = null;
    }
    
    this.log('info', '自动点赞已停止', {
      total: this.state.totalLikes,
      today: this.state.todayLikes
    });
    
    this.emit('like:stopped');
  }
  
  /**
   * 调度下一分钟的点赞计划
   */
  scheduleNextMinute() {
    if (!this.state.isRunning) return;
    
    const clickCount = this.generateClickCount();
    const intervals = this.generateIntervals(clickCount);
    
    this.log('info', `本分钟计划点赞 ${clickCount} 次，间隔: ${Math.round(intervals[0]/1000)}s - ${Math.round(intervals[intervals.length-1]/1000)}s`);
    
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
  
  /**
   * 生成本分钟的点击次数
   */
  generateClickCount() {
    const { minPerMinute, maxPerMinute } = this.config;
    // 使用正态分布，更自然
    return this.normalDistribution(minPerMinute, maxPerMinute);
  }
  
  /**
   * 生成随机时间间隔
   */
  generateIntervals(count) {
    const intervals = [];
    const minuteMs = 60000;
    
    // 生成 count 个随机时间点
    for (let i = 0; i < count; i++) {
      intervals.push(Math.random() * minuteMs);
    }
    
    // 排序
    intervals.sort((a, b) => a - b);
    
    // 确保最小间隔 500ms
    const minGap = 500;
    for (let i = 1; i < intervals.length; i++) {
      if (intervals[i] - intervals[i - 1] < minGap) {
        intervals[i] = intervals[i - 1] + minGap;
      }
    }
    
    // 确保不超过60秒
    for (let i = 0; i < intervals.length; i++) {
      if (intervals[i] > minuteMs - 1000) {
        intervals[i] = minuteMs - 1000;
      }
    }
    
    return intervals;
  }
  
  /**
   * 执行单次点赞
   */
  async performLike() {
    try {
      // 查找直播间红心按钮元素
      const heartBtn = this.findHeartButton();
      const container = this.findLiveContainer();
      const video = this.findVideoElement();
      
      if (!container || !video) {
        this.log('warning', '未找到直播容器，跳过本次点赞');
        return;
      }
      
      const rect = container.getBoundingClientRect();
      
      // 计算点击位置
      let clickX, clickY;
      
      if (heartBtn) {
        // 如果找到红心按钮，点击红心位置
        const heartRect = heartBtn.getBoundingClientRect();
        clickX = heartRect.left + heartRect.width / 2;
        clickY = heartRect.top + heartRect.height / 2;
        this.log('info', `找到红心按钮，点击红心位置`);
      } else {
        // 没有找到红心，点击视频中央偏下位置
        // 随机偏移范围 40-80px，模拟真人操作
        const offsetX = 40 + Math.random() * 40;
        const offsetY = 40 + Math.random() * 40;
        
        const dirX = Math.random() > 0.5 ? 1 : -1;
        const dirY = Math.random() > 0.5 ? 1 : -1;
        
        clickX = rect.left + rect.width / 2 + offsetX * dirX;
        clickY = rect.top + rect.height * 0.65 + offsetY * dirY;
        
        clickX = Math.max(rect.left + 20, Math.min(rect.right - 20, clickX));
        clickY = Math.max(rect.top + 20, Math.min(rect.bottom - 20, clickY));
      }
      
      this.log('info', `双击位置: X=${Math.round(clickX)}, Y=${Math.round(clickY)}`);
      
      // 优先点击红心按钮
      let success = false;
      if (heartBtn) {
        success = await this.simulateDoubleClick(heartBtn, clickX, clickY);
      }
      
      if (!success) {
        success = await this.simulateDoubleClick(container, clickX, clickY);
      }
      
      if (!success) {
        success = await this.simulateDoubleClick(video, clickX, clickY);
      }
      
      if (success) {
        this.state.totalLikes++;
        this.state.todayLikes++;
        this.state.lastMinuteLikes++;
        
        this.log('success', '点赞成功', {
          total: this.state.totalLikes,
          today: this.state.todayLikes
        });
        
        this.emit('like:success', {
          count: this.state.totalLikes,
          today: this.state.todayLikes
        });
      } else {
        this.log('warning', '点赞事件未触发');
      }
      
    } catch (error) {
      this.log('error', '点赞失败', { error: error.message });
      this.emit('like:error', { error: error.message });
    }
  }
  
  /**
   * 查找直播容器元素（点击目标）
   */
  findLiveContainer() {
    const selectors = [
      '.xgplayer-container',
      '[data-e2e="live-player"]',
      '.live-player-video',
      '.room-player',
      '.player-container',
      '.room-container',
      '[class*="live-player"]',
      '[class*="video-container"]'
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
  
  /**
   * 查找视频元素
   */
  findVideoElement() {
    if (typeof ElementFinder !== 'undefined') {
      return ElementFinder.findLiveVideo();
    }
    
    const selectors = [
      '.xgplayer-container video',
      '[data-e2e="live-player"] video',
      'video'
    ];
    
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 300 && rect.height > 200) {
          return el;
        }
      }
    }
    
    return null;
  }
  
  /**
   * 检查元素是否可见
   */
  isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && 
           style.display !== 'none' && 
           style.visibility !== 'hidden' &&
           style.opacity !== '0';
  }
  
  /**
   * 查找红心点赞按钮
   */
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
  
  /**
   * 模拟双击事件
   * @returns {boolean} 是否成功触发点击
   */
  async simulateDoubleClick(element, x, y) {
    try {
      // 第一下点击
      await this.dispatchMouseEvent(element, 'mousedown', x, y, 1);
      await this.delay(30 + Math.random() * 40);
      await this.dispatchMouseEvent(element, 'mouseup', x, y, 1);
      await this.delay(10 + Math.random() * 20);
      await this.dispatchMouseEvent(element, 'click', x, y, 1);
      
      // 第二下点击（模拟真人双击间隔 80-150ms）
      await this.delay(80 + Math.random() * 70);
      await this.dispatchMouseEvent(element, 'mousedown', x, y, 2);
      await this.delay(30 + Math.random() * 40);
      await this.dispatchMouseEvent(element, 'mouseup', x, y, 2);
      await this.delay(10 + Math.random() * 20);
      await this.dispatchMouseEvent(element, 'click', x, y, 2);
      await this.dispatchMouseEvent(element, 'dblclick', x, y, 2);
      
      return true;
    } catch (error) {
      this.log('error', '模拟点击失败', { error: error.message });
      return false;
    }
  }
  
  /**
   * 派发鼠标事件
   */
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
  
  /**
   * 正态分布随机数
   */
  normalDistribution(min, max) {
    // Box-Muller 变换
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    
    const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    const mean = (min + max) / 2;
    const stdDev = (max - min) / 4;
    
    let result = Math.round(mean + z * stdDev);
    return Math.max(min, Math.min(max, result));
  }
  
  /**
   * 更新配置
   */
  updateConfig(config) {
    this.config = { ...this.config, ...config };
    
    // 如果正在运行且配置改变，可能需要重启
    if (this.state.isRunning && !this.config.enabled) {
      this.stop();
    } else if (!this.state.isRunning && this.config.enabled) {
      this.start();
    }
  }
  
  /**
   * 获取统计
   */
  getStats() {
    return {
      total: this.state.totalLikes,
      today: this.state.todayLikes,
      lastMinute: this.state.lastMinuteLikes
    };
  }
  
  /**
   * 延迟函数
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * 记录日志
   */
  log(type, message, data = {}) {
    if (typeof Logger !== 'undefined') {
      Logger.add({
        type,
        source: 'like',
        message,
        data
      });
    } else {
      console.log(`[AutoLike][${type}] ${message}`, data);
    }
  }
  
  /**
   * 触发事件
   */
  emit(event, data) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(`douyin-helper:${event}`, { detail: data }));
    }
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AutoLike;
}
