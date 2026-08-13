/**
 * APEXON.Share v1.0
 * 职责：用 Canvas 绘制成绩分享卡片，弹出模态框供下载 / 复制
 */
(function (global) {
  'use strict';

  const Share = {
    // 生成成绩卡片并展示在模态框
    // data: { testType, testTitle, score, scoreUnit, grade, gradeColor, username, date }
    showCard(data) {
      data = data || {};
      const themeColor = this._getThemeColor();

      // 1. 创建/复用模态框 DOM
      let modal = document.getElementById('apexShareModal');
      if (modal) modal.remove();

      modal = document.createElement('div');
      modal.className = 'apex-share-modal';
      modal.id = 'apexShareModal';

      const box = document.createElement('div');
      box.className = 'apex-share-modal__box';
      box.style.position = 'relative';

      // 关闭按钮
      const closeBtn = document.createElement('button');
      closeBtn.className = 'apex-share-modal__close';
      closeBtn.setAttribute('aria-label', '关闭');
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', () => modal.remove());

      // 标题
      const title = document.createElement('h3');
      title.className = 'apex-share-modal__title';
      title.textContent = '分享我的成绩';

      // 预览图
      const preview = document.createElement('img');
      preview.className = 'apex-share-modal__preview';
      preview.alt = '成绩卡片';

      // 操作按钮区
      const actions = document.createElement('div');
      actions.className = 'apex-share-modal__actions';

      const downloadBtn = document.createElement('button');
      downloadBtn.className = 'btn';
      downloadBtn.textContent = '下载图片';

      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn';
      copyBtn.textContent = '复制图片';

      actions.appendChild(downloadBtn);
      actions.appendChild(copyBtn);

      box.appendChild(closeBtn);
      box.appendChild(title);
      box.appendChild(preview);
      box.appendChild(actions);
      modal.appendChild(box);
      document.body.appendChild(modal);

      // 点击遮罩关闭
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
      });
      // Esc 关闭
      const onKey = (e) => {
        if (e.key === 'Escape') {
          modal.remove();
          document.removeEventListener('keydown', onKey);
        }
      };
      document.addEventListener('keydown', onKey);

      // 2. 用 Canvas 绘制卡片（800x420）
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 420;
      drawCard(canvas, data, themeColor);

      // 3. 把 canvas 转 dataURL 显示在 <img>
      const dataUrl = canvas.toDataURL('image/png');
      preview.src = dataUrl;

      // 4. 下载 / 复制 按钮
      const filename = 'apexon-' + (data.testType || 'score') + '-' + Date.now() + '.png';
      downloadBtn.addEventListener('click', () => this.download(dataUrl, filename));
      copyBtn.addEventListener('click', async () => {
        const ok = await this.copyImage(dataUrl);
        if (ok) {
          copyBtn.textContent = '已复制 ✓';
          setTimeout(() => { copyBtn.textContent = '复制图片'; }, 1800);
        } else {
          // 不支持 ClipboardItem / 写入失败：降级提示用户手动截图
          copyBtn.textContent = '不支持，请截图';
          setTimeout(() => { copyBtn.textContent = '复制图片'; }, 2400);
        }
      });
    },

    // 获取当前主题色
    _getThemeColor() {
      const accent = document.documentElement.getAttribute('data-accent') || 'cyan';
      const map = {
        cyan: '#8b7efc', emerald: '#34d399', amber: '#fbbf24',
        rose: '#f472b6', indigo: '#818cf8', coral: '#fb923c',
        sunset: '#f97316', mint: '#2dd4bf', crimson: '#f43f5e'
      };
      return map[accent] || map.cyan;
    },

    // 下载图片
    download(dataUrl, filename) {
      const a = document.createElement('a');
      a.href = dataUrl; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
    },

    // 复制图片到剪贴板
    async copyImage(dataUrl) {
      try {
        // 兼容性：无 ClipboardItem API 时直接返回 false，由调用方降级提示
        if (typeof ClipboardItem === 'undefined' || !navigator.clipboard || !navigator.clipboard.write) {
          return false;
        }
        const blob = await (await fetch(dataUrl)).blob();
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        return true;
      } catch (e) {
        return false;
      }
    }
  };

  // 绘制 Canvas 卡片的核心函数
  function drawCard(canvas, data, themeColor) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;

    // 背景渐变
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#0a0e1a');
    bg.addColorStop(1, '#15192b');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // 主题色光晕（右上角）
    const glow = ctx.createRadialGradient(W - 80, 80, 0, W - 80, 80, 240);
    glow.addColorStop(0, themeColor + '40');
    glow.addColorStop(1, 'transparent');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    // 装饰粒子点阵（右上角）
    ctx.fillStyle = themeColor + '30';
    for (let x = W - 180; x < W - 40; x += 16) {
      for (let y = 40; y < 160; y += 16) {
        ctx.beginPath();
        ctx.arc(x, y, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 左下角对角斜线装饰
    ctx.strokeStyle = themeColor + '20';
    ctx.lineWidth = 1;
    for (let i = -100; i < 200; i += 14) {
      ctx.beginPath();
      ctx.moveTo(0, H - i);
      ctx.lineTo(i + 100, H);
      ctx.stroke();
    }

    // 顶部：APEXON 标识
    ctx.fillStyle = themeColor;
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('APEXON', 40, 50);

    ctx.fillStyle = '#9fb0c7';
    ctx.font = '13px sans-serif';
    ctx.fillText(data.testTitle || '测试成绩', 40, 74);

    // 中间：成绩大数字
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 72px sans-serif';
    ctx.textAlign = 'center';
    const scoreText = String(data.score);
    ctx.fillText(scoreText, W / 2, H / 2 + 10);

    // 单位
    if (data.scoreUnit) {
      ctx.fillStyle = '#9fb0c7';
      ctx.font = '20px sans-serif';
      ctx.fillText(data.scoreUnit, W / 2 + ctx.measureText(scoreText).width / 2 + 28, H / 2 + 4);
    }

    // 等级徽章（右上区域）
    if (data.grade) {
      const badgeX = W - 100, badgeY = 100, badgeR = 36;
      ctx.beginPath();
      ctx.arc(badgeX, badgeY, badgeR, 0, Math.PI * 2);
      ctx.fillStyle = '#1a1f33';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = data.gradeColor || themeColor;
      ctx.stroke();
      ctx.fillStyle = data.gradeColor || themeColor;
      ctx.font = 'bold 28px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(data.grade, badgeX, badgeY + 2);
      ctx.textBaseline = 'alphabetic';
    }

    // 底部：用户名 + 日期
    ctx.fillStyle = '#5e6e85';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'left';
    const dateStr = data.date || new Date().toLocaleDateString('zh-CN');
    const userStr = data.username ? '@' + data.username : '@Guest';
    ctx.fillText(userStr + '  ·  ' + dateStr, 40, H - 40);

    // 底部右侧：网站
    ctx.fillStyle = themeColor;
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('apexon.qzz.io', W - 40, H - 40);
  }

  global.APEXON = global.APEXON || {};
  global.APEXON.Share = Share;
})(window);
