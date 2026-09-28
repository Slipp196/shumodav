const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

app.use(express.static(path.join(__dirname, 'public')));

// room -> Map(socketId -> { nick, avatar, muted, deafened })
const rooms = new Map();

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join', ({ room, nick, avatar }) => {
    if (!room || !nick) return;
    currentRoom = String(room).slice(0, 40).trim().toLowerCase();

    if (!rooms.has(currentRoom)) rooms.set(currentRoom, new Map());
    const roomMap = rooms.get(currentRoom);

    const me = {
      nick: String(nick).slice(0, 24),
      avatar: avatar || null,
      muted: false,
      deafened: false
    };

    // отправляем новому список уже сидящих
    const existing = [...roomMap.entries()].map(([id, u]) => ({ id, ...u }));
    socket.emit('existing-users', existing);

    roomMap.set(socket.id, me);
    socket.join(currentRoom);
    socket.to(currentRoom).emit('user-joined', { id: socket.id, ...me });
  });

  // пересылка WebRTC-сигналов
  socket.on('signal', ({ to, data }) => {
    if (!to || !data) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  // обновление состояния (мут / деф)
  socket.on('update-state', (state) => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const u = rooms.get(currentRoom).get(socket.id);
    if (!u) return;
    Object.assign(u, state);
    socket.to(currentRoom).emit('user-state', { id: socket.id, ...state });
  });

  socket.on('disconnect', () => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const roomMap = rooms.get(currentRoom);
    roomMap.delete(socket.id);
    if (roomMap.size === 0) rooms.delete(currentRoom);
    socket.to(currentRoom).emit('user-left', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Шумодав слушает http://localhost:${PORT}`));