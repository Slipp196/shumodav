(() => {
  const socket = io();

  /* ---------- i18n ---------- */
  const I18N = {
    ru: {
      appTitle: 'Шумодав',
      appSub: 'Голосовая связь для своих',
      nickPh: 'Твой ник',
      roomPh: 'Комната',
      avatar: 'Аватарка (необязательно)',
      join: 'Войти',
      micOn: 'Микрофон включён',
      micOff: 'Микрофон выключен',
      deafOn: 'Звук включён',
      deafOff: 'Звук выключен',
      leave: 'Выйти',
      participants: 'Участники',
      you: 'ты',
      errNick: 'Введи ник',
      errRoom: 'Введи название комнаты',
      errMic: 'Нет доступа к микрофону. Разреши доступ в браузере.',
      errHttps: 'Для работы нужен HTTPS (или localhost).',
    },
    uk: {
      appTitle: 'Шумодав',
      appSub: 'Голосовий зв\u2019язок для своїх',
      nickPh: 'Твій нік',
      roomPh: 'Кімната',
      avatar: 'Аватарка (необов\u2019язково)',
      join: 'Увійти',
      micOn: 'Мікрофон увімкнено',
      micOff: 'Мікрофон вимкнено',
      deafOn: 'Звук увімкнено',
      deafOff: 'Звук вимкнено',
      leave: 'Вийти',
      participants: 'Учасники',
      you: 'ти',
      errNick: 'Введи нік',
      errRoom: 'Введи назву кімнати',
      errMic: 'Немає доступу до мікрофона. Дозволь доступ у браузері.',
      errHttps: 'Для роботи потрібен HTTPS (або localhost).',
    }
  };

  let lang = localStorage.getItem('lang')
    || (((navigator.language || '').toLowerCase().startsWith('uk')) ? 'uk' : 'ru');

  const t = (k) => (I18N[lang] && I18N[lang][k]) || k;
  const $ = (id) => document.getElementById(id);

  /* ---------- state ---------- */
  let myId = null;
  let myNick = localStorage.getItem('nick') || '';
  let myRoom = localStorage.getItem('room') || 'general';
  let myAvatar = localStorage.getItem('avatar') || null;
  let localStream = null;
  let pendingJoin = null;
  let muted = false;
  let deafened = false;

  const users = new Map();     // id -> {nick, avatar, muted, deafened}
  const peers = new Map();     // id -> {pc, audio, analyser}
  const userEls = new Map();   // id -> <li>
  const remoteAnalysers = new Map();
  const speakingNow = new Set();
  let localAnalyser = null;
  let audioCtx = null;

  /* ---------- helpers ---------- */
  function colorFrom(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return `hsl(${h}, 55%, 45%)`;
  }

  function makeAvatar(user, big) {
    const el = document.createElement('div');
    el.className = 'avatar' + (big ? ' big' : '');
    if (user.avatar) {
      el.style.backgroundImage = `url(${user.avatar})`;
    } else {
      el.textContent = (user.nick || '?').trim().charAt(0).toUpperCase();
      el.style.background = colorFrom(user.nick || '?');
    }
    return el;
  }

  function resizeImage(file, size = 128) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = size;
          const ctx = canvas.getContext('2d');
          const scale = Math.max(size / img.width, size / img.height);
          const w = img.width * scale, h = img.height * scale;
          ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.8));
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /* ---------- UI: язык ---------- */
  function applyLang() {
    document.documentElement.lang = lang;
    document.title = t('appTitle');
    $('appTitle').textContent = t('appTitle');
    $('appSub').textContent = t('appSub');
    $('nickInput').placeholder = t('nickPh');
    $('roomInput').placeholder = t('roomPh');
    $('avatarLabel').textContent = t('avatar');
    $('joinBtn').textContent = t('join');
    $('participantsLabel').textContent = t('participants');
    $('leaveBtn').textContent = '⏻';
    $('leaveBtn').title = t('leave');
    document.querySelectorAll('.lang').forEach(b =>
      b.classList.toggle('active', b.dataset.lang === lang));
    updateButtons();
    renderUsers();
  }

  document.querySelectorAll('.lang').forEach(btn => {
    btn.addEventListener('click', () => {
      lang = btn.dataset.lang;
      localStorage.setItem('lang', lang);
      applyLang();
    });
  });

  /* ---------- UI: аватар в логине ---------- */
  function refreshAvatarPreview() {
    const box = $('avatarPreview');
    box.innerHTML = '';
    box.style.backgroundImage = '';
    if (myAvatar) {
      box.style.backgroundImage = `url(${myAvatar})`;
    } else {
      box.textContent = (myNick || '?').trim().charAt(0).toUpperCase();
      box.style.background = colorFrom(myNick || '?');
    }
  }

  $('avatarInput').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      myAvatar = await resizeImage(file, 128);
      localStorage.setItem('avatar', myAvatar);
      refreshAvatarPreview();
    } catch (err) {
      console.error(err);
    }
  });

  $('nickInput').addEventListener('input', (e) => {
    myNick = e.target.value;
    refreshAvatarPreview();
  });

  /* ---------- кнопки микро/дефа ---------- */
  function updateButtons() {
    const micBtn = $('micBtn');
    const deafBtn = $('deafBtn');
    micBtn.textContent = muted ? '🔇' : '🎤';
    micBtn.title = muted ? t('micOff') : t('micOn');
    micBtn.classList.toggle('off', muted);

    deafBtn.textContent = deafened ? '🔕' : '🎧';
    deafBtn.title = deafened ? t('deafOff') : t('deafOn');
    deafBtn.classList.toggle('off', deafened);
  }

  function setMuted(v) {
    muted = v;
    if (localStream) localStream.getAudioTracks().forEach(tr => tr.enabled = !v);
    if (myId && users.has(myId)) users.get(myId).muted = v;
    socket.emit('update-state', { muted: v });
    updateButtons();
    renderUsers();
  }

  function setDeafened(v) {
    deafened = v;
    peers.forEach(p => { if (p.audio) p.audio.muted = v; });
    if (myId && users.has(myId)) users.get(myId).deafened = v;
    socket.emit('update-state', { deafened: v });
    updateButtons();
    renderUsers();
  }

  $('micBtn').addEventListener('click', () => setMuted(!muted));
  $('deafBtn').addEventListener('click', () => setDeafened(!deafened));
  $('leaveBtn').addEventListener('click', () => location.reload());

  /* ---------- список участников ---------- */
  function renderUsers() {
    const ul = $('users');
    ul.innerHTML = '';
    userEls.clear();

    const list = [...users.entries()].sort((a, b) => {
      if (a[0] === myId) return -1;
      if (b[0] === myId) return 1;
      return (a[1].nick || '').localeCompare(b[1].nick || '');
    });

    for (const [id, u] of list) {
      const li = document.createElement('li');
      li.appendChild(makeAvatar(u, false));

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = u.nick;
      li.appendChild(name);

      if (id === myId) {
        const me = document.createElement('span');
        me.className = 'me';
        me.textContent = '(' + t('you') + ')';
        li.appendChild(me);
      }

      const icons = document.createElement('span');
      icons.className = 'icons';
      if (u.muted) icons.textContent += '🔇';
      if (u.deafened) icons.textContent += '🔕';
      li.appendChild(icons);

      if (speakingNow.has(id)) li.classList.add('speaking');
      ul.appendChild(li);
      userEls.set(id, li);
    }
  }

  /* ---------- WebRTC ---------- */
  const RTC_CONFIG = {
    iceServers: [
      {
        urls: 'stun:stun.relay.metered.ca:80'
      },
      {
        urls: 'turn:global.relay.metered.ca:80',
        username: 'ab1131c51e273b586f61112f',
        credential: 'uxY8WP4xW3GrRro'
      },
      {
        urls: 'turn:global.relay.metered.ca:80?transport=tcp',
        username: 'ab1131c51e273b586f61112f',
        credential: 'uxY8WP4xW3GrRro'
      },
      {
        urls: 'turn:global.relay.metered.ca:443',
        username: 'ab1131c51e273b586f61112f',
        credential: 'uxY8WP4xW3GrRro'
      },
      {
        urls: 'turns:global.relay.metered.ca:443?transport=tcp',
        username: 'ab1131c51e273b586f61112f',
        credential: 'uxY8WP4xW3GrRro'
      }
    ],
    iceCandidatePoolSize: 10
  };

  function createPeer(id, initiator) {
    if (peers.has(id)) return peers.get(id);

    const pc = new RTCPeerConnection(RTC_CONFIG);

    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.muted = deafened;
    audio.style.display = 'none';
    document.body.appendChild(audio);

    const peer = { pc, audio, analyser: null };
    peers.set(id, peer);

    if (localStream) {
      localStream.getTracks().forEach(tr => pc.addTrack(tr, localStream));
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('signal', { to: id, data: { type: 'ice', candidate: e.candidate } });
      }
    };

    pc.ontrack = (e) => {
      const stream = e.streams[0];
      audio.srcObject = stream;
      audio.play().catch(() => {});
      try {
        if (audioCtx && stream) {
          const src = audioCtx.createMediaStreamSource(stream);
          const an = audioCtx.createAnalyser();
          an.fftSize = 512;
          src.connect(an);
          peer.analyser = an;
          remoteAnalysers.set(id, an);
        }
      } catch (err) { /* ignore */ }
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        if (pc.connectionState !== 'disconnected') removePeer(id);
      }
    };

    if (initiator) {
      (async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('signal', { to: id, data: { type: 'offer', sdp: pc.localDescription } });
        } catch (err) { console.error(err); }
      })();
    }

    return peer;
  }

  function removePeer(id) {
    const p = peers.get(id);
    if (!p) return;
    try { p.pc.close(); } catch (e) {}
    if (p.audio) p.audio.remove();
    peers.delete(id);
    remoteAnalysers.delete(id);
    speakingNow.delete(id);
    if (userEls.has(id)) userEls.get(id).classList.remove('speaking');
  }

  socket.on('signal', async ({ from, data }) => {
    if (!data) return;
    let peer = peers.get(from);

    if (!peer) {
      if (data.type !== 'offer') return;
      peer = createPeer(from, false);
    }

    const pc = peer.pc;

    try {
      if (data.type === 'offer') {
        await pc.setRemoteDescription(data.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('signal', { to: from, data: { type: 'answer', sdp: pc.localDescription } });
      } else if (data.type === 'answer') {
        if (pc.signalingState !== 'stable') await pc.setRemoteDescription(data.sdp);
      } else if (data.type === 'ice') {
        await pc.addIceCandidate(data.candidate).catch(() => {});
      }
    } catch (err) {
      console.error('signal error', err);
    }
  });

  /* ---------- socket events ---------- */
  socket.on('connect', () => {
    myId = socket.id;
    if (pendingJoin) {
      socket.emit('join', pendingJoin);
      pendingJoin = null;
      showApp();
    }
  });

  socket.on('existing-users', (list) => {
    list.forEach(u => {
      users.set(u.id, { nick: u.nick, avatar: u.avatar, muted: !!u.muted, deafened: !!u.deafened });
      renderUsers();
      createPeer(u.id, true);   // мы инициируем к тем, кто уже сидит
    });
  });

  socket.on('user-joined', (u) => {
    users.set(u.id, { nick: u.nick, avatar: u.avatar, muted: !!u.muted, deafened: !!u.deafened });
    renderUsers();
    // offer придёт от них
  });

  socket.on('user-state', ({ id, ...state }) => {
    const u = users.get(id);
    if (!u) return;
    Object.assign(u, state);
    renderUsers();
  });

  socket.on('user-left', (id) => {
    users.delete(id);
    removePeer(id);
    renderUsers();
  });

  socket.on('disconnect', () => {
    peers.forEach((_, id) => removePeer(id));
  });

  /* ---------- индикатор говорящего ---------- */
  function avgLevel(analyser) {
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    return sum / data.length;
  }

  function tick() {
    requestAnimationFrame(tick);

    const now = new Set();

    if (localAnalyser && !muted) {
      if (avgLevel(localAnalyser) > 12) now.add(myId);
    }

    remoteAnalysers.forEach((an, id) => {
      const u = users.get(id);
      if (u && u.muted) return;
      if (avgLevel(an) > 12) now.add(id);
    });

    // обновляем только изменившиеся
    now.forEach(id => {
      if (!speakingNow.has(id)) {
        speakingNow.add(id);
        const el = userEls.get(id);
        if (el) el.classList.add('speaking');
      }
    });
    [...speakingNow].forEach(id => {
      if (!now.has(id)) {
        speakingNow.delete(id);
        const el = userEls.get(id);
        if (el) el.classList.remove('speaking');
      }
    });
  }

  /* ---------- вход ---------- */
  function showApp() {
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
    $('roomName').textContent = myRoom;
    users.set(myId, { nick: myNick, avatar: myAvatar, muted, deafened });
    renderUsers();
  }

  $('joinBtn').addEventListener('click', async () => {
    const err = $('loginError');
    err.textContent = '';

    myNick = $('nickInput').value.trim();
    myRoom = ($('roomInput').value.trim() || 'general').toLowerCase();

    if (!myNick) { err.textContent = t('errNick'); return; }
    if (!myRoom) { err.textContent = t('errRoom'); return; }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      err.textContent = t('errHttps');
      return;
    }

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });
    } catch (e) {
      err.textContent = t('errMic');
      return;
    }

    // анализ своего микрофона
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      const src = audioCtx.createMediaStreamSource(localStream);
      localAnalyser = audioCtx.createAnalyser();
      localAnalyser.fftSize = 512;
      src.connect(localAnalyser);
    } catch (e) { /* без индикатора, но работаем */ }

    localStorage.setItem('nick', myNick);
    localStorage.setItem('room', myRoom);

    const payload = { room: myRoom, nick: myNick, avatar: myAvatar };

    if (myId) {
      socket.emit('join', payload);
      showApp();
    } else {
      pendingJoin = payload;   // ждём connect
    }

    tick();
  });

  $('nickInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('joinBtn').click(); });
  $('roomInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('joinBtn').click(); });

  /* ---------- init ---------- */
  $('nickInput').value = myNick;
  $('roomInput').value = myRoom;
  refreshAvatarPreview();
  applyLang();
})();
