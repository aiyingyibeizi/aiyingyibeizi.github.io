(function () {
  'use strict';

  // =========================================
  // APEXON Music Player
  // 使用 Jamendo API（需要 client_id）+ 内置演示曲库兜底
  // 去 https://developer.jamendo.com 注册应用获取 client_id
  // =========================================

  const JAMENDO_CLIENT_ID = '1ff4ae9b';

  // 演示曲库：使用 SoundHelix 提供的 16 首示例曲目（稳定可播放）
  // 如需接入数万首全网曲库，请在 JAMENDO_CLIENT_ID 填入 Jamendo 开发者 client_id
  const DEMO_TRACKS = [
    { id: 'demo-1', name: 'Neon Horizon', artist_name: 'SoundHelix', album_name: 'Electronic Dreams', duration: 186, audio: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3', image: 'https://picsum.photos/seed/neonhorizon/400/400', tags: ['electronic', 'pop'], url: 'https://www.soundhelix.com/' },
    { id: 'demo-2', name: 'Midnight Drive', artist_name: 'SoundHelix', album_name: 'Night Sessions', duration: 205, audio: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3', image: 'https://picsum.photos/seed/midnightdrive/400/400', tags: ['electronic', 'rock'], url: 'https://www.soundhelix.com/' },
    { id: 'demo-3', name: 'Solar Flare', artist_name: 'SoundHelix', album_name: 'Cosmic Beats', duration: 192, audio: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3', image: 'https://picsum.photos/seed/solarflare/400/400', tags: ['rock', 'electronic'], url: 'https://www.soundhelix.com/' },
    { id: 'demo-4', name: 'Deep Ocean', artist_name: 'SoundHelix', album_name: 'Ambient Works', duration: 218, audio: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3', image: 'https://picsum.photos/seed/deepocean/400/400', tags: ['ambient', 'electronic'], url: 'https://www.soundhelix.com/' },
    { id: 'demo-5', name: 'Urban Pulse', artist_name: 'SoundHelix', album_name: 'City Lights', duration: 176, audio: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3', image: 'https://picsum.photos/seed/urbanpulse/400/400', tags: ['pop', 'electronic'], url: 'https://www.soundhelix.com/' },
    { id: 'demo-6', name: 'Golden Hour', artist_name: 'SoundHelix', album_name: 'Acoustic Moods', duration: 201, audio: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3', image: 'https://picsum.photos/seed/goldenhour/400/400', tags: ['pop', 'classical'], url: 'https://www.soundhelix.com/' },
    { id: 'demo-7', name: 'Cyber Funk', artist_name: 'SoundHelix', album_name: 'Retro Future', duration: 184, audio: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-7.mp3', image: 'https://picsum.photos/seed/cyberfunk/400/400', tags: ['funk', 'electronic'], url: 'https://www.soundhelix.com/' },
    { id: 'demo-8', name: 'Silent Rain', artist_name: 'SoundHelix', album_name: 'Soft Piano', duration: 223, audio: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3', image: 'https://picsum.photos/seed/silentrain/400/400', tags: ['classical', 'ambient'], url: 'https://www.soundhelix.com/' },
    { id: 'demo-9', name: 'Velocity', artist_name: 'SoundHelix', album_name: 'Sports Energy', duration: 167, audio: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-9.mp3', image: 'https://picsum.photos/seed/velocity/400/400', tags: ['rock', 'electronic'], url: 'https://www.soundhelix.com/' },
    { id: 'demo-10', name: 'Lunar Lounge', artist_name: 'SoundHelix', album_name: 'Chill Out', duration: 209, audio: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-10.mp3', image: 'https://picsum.photos/seed/lunarlounge/400/400', tags: ['jazz', 'ambient'], url: 'https://www.soundhelix.com/' },
    { id: 'demo-11', name: 'Electric Heart', artist_name: 'SoundHelix', album_name: 'Dance Floor', duration: 195, audio: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-11.mp3', image: 'https://picsum.photos/seed/electricheart/400/400', tags: ['electronic', 'pop'], url: 'https://www.soundhelix.com/' },
    { id: 'demo-12', name: 'Mountain Echo', artist_name: 'SoundHelix', album_name: 'Nature Sounds', duration: 232, audio: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-12.mp3', image: 'https://picsum.photos/seed/mountainecho/400/400', tags: ['classical', 'ambient'], url: 'https://www.soundhelix.com/' },
    { id: 'demo-13', name: 'Street Beat', artist_name: 'SoundHelix', album_name: 'Hip Hop Instrumentals', duration: 188, audio: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-13.mp3', image: 'https://picsum.photos/seed/streetbeat/400/400', tags: ['hiphop', 'electronic'], url: 'https://www.soundhelix.com/' },
    { id: 'demo-14', name: 'Starlight Waltz', artist_name: 'SoundHelix', album_name: 'Orchestral', duration: 216, audio: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-14.mp3', image: 'https://picsum.photos/seed/starlightwaltz/400/400', tags: ['classical', 'ambient'], url: 'https://www.soundhelix.com/' },
    { id: 'demo-15', name: 'Digital Dawn', artist_name: 'SoundHelix', album_name: 'Morning Motivation', duration: 179, audio: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-15.mp3', image: 'https://picsum.photos/seed/digitaldawn/400/400', tags: ['electronic', 'pop'], url: 'https://www.soundhelix.com/' },
    { id: 'demo-16', name: 'Echoes of Time', artist_name: 'SoundHelix', album_name: 'Cinematic', duration: 243, audio: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-16.mp3', image: 'https://picsum.photos/seed/echoesoftime/400/400', tags: ['classical', 'electronic'], url: 'https://www.soundhelix.com/' }
  ];

  const LS_KEYS = {
    liked: 'apex_music_liked',
    history: 'apex_music_history',
    volume: 'apex_music_volume'
  };

  const MODES = ['loop', 'single', 'random'];
  const MODE_ICONS = { loop: '🔁', single: '🔂', random: '🔀' };

  function $(id) { return document.getElementById(id); }
  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return m + ':' + s;
  }

  const MusicPlayer = {
    audio: null,
    currentTrack: null,
    currentPlaylist: [],
    currentIndex: 0,
    playMode: 'loop',
    isDraggingProgress: false,
    isDraggingVolume: false,
    liked: new Set(),
    history: [],
    hotTracks: [],
    activeChip: 'all',

    init() {
      this.loadStorage();
      this.cacheDOM();
      this.bindEvents();
      this.initAudio();
      this.switchView('home');
      this.loadHotTracks();
      this.renderHistoryPreview();
      this.renderLiked();
      this.hideNoticeIfConfigured();
    },

    hideNoticeIfConfigured() {
      const notice = $('musicNotice');
      if (!notice) return;
      if (JAMENDO_CLIENT_ID && JAMENDO_CLIENT_ID !== 'YOUR_CLIENT_ID_HERE') {
        notice.style.display = 'none';
      }
    },

    loadStorage() {
      try {
        const likedRaw = JSON.parse(localStorage.getItem(LS_KEYS.liked) || '[]');
        this.liked = Array.isArray(likedRaw) ? new Set(likedRaw.filter(id => typeof id === 'string' || typeof id === 'number')) : new Set();
      } catch (e) { this.liked = new Set(); }
      try {
        const historyRaw = JSON.parse(localStorage.getItem(LS_KEYS.history) || '[]');
        this.history = Array.isArray(historyRaw) ? historyRaw.filter(t => t && typeof t === 'object' && t.id) : [];
      } catch (e) { this.history = []; }
    },

    saveStorage() {
      localStorage.setItem(LS_KEYS.liked, JSON.stringify(Array.from(this.liked)));
      localStorage.setItem(LS_KEYS.history, JSON.stringify(this.history.slice(0, 200)));
    },

    cacheDOM() {
      this.dom = {
        audio: $('musicAudio'),
        searchInput: $('musicSearchInput'),
        searchClear: $('musicSearchClear'),
        hotSkeleton: $('hotSkeleton'),
        hotCards: $('hotCards'),
        hotGrid: $('hotGrid'),
        recentList: $('recentList'),
        historyList: $('historyList'),
        likedList: $('likedList'),
        searchContent: $('searchContent'),
        searchTitle: $('searchTitle'),
        heroCover: $('heroCover'),
        heroTitle: $('heroTitle'),
        heroPlayBtn: $('heroPlayBtn'),
        heroLikeBtn: $('heroLikeBtn'),
        playerCover: $('playerCover'),
        playerTitle: $('playerTitle'),
        playerArtist: $('playerArtist'),
        playerLike: $('playerLike'),
        playPauseBtn: $('playPauseBtn'),
        prevBtn: $('prevBtn'),
        nextBtn: $('nextBtn'),
        modeBtn: $('modeBtn'),
        progressBar: $('progressBar'),
        progressFill: $('progressFill'),
        progressHandle: $('progressHandle'),
        currentTime: $('currentTime'),
        totalTime: $('totalTime'),
        volumeBar: $('volumeBar'),
        volumeFill: $('volumeFill'),
        volumeIcon: $('volumeIcon'),
        lyricsBtn: $('lyricsBtn'),
        lyricsPanel: $('lyricsPanel'),
        lyricsClose: $('lyricsClose'),
        lyricsBody: $('lyricsBody'),
        toast: $('musicToast'),
        chips: document.querySelectorAll('.music-chip'),
        views: {
          home: $('musicViewHome'),
          hot: $('musicViewHot'),
          search: $('musicViewSearch'),
          liked: $('musicViewLiked'),
          history: $('musicViewHistory')
        },
        sidebarLinks: document.querySelectorAll('.music-sidebar__link'),
        sidebar: $('musicSidebar')
      };
      this.audio = this.dom.audio;
    },

    bindEvents() {
      const d = this.dom;

      d.searchInput.addEventListener('input', () => {
        const val = d.searchInput.value.trim();
        d.searchClear.classList.toggle('visible', val.length > 0);
      });

      d.searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.handleSearch();
      });

      d.searchClear.addEventListener('click', () => {
        d.searchInput.value = '';
        d.searchClear.classList.remove('visible');
        this.switchView('home');
      });

      d.heroPlayBtn.addEventListener('click', () => {
        const tracks = this.getFilteredHotTracks().length ? this.getFilteredHotTracks() : (this.hotTracks.length ? this.hotTracks : DEMO_TRACKS);
        if (tracks.length) this.playTrack(tracks[0], tracks, 0);
      });

      d.heroLikeBtn.addEventListener('click', () => {
        if (this.currentTrack) this.toggleLike(this.currentTrack.id);
        else this.showToast('请先播放一首歌曲');
      });

      d.playPauseBtn.addEventListener('click', () => this.togglePlay());
      d.prevBtn.addEventListener('click', () => this.playPrev());
      d.nextBtn.addEventListener('click', () => this.playNext());
      d.modeBtn.addEventListener('click', () => this.switchMode());
      d.playerLike.addEventListener('click', () => {
        if (this.currentTrack) this.toggleLike(this.currentTrack.id);
      });

      if (d.lyricsBtn) d.lyricsBtn.addEventListener('click', () => this.toggleLyricsPanel());
      if (d.lyricsClose) d.lyricsClose.addEventListener('click', () => this.toggleLyricsPanel(false));
      document.addEventListener('click', (e) => {
        if (d.lyricsPanel && d.lyricsPanel.classList.contains('open') &&
            !e.target.closest('.music-lyrics-panel') && !e.target.closest('.music-lyrics-toggle')) {
          this.toggleLyricsPanel(false);
        }
      });

      this.bindProgressEvents();
      this.bindVolumeEvents();

      document.querySelectorAll('.music-sidebar__link, .music-section__more').forEach(el => {
        el.addEventListener('click', (e) => {
          const view = e.currentTarget.dataset.view;
          if (view) {
            this.switchView(view);
            if (view === 'search' && d.searchInput.value.trim()) {
              this.handleSearch();
            }
          }
        });
      });

      d.chips.forEach(chip => {
        chip.addEventListener('click', () => {
          this.activeChip = chip.dataset.chip || 'all';
          d.chips.forEach(c => c.classList.toggle('active', c === chip));
          this.renderHotCards();
        });
      });

      document.addEventListener('click', (e) => {
        if (!e.target.closest('.music-sidebar') && !e.target.closest('.apexon-menu-btn')) {
          d.sidebar.classList.remove('open');
        }
      });
    },

    bindProgressEvents() {
      const bar = this.dom.progressBar;
      const update = (e) => {
        const rect = bar.getBoundingClientRect();
        const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
        const ratio = Math.max(0, Math.min(1, x / rect.width));
        return ratio;
      };
      const seek = (ratio) => {
        if (this.audio && this.audio.duration) {
          this.audio.currentTime = ratio * this.audio.duration;
        }
      };

      bar.addEventListener('mousedown', (e) => {
        this.isDraggingProgress = true;
        seek(update(e));
      });
      bar.addEventListener('touchstart', (e) => {
        this.isDraggingProgress = true;
        seek(update(e));
      }, { passive: true });

      const move = (e) => {
        if (!this.isDraggingProgress) return;
        e.preventDefault();
        const ratio = update(e);
        this.updateProgressUI(ratio * (this.audio.duration || 0), this.audio.duration || 0);
      };
      const up = (e) => {
        if (!this.isDraggingProgress) return;
        this.isDraggingProgress = false;
        const ratio = update(e.changedTouches ? e.changedTouches[0] : e);
        seek(ratio);
      };

      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      window.addEventListener('touchmove', move, { passive: false });
      window.addEventListener('touchend', up);
    },

    bindVolumeEvents() {
      const bar = this.dom.volumeBar;
      const update = (e) => {
        const rect = bar.getBoundingClientRect();
        const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
        return Math.max(0, Math.min(1, x / rect.width));
      };
      const setVol = (ratio) => {
        this.audio.volume = ratio;
        this.dom.volumeFill.style.width = (ratio * 100) + '%';
        this.updateVolumeIcon(ratio);
        localStorage.setItem(LS_KEYS.volume, String(ratio));
      };

      bar.addEventListener('mousedown', (e) => {
        this.isDraggingVolume = true;
        setVol(update(e));
      });
      bar.addEventListener('touchstart', (e) => {
        this.isDraggingVolume = true;
        setVol(update(e));
      }, { passive: true });

      const move = (e) => {
        if (!this.isDraggingVolume) return;
        e.preventDefault();
        setVol(update(e));
      };
      const up = (e) => {
        if (!this.isDraggingVolume) return;
        this.isDraggingVolume = false;
        setVol(update(e.changedTouches ? e.changedTouches[0] : e));
      };

      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      window.addEventListener('touchmove', move, { passive: false });
      window.addEventListener('touchend', up);
    },

    initAudio() {
      const savedVol = parseFloat(localStorage.getItem(LS_KEYS.volume) || '0.8');
      this.audio.volume = isNaN(savedVol) ? 0.8 : savedVol;
      this.dom.volumeFill.style.width = (this.audio.volume * 100) + '%';
      this.updateVolumeIcon(this.audio.volume);

      this.audio.addEventListener('timeupdate', () => {
        if (!this.isDraggingProgress) {
          this.updateProgressUI(this.audio.currentTime, this.audio.duration || 0);
        }
        this.syncLyrics(this.audio.currentTime);
      });

      this.audio.addEventListener('loadedmetadata', () => {
        this.dom.totalTime.textContent = formatTime(this.audio.duration);
      });

      this.audio.addEventListener('ended', () => {
        if (this.playMode === 'single') {
          this.audio.currentTime = 0;
          this.audio.play();
        } else {
          this.playNext();
        }
      });

      this.audio.addEventListener('play', () => {
        this.dom.playPauseBtn.textContent = '⏸';
        this.dom.playPauseBtn.classList.add('playing');
        this.highlightPlaying();
      });

      this.audio.addEventListener('pause', () => {
        this.dom.playPauseBtn.textContent = '▶';
        this.dom.playPauseBtn.classList.remove('playing');
        this.highlightPlaying();
      });

      this.audio.addEventListener('error', () => {
        this.showToast('音频加载失败，请检查网络或稍后重试');
      });
    },

    updateProgressUI(current, total) {
      this.dom.currentTime.textContent = formatTime(current);
      this.dom.totalTime.textContent = formatTime(total);
      const ratio = total > 0 ? current / total : 0;
      this.dom.progressFill.style.width = (ratio * 100) + '%';
      this.dom.progressHandle.style.left = (ratio * 100) + '%';
    },

    updateVolumeIcon(vol) {
      if (vol === 0 || this.audio.muted) this.dom.volumeIcon.textContent = '🔇';
      else if (vol < 0.4) this.dom.volumeIcon.textContent = '🔈';
      else if (vol < 0.7) this.dom.volumeIcon.textContent = '🔉';
      else this.dom.volumeIcon.textContent = '🔊';
    },

    switchMode() {
      const idx = (MODES.indexOf(this.playMode) + 1) % MODES.length;
      this.playMode = MODES[idx];
      this.dom.modeBtn.textContent = MODE_ICONS[this.playMode];
      const labels = { loop: '列表循环', single: '单曲循环', random: '随机播放' };
      this.showToast('播放模式：' + labels[this.playMode]);
    },

    togglePlay() {
      if (!this.currentTrack) {
        const tracks = this.getFilteredHotTracks().length ? this.getFilteredHotTracks() : (this.hotTracks.length ? this.hotTracks : DEMO_TRACKS);
        if (tracks.length) this.playTrack(tracks[0], tracks, 0);
        return;
      }
      if (this.audio.paused) this.audio.play();
      else this.audio.pause();
    },

    playTrack(track, playlist, index) {
      this.currentTrack = track;
      this.currentPlaylist = playlist || [track];
      this.currentIndex = index || 0;

      this.audio.src = track.audio;
      this.audio.play().catch(() => {
        this.showToast('播放失败，可能是网络或音频链接失效');
      });

      this.updatePlayerUI();
      this.updateHeroUI();
      this.addToHistory(track);
      this.highlightPlaying();
      this.applyGlow(track.image);
      this.currentLyrics = null;
      if (this.dom.lyricsPanel && this.dom.lyricsPanel.classList.contains('open')) {
        this.loadLyrics(track);
      }
    },

    updatePlayerUI() {
      const t = this.currentTrack;
      if (!t) return;
      this.dom.playerTitle.textContent = t.name;
      this.dom.playerArtist.textContent = t.artist_name;
      this.dom.playerCover.src = t.image || 'assets/favicon.png';
      this.dom.playerLike.textContent = this.liked.has(String(t.id)) ? '♥' : '♡';
      this.dom.playerLike.classList.toggle('liked', this.liked.has(String(t.id)));
      this.dom.playPauseBtn.textContent = '⏸';
    },

    updateHeroUI() {
      const t = this.currentTrack;
      if (!t || !this.dom.heroTitle) return;
      this.dom.heroTitle.textContent = t.name;
      this.dom.heroCover.src = t.image || 'assets/favicon.png';
      if (this.dom.heroLikeBtn) {
        this.dom.heroLikeBtn.textContent = this.liked.has(String(t.id)) ? '♥' : '♡';
        this.dom.heroLikeBtn.style.color = this.liked.has(String(t.id)) ? '#ff4757' : '#fff';
      }
    },

    applyGlow(imageUrl) {
      if (!imageUrl) {
        document.body.classList.remove('music-glow');
        return;
      }
      document.body.classList.add('music-glow');
    },

    playPrev() {
      if (!this.currentPlaylist.length) return;
      let idx = this.currentIndex - 1;
      if (idx < 0) idx = this.currentPlaylist.length - 1;
      this.playTrack(this.currentPlaylist[idx], this.currentPlaylist, idx);
    },

    playNext() {
      if (!this.currentPlaylist.length) return;
      let idx;
      if (this.playMode === 'random') {
        idx = Math.floor(Math.random() * this.currentPlaylist.length);
      } else {
        idx = this.currentIndex + 1;
        if (idx >= this.currentPlaylist.length) idx = 0;
      }
      this.playTrack(this.currentPlaylist[idx], this.currentPlaylist, idx);
    },

    addToHistory(track) {
      const id = String(track.id);
      this.history = this.history.filter(h => String(h.id) !== id);
      this.history.unshift({
        id: track.id,
        name: track.name,
        artist_name: track.artist_name,
        album_name: track.album_name,
        duration: track.duration,
        audio: track.audio,
        image: track.image,
        playedAt: Date.now()
      });
      this.history = this.history.slice(0, 200);
      this.saveStorage();
      this.renderHistoryPreview();
      if (this.currentView === 'history') this.renderHistory();
    },

    toggleLike(id) {
      id = String(id);
      if (this.liked.has(id)) {
        this.liked.delete(id);
        this.showToast('已取消喜欢');
      } else {
        this.liked.add(id);
        this.showToast('已添加到"我喜欢"');
      }
      this.saveStorage();
      this.updatePlayerUI();
      this.updateHeroUI();
      this.highlightPlaying();
      this.renderLiked();
      if (this.currentView === 'liked') this.renderLiked();
    },

    isLiked(id) {
      return this.liked.has(String(id));
    },

    toggleLyricsPanel(force) {
      const panel = this.dom.lyricsPanel;
      if (!panel) return;
      const open = typeof force === 'boolean' ? force : !panel.classList.contains('open');
      panel.classList.toggle('open', open);
      if (open && this.currentTrack && !this.currentLyrics) {
        this.loadLyrics(this.currentTrack);
      }
    },

    async loadLyrics(track) {
      if (!track) return;
      const body = this.dom.lyricsBody;
      if (!body) return;
      this.currentLyrics = null;
      body.innerHTML = '<div class="music-lyrics-panel__empty">正在搜索歌词...</div>';
      try {
        // 1. 优先尝试 LRCLIB（支持同步歌词）
        const q = encodeURIComponent(track.name + ' ' + track.artist_name);
        const res = await fetch('https://lrclib.net/api/search?q=' + q);
        if (res.ok) {
          const data = await res.json();
          const item = (data && Array.isArray(data) && data.length) ? data[0] : null;
          if (item && (item.plainLyrics || item.syncedLyrics)) {
            this.currentLyrics = this.parseLyrics(item.syncedLyrics || item.plainLyrics);
            this.renderLyrics();
            return;
          }
        }
      } catch (e) {
        // 静默继续尝试下一个源
      }

      try {
        // 2. 回退到 Lyrics.ovh（纯文本歌词）
        const artist = encodeURIComponent(track.artist_name || 'Unknown');
        const title = encodeURIComponent(track.name);
        const res = await fetch('https://api.lyrics.ovh/v1/' + artist + '/' + title);
        if (res.ok) {
          const data = await res.json();
          if (data && data.lyrics) {
            this.currentLyrics = this.parseLyrics(data.lyrics);
            this.renderLyrics();
            return;
          }
        }
      } catch (e) {
        // 静默失败
      }

      body.innerHTML = '<div class="music-lyrics-panel__empty">未找到该歌曲的歌词</div>';
    },

    parseLyrics(text) {
      if (!text) return [];
      const lines = text.trim().split(/\r?\n/);
      const result = [];
      const timeRe = /^\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\](.*)$/;
      lines.forEach(line => {
        const m = line.match(timeRe);
        if (m) {
          const min = parseInt(m[1], 10);
          const sec = parseInt(m[2], 10);
          const ms = parseInt((m[3] || '0').padEnd(3, '0').slice(0, 3), 10);
          const time = min * 60 + sec + ms / 1000;
          result.push({ time, text: m[4].trim() });
        } else if (line.trim()) {
          result.push({ time: -1, text: line.trim() });
        }
      });
      return result.sort((a, b) => a.time - b.time);
    },

    renderLyrics() {
      const body = this.dom.lyricsBody;
      if (!body || !this.currentLyrics) return;
      if (!this.currentLyrics.length) {
        body.innerHTML = '<div class="music-lyrics-panel__empty">暂无歌词</div>';
        return;
      }
      body.innerHTML = this.currentLyrics.map((line, i) =>
        '<div class="music-lyrics-panel__line" data-index="' + i + '" data-time="' + line.time + '">' +
        this.escapeHtml(line.text || '♪') + '</div>'
      ).join('');
    },

    syncLyrics(currentTime) {
      if (!this.currentLyrics || !this.currentLyrics.length) return;
      const lines = this.dom.lyricsBody.querySelectorAll('.music-lyrics-panel__line');
      let activeIndex = -1;
      for (let i = 0; i < this.currentLyrics.length; i++) {
        if (this.currentLyrics[i].time >= 0 && this.currentLyrics[i].time <= currentTime) {
          activeIndex = i;
        }
      }
      lines.forEach((line, i) => {
        line.classList.toggle('active', i === activeIndex);
      });
      if (activeIndex >= 0 && lines[activeIndex]) {
        lines[activeIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    },

    escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = String(str);
      return div.innerHTML;
    },

    switchView(view) {
      this.currentView = view;
      Object.values(this.dom.views).forEach(el => el.style.display = 'none');
      if (this.dom.views[view]) this.dom.views[view].style.display = 'block';

      this.dom.sidebarLinks.forEach(link => {
        link.classList.toggle('active', link.dataset.view === view);
      });

      if (view === 'liked') this.renderLiked();
      if (view === 'history') this.renderHistory();
      if (view === 'hot') this.renderHotGrid();

      window.scrollTo({ top: 0, behavior: 'smooth' });
    },

    async handleSearch() {
      let q = this.dom.searchInput.value.trim();
      if (!q) {
        this.switchView('home');
        return;
      }
      if (q.length > 100) q = q.slice(0, 100);
      this.switchView('search');
      this.dom.searchTitle.textContent = '搜索：' + q;
      this.dom.searchContent.innerHTML = '<div class="music-loading"><div class="music-loading__spinner"></div><div>正在搜索...</div></div>';

      const tracks = await this.searchTracks(q);
      this.renderSearchResults(tracks, q);
    },

    async loadHotTracks() {
      const tracks = await this.fetchJamendo('/tracks', {
        orderby: 'popularity_total',
        limit: 24,
        audioformat: 'mp31'
      });
      this.hotTracks = tracks.length ? tracks : DEMO_TRACKS;
      if (this.dom.hotSkeleton) this.dom.hotSkeleton.style.display = 'none';
      if (this.dom.hotCards) this.dom.hotCards.style.display = 'grid';
      this.renderHotCards();
      if (this.currentView === 'hot') this.renderHotGrid();
    },

    getFilteredHotTracks() {
      if (this.activeChip === 'all') return this.hotTracks;
      return this.hotTracks.filter(t => {
        const tags = (t.tags || []);
        const allText = (t.name + ' ' + t.artist_name + ' ' + t.album_name + ' ' + tags.join(' ')).toLowerCase();
        return allText.includes(this.activeChip.toLowerCase());
      });
    },

    async searchTracks(q) {
      return await this.fetchJamendo('/tracks', {
        search: q,
        limit: 30,
        audioformat: 'mp31'
      });
    },

    async fetchJamendo(endpoint, params) {
      if (!JAMENDO_CLIENT_ID || JAMENDO_CLIENT_ID === 'YOUR_CLIENT_ID_HERE') {
        return this.fallbackSearch(params);
      }
      try {
        const qs = new URLSearchParams({ client_id: JAMENDO_CLIENT_ID, format: 'json', ...params });
        const url = 'https://api.jamendo.com/v3.0' + endpoint + '?' + qs.toString();
        const res = await fetch(url);
        const data = await res.json();
        if (!data || !data.results) return this.fallbackSearch(params);
        return data.results.map(normalizeTrack);
      } catch (e) {
        return this.fallbackSearch(params);
      }
    },

    fallbackSearch(params) {
      let list = DEMO_TRACKS.slice();
      if (params.search) {
        const q = params.search.toLowerCase();
        list = list.filter(t =>
          t.name.toLowerCase().includes(q) ||
          t.artist_name.toLowerCase().includes(q) ||
          (t.album_name && t.album_name.toLowerCase().includes(q)) ||
          (t.tags && t.tags.some(tag => tag.toLowerCase().includes(q)))
        );
      }
      if (params.orderby === 'popularity_total') {
        list = list.slice(0, Math.min(list.length, params.limit || 24));
      }
      return list;
    },

    renderHotCards() {
      const tracks = this.getFilteredHotTracks().slice(0, 8);
      this.dom.hotCards.innerHTML = tracks.map((t, i) => this.trackCardHTML(t, i)).join('');
      this.bindCardClicks(this.dom.hotCards, tracks);
      this.highlightPlaying();
    },

    renderHotGrid() {
      const tracks = this.getFilteredHotTracks();
      this.dom.hotGrid.innerHTML = tracks.map((t, i) => this.trackCardHTML(t, i)).join('');
      this.bindCardClicks(this.dom.hotGrid, tracks);
      this.highlightPlaying();
    },

    renderSearchResults(tracks, q) {
      if (!tracks.length) {
        this.dom.searchContent.innerHTML = this.emptyHTML('没有找到相关歌曲', '换个关键词试试，或者检查一下 Jamendo client_id 是否已配置。');
        return;
      }
      this.dom.searchContent.innerHTML = this.trackListHTML(tracks, true);
      this.bindListClicks(this.dom.searchContent, tracks);
      this.highlightPlaying();
    },

    renderHistoryPreview() {
      const tracks = this.history.slice(0, 5);
      if (!tracks.length) {
        this.dom.recentList.innerHTML = this.emptyHTML('暂无最近播放', '点击任意歌曲开始收听');
        return;
      }
      this.dom.recentList.innerHTML = this.trackListHTML(tracks, false);
      this.bindListClicks(this.dom.recentList, tracks);
      this.highlightPlaying();
    },

    renderHistory() {
      if (!this.history.length) {
        this.dom.historyList.innerHTML = this.emptyHTML('暂无最近播放', '点击任意歌曲开始收听');
        return;
      }
      this.dom.historyList.innerHTML = this.trackListHTML(this.history, false);
      this.bindListClicks(this.dom.historyList, this.history);
      this.highlightPlaying();
    },

    renderLiked() {
      const likedTracks = this.history.filter(t => this.isLiked(t.id));
      if (!likedTracks.length) {
        this.dom.likedList.innerHTML = this.emptyHTML('暂无喜欢的歌曲', '点击 ♡ 收藏喜欢的音乐');
        return;
      }
      this.dom.likedList.innerHTML = this.trackListHTML(likedTracks, false);
      this.bindListClicks(this.dom.likedList, likedTracks);
      this.highlightPlaying();
    },

    trackCardHTML(t, i) {
      const title = escapeHtml(t.name);
      const artist = escapeHtml(t.artist_name);
      const img = escapeAttr(t.image || 'assets/favicon.png');
      const isPlaying = this.currentTrack && String(this.currentTrack.id) === String(t.id) && !this.audio.paused;
      return '<div class="music-card" data-track-id="' + String(t.id) + '">' +
        '<div class="music-card__cover"><img src="' + img + '" alt="' + title + '" loading="lazy">' +
        '<div class="music-card__equalizer"><span></span><span></span><span></span><span></span></div>' +
        '<div class="music-card__play">' + (isPlaying ? '⏸' : '▶') + '</div></div>' +
        '<div class="music-card__title" title="' + title + '">' + title + '</div>' +
        '<div class="music-card__artist" title="' + artist + '">' + artist + '</div>' +
      '</div>';
    },

    trackListHTML(tracks, showIndex) {
      let html = '<div class="music-list__row music-list__row--header">' +
        '<div>' + (showIndex ? '#' : '') + '</div>' +
        '<div>歌曲</div>' +
        '<div class="music-list__artist-name">艺人</div>' +
        '<div class="music-list__duration">时长</div>' +
        '<div>操作</div>' +
      '</div>';
      html += tracks.map((t, i) => {
        const title = escapeHtml(t.name);
        const artist = escapeHtml(t.artist_name);
        const img = escapeAttr(t.image || 'assets/favicon.png');
        const liked = this.isLiked(t.id);
        return '<div class="music-list__row" data-track-id="' + String(t.id) + '">' +
          '<div class="music-list__index">' + (showIndex ? (i + 1) : '🎵') + '</div>' +
          '<div class="music-list__song">' +
            '<div class="music-list__thumb"><img src="' + img + '" alt="' + title + '" loading="lazy"></div>' +
            '<div class="music-list__name" title="' + title + '">' + title + '</div>' +
          '</div>' +
          '<div class="music-list__artist" title="' + artist + '">' + artist + '</div>' +
          '<div class="music-list__duration">' + formatTime(t.duration) + '</div>' +
          '<div class="music-list__actions">' +
            '<span class="music-list__action ' + (liked ? 'liked' : '') + '" data-action="like" title="喜欢">' + (liked ? '♥' : '♡') + '</span>' +
            '<span class="music-list__action disabled" data-action="download" title="暂不提供下载">⬇</span>' +
          '</div>' +
        '</div>';
      }).join('');
      return '<div class="music-list">' + html + '</div>';
    },

    bindCardClicks(container, playlist) {
      container.querySelectorAll('.music-card').forEach((card, i) => {
        card.addEventListener('click', () => {
          this.playTrack(playlist[i], playlist, i);
        });
      });
    },

    bindListClicks(container, playlist) {
      container.querySelectorAll('.music-list__row').forEach(row => {
        if (row.classList.contains('music-list__row--header')) return;
        const id = String(row.dataset.trackId);
        const track = playlist.find(t => String(t.id) === id);
        const index = playlist.findIndex(t => String(t.id) === id);

        row.addEventListener('click', (e) => {
          if (e.target.closest('.music-list__action')) return;
          if (track) this.playTrack(track, playlist, index);
        });

        const likeBtn = row.querySelector('[data-action="like"]');
        const dlBtn = row.querySelector('[data-action="download"]');

        if (likeBtn) {
          likeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleLike(id);
          });
        }
        if (dlBtn) {
          dlBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showToast('暂不提供下载功能');
          });
        }
      });
    },

    highlightPlaying() {
      const isPlaying = this.currentTrack && !this.audio.paused;
      document.querySelectorAll('.music-list__row').forEach(row => {
        const playing = this.currentTrack && String(row.dataset.trackId) === String(this.currentTrack.id);
        row.classList.toggle('playing', !!playing);
      });
      document.querySelectorAll('.music-card').forEach(card => {
        const playing = this.currentTrack && String(card.dataset.trackId) === String(this.currentTrack.id);
        card.classList.toggle('playing', !!playing);
        const playBtn = card.querySelector('.music-card__play');
        if (playBtn) playBtn.textContent = playing && isPlaying ? '⏸' : '▶';
      });
    },

    emptyHTML(title, desc) {
      return '<div class="music-empty">' +
        '<div class="music-empty__icon">🎧</div>' +
        '<div class="music-empty__title">' + title + '</div>' +
        '<div class="music-empty__desc">' + desc + '</div>' +
      '</div>';
    },

    showToast(msg) {
      const t = this.dom.toast;
      t.textContent = msg;
      t.classList.add('show');
      if (this._toastTimer) clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
    }
  };

  function normalizeTrack(item) {
    return {
      id: item.id,
      name: item.name || 'Unknown Track',
      artist_name: item.artist_name || 'Unknown Artist',
      album_name: item.album_name || '',
      duration: item.duration || 0,
      audio: item.audio || '',
      image: item.image || item.album_image || '',
      tags: Array.isArray(item.tags) ? item.tags : (item.tags ? String(item.tags).split(',').map(s => s.trim()) : []),
      url: item.shareurl || item.shorturl || ''
    };
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function escapeAttr(str) {
    if (str == null) return '';
    const url = String(str).trim();
    if (/^(javascript|data|vbscript|file|about|blob):/i.test(url)) return '';
    return url.replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  window.APEXON = window.APEXON || {};
  window.APEXON.MusicPlayer = MusicPlayer;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => MusicPlayer.init());
  } else {
    MusicPlayer.init();
  }
})();
