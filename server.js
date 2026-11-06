const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, methods: ['GET', 'POST'] },
  transports: ['polling', 'websocket'],
  pingInterval: 25000,
  pingTimeout: 20000
});

const PORT = process.env.PORT || 10000;
const MAX_PLAYERS = 8;

// One shared global lobby. Everyone joins this same lobby; there are no room codes.
const lobby = {
  mode: null,
  players: new Map(),
  states: new Map(),
  started: false,
  timer: null
};

app.use(express.static(path.join(__dirname)));
app.get('/health', (_req, res) => res.json({
  ok: true,
  service: 'last-ones-standing',
  players: lobby.players.size,
  mode: lobby.mode,
  started: lobby.started
}));

function publicPlayers() {
  return [...lobby.players.values()];
}
function announce(text) {
  io.emit('announcement', { text });
}
function lobbyUpdate() {
  io.emit('lobby', {
    mode: lobby.mode,
    players: publicPlayers(),
    message: `Global lobby · ${lobby.players.size}/${MAX_PLAYERS} players`
  });
}
function startMatch() {
  if (lobby.started || (lobby.mode === 'br' && lobby.players.size < 2)) return;
  lobby.started = true;
  clearTimeout(lobby.timer);
  lobby.timer = null;
  io.emit('matchStart', {
    mode: lobby.mode,
    players: publicPlayers(),
    bots: Math.max(0, MAX_PLAYERS - lobby.players.size)
  });
  announce(`${lobby.mode === 'br' ? 'BATTLE ROYALE' : 'FREE FOR ALL'} has started! Good luck!`);
}
function resetLobby() {
  clearTimeout(lobby.timer);
  lobby.mode = null;
  lobby.players.clear();
  lobby.states.clear();
  lobby.started = false;
  lobby.timer = null;
  lobbyUpdate();
}
function safeNum(v) {
  v = Number(v);
  return Number.isFinite(v) ? Math.max(-100000, Math.min(100000, v)) : 0;
}

io.on('connection', socket => {
  socket.on('joinLobby', (data = {}) => {
    const mode = data.mode === 'ffa' ? 'ffa' : 'br';
    if (lobby.players.has(socket.id)) return;

    if (lobby.mode && lobby.mode !== mode) {
      socket.emit('roomError', {
        message: `The global lobby is currently playing ${lobby.mode === 'br' ? 'Battle Royale' : 'Free For All'}. Try again after that match.`
      });
      return;
    }
    if (lobby.mode === 'br' && lobby.started) {
      socket.emit('roomError', { message: 'Battle Royale is already underway. Please join after the round ends.' });
      return;
    }
    if (lobby.players.size >= MAX_PLAYERS) {
      socket.emit('roomError', { message: 'The global lobby is full (8 real players).' });
      return;
    }

    if (!lobby.mode) lobby.mode = mode;
    const player = {
      id: socket.id,
      name: String(data.name || 'Player').replace(/[<>]/g, '').slice(0, 12),
      character: ['scout', 'soldier', 'tank'].includes(data.character) ? data.character : 'soldier'
    };
    lobby.players.set(socket.id, player);
    socket.data.inLobby = true;

    socket.emit('roomJoined', { players: publicPlayers(), mode: lobby.mode });
    socket.broadcast.emit('playerJoined', player);
    lobbyUpdate();

    if (mode === 'br') {
      if (lobby.players.size >= 2) {
        clearTimeout(lobby.timer);
        io.emit('countdown', { seconds: 5, players: lobby.players.size });
        lobby.timer = setTimeout(startMatch, 5000);
      }
    } else if (!lobby.started) {
      startMatch();
    } else {
      socket.emit('matchStart', {
        mode: lobby.mode,
        players: publicPlayers(),
        bots: Math.max(0, MAX_PLAYERS - lobby.players.size)
      });
      announce(`${player.name} joined Free For All! A bot has been replaced.`);
    }
  });

  socket.on('playerState', s => {
    if (!lobby.started || !lobby.players.has(socket.id)) return;
    const p = lobby.players.get(socket.id);
    const clean = {
      id: socket.id,
      x: safeNum(s.x), y: safeNum(s.y),
      hp: safeNum(s.hp), sh: safeNum(s.sh),
      dead: !!s.dead, ang: safeNum(s.ang),
      w: String(s.w || 'pistol').slice(0, 20),
      rar: Math.max(0, Math.min(4, safeNum(s.rar))),
      kills: Math.max(0, safeNum(s.kills)),
      name: p.name, character: p.character,
      sk: s.sk && typeof s.sk === 'object' ? s.sk : undefined
    };
    lobby.states.set(socket.id, clean);
    socket.broadcast.emit('state', [clean]);
  });

  socket.on('playerShot', s => {
    if (!lobby.started || !lobby.players.has(socket.id)) return;
    socket.broadcast.emit('playerShot', {
      id: socket.id, a: safeNum(s.a), tx: safeNum(s.tx), ty: safeNum(s.ty),
      w: String(s.w || 'pistol').slice(0, 20),
      rar: Math.max(0, Math.min(4, safeNum(s.rar)))
    });
  });

  socket.on('chat', message => {
    if (!lobby.players.has(socket.id)) return;
    const p = lobby.players.get(socket.id);
    const clean = String(message || '').replace(/[<>]/g, '').trim().slice(0, 120);
    if (clean) io.emit('chat', { name: p.name, message: clean });
  });

  socket.on('endMatch', d => {
    if (!lobby.started || lobby.mode !== 'br') return;
    const winner = String(d && d.winner || '').replace(/[<>]/g, '').slice(0, 12);
    const text = winner ? `🏆 ${winner} won the Battle Royale!` : 'Battle Royale round ended!';
    announce(text);
    io.emit('matchEnded', { text });
    resetLobby();
  });

  socket.on('disconnect', () => {
    if (!lobby.players.has(socket.id)) return;
    const p = lobby.players.get(socket.id);
    lobby.players.delete(socket.id);
    lobby.states.delete(socket.id);
    socket.broadcast.emit('playerLeft', { id: socket.id, name: p.name });

    if (lobby.players.size === 0) {
      resetLobby();
      return;
    }
    if (!lobby.started && lobby.mode === 'br') {
      if (lobby.players.size < 2) {
        clearTimeout(lobby.timer);
        lobby.timer = null;
        io.emit('countdown', { seconds: 0, players: lobby.players.size });
      } else {
        clearTimeout(lobby.timer);
        io.emit('countdown', { seconds: 5, players: lobby.players.size });
        lobby.timer = setTimeout(startMatch, 5000);
      }
    }
    lobbyUpdate();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Last Ones Standing listening on port ${PORT}`);
});
