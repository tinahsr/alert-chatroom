const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const chatrooms = new Map();

app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/', (req, res) => {
  res.render('index');
});

app.post('/create-room', (req, res) => {
  const roomId = uuidv4();
  chatrooms.set(roomId, { 
    users: new Map(),
    host: null,
    hostUsername: null,
    name: req.body.roomName,
    showPastMessages: req.body.showPastMessages === 'on',
    messages: [],
    hostTimeout: null,
    deletionTimeout: null
  });
  res.redirect(`/room/${roomId}`);
});

app.get('/room/:roomId', (req, res) => {
  const roomId = req.params.roomId;
  if (chatrooms.has(roomId)) {
    res.render('chatroom', { roomId });
  } else {
    res.status(404).render('404');
  }
});

wss.on('connection', (ws, req) => {
  let roomId;
  let username;

  ws.on('message', (message) => {
    const data = JSON.parse(message);

    switch (data.type) {
      case 'join':
        roomId = data.roomId;
        username = data.username;

        if (chatrooms.has(roomId)) {
          const room = chatrooms.get(roomId);
          
          // Clear deletion timeout if it exists
          if (room.deletionTimeout) {
            clearTimeout(room.deletionTimeout);
            room.deletionTimeout = null;
          }

          // Check if username already exists
          if (Array.from(room.users.values()).includes(username)) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Username already taken'
            }));
            return;
          }
          
          room.users.set(ws, username);
          
          if (!room.host) {
            setNewHost(room, ws, username);
          } else if (username === room.hostUsername && room.hostTimeout) {
            clearTimeout(room.hostTimeout);
            room.hostTimeout = null;
            setNewHost(room, ws, username);
          }

          broadcastToRoom(roomId, {
            type: 'message',
            content: `${username} has joined the chat`,
            sender: 'System'
          });
          updateUsersList(roomId);
          ws.send(JSON.stringify({ 
            type: 'roomName', 
            name: room.name,
            host: room.hostUsername
          }));

          if (room.showPastMessages) {
            room.messages.forEach(msg => {
              ws.send(JSON.stringify(msg));
            });
          }
        } else {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Room not found'
          }));
        }
        break;

      
      case 'message':
        if (chatrooms.has(roomId)) {
            const messageId = uuidv4();
            const messageData = {
                type: 'message',
                messageId: messageId,
                content: data.content,
                sender: username,
                isFile: data.isFile || false,
                fileName: data.fileName || null,
                replyTo: data.replyTo ? {
                    messageId: data.replyTo.messageId,
                    sender: data.replyTo.sender,
                    content: data.replyTo.content.substring(0, 100) + (data.replyTo.content.length > 100 ? '...' : '')
                } : null,
                reactions: {}  // Initialize empty reactions object
            };
            chatrooms.get(roomId).messages.push(messageData);
            broadcastToRoom(roomId, messageData);
        } else {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Room not found'
            }));
        }
        break;

      case 'deleteMessage':
        if (chatrooms.has(roomId)) {
          const room = chatrooms.get(roomId);
          const messageIndex = room.messages.findIndex(m => m.messageId === data.messageId);
          if (messageIndex !== -1) {
            const message = room.messages[messageIndex];
            if (message.sender === username || room.host === ws) {
              room.messages.splice(messageIndex, 1);
              broadcastToRoom(roomId, {
                type: 'deleteMessage',
                messageId: data.messageId
              });
            }
          }
        }
        break;

      case 'roomName':
        if (chatrooms.has(roomId) && chatrooms.get(roomId).host === ws) {
          chatrooms.get(roomId).name = data.name;
          broadcastToRoom(roomId, {
            type: 'roomName',
            name: data.name,
            host: chatrooms.get(roomId).hostUsername
          });
        }
        break;

      case 'kick':
        if (chatrooms.has(roomId) && chatrooms.get(roomId).host === ws) {
          const userToKick = Array.from(chatrooms.get(roomId).users.entries())
            .find(([_, name]) => name === data.username);
          
          if (userToKick) {
            userToKick[0].send(JSON.stringify({ type: 'kicked' }));
            userToKick[0].close();
          }
        }
        break;

      case 'leave':
        handleUserLeave(ws, roomId, username);
        break;

      case 'reaction':
        handleReaction(roomId, username, data.messageId, data.emoji);
        break;

      case 'toggleReaction':
        handleToggleReaction(roomId, username, data.messageId, data.emoji);
        break;
    }
  });

  ws.on('close', () => {
    handleUserLeave(ws, roomId, username);
  });
});

function setNewHost(room, ws, username) {
  room.host = ws;
  room.hostUsername = username;
  ws.send(JSON.stringify({ type: 'host' }));
  broadcastToRoom(room, {
    type: 'newHost',
    host: username
  });
}

function handleUserLeave(ws, roomId, username) {
  if (roomId && chatrooms.has(roomId)) {
    const room = chatrooms.get(roomId);
    room.users.delete(ws);

    if (room.host === ws) {
      room.host = null;
      room.hostUsername = null;
      
      // Clear any existing host timeout
      if (room.hostTimeout) {
        clearTimeout(room.hostTimeout);
      }

      // Set a new host immediately if there are other users
      if (room.users.size > 0) {
        const [newHost, newHostUsername] = room.users.entries().next().value;
        setNewHost(room, newHost, newHostUsername);
        broadcastToRoom(roomId, {
          type: 'message',
          content: `${newHostUsername} is now the host.`,
          sender: 'System'
        });
      } else {
        // If no users left, set a deletion timeout
        room.deletionTimeout = setTimeout(() => {
          chatrooms.delete(roomId);
        }, 300000); // 5 minutes
      }
    }

    if (room.users.size > 0) {
        broadcastToRoom(roomId, {
            type: 'message',
            content: `${username} has left the chat`,
            sender: 'System'
        });
        updateUsersList(roomId);
    }

    // Remove user's reactions from all messages
    room.messages.forEach(message => {
        if (message.reactions) {
            Object.keys(message.reactions).forEach(emoji => {
                const index = message.reactions[emoji].indexOf(username);
                if (index > -1) {
                    message.reactions[emoji].splice(index, 1);
                    if (message.reactions[emoji].length === 0) {
                        delete message.reactions[emoji];
                    }
                    broadcastReactions(roomId, message.messageId, message.reactions);
                }
            });
        }
    });
  }
}

function broadcastToRoom(roomId, message) {
  if (chatrooms.has(roomId)) {
    chatrooms.get(roomId).users.forEach((username, client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
      }
    });
  }
}

function updateUsersList(roomId) {
  if (chatrooms.has(roomId)) {
    const room = chatrooms.get(roomId);
    const users = Array.from(room.users.values());
    broadcastToRoom(roomId, {
      type: 'userList',
      users: users,
      host: room.hostUsername
    });
  }
}

function handleReaction(roomId, username, messageId, emoji) {
  if (chatrooms.has(roomId)) {
    const room = chatrooms.get(roomId);
    const message = room.messages.find(m => m.messageId === messageId);
    if (message) {
      if (!message.reactions) {
        message.reactions = {};
      }
      if (!message.reactions[emoji]) {
        message.reactions[emoji] = [];
      }
      if (!message.reactions[emoji].includes(username)) {
        message.reactions[emoji].push(username);
        broadcastReactions(roomId, messageId, message.reactions);
      }
    }
  }
}

function handleToggleReaction(roomId, username, messageId, emoji) {
  if (chatrooms.has(roomId)) {
    const room = chatrooms.get(roomId);
    const message = room.messages.find(m => m.messageId === messageId);
    if (message && message.reactions && message.reactions[emoji]) {
      const index = message.reactions[emoji].indexOf(username);
      if (index > -1) {
        message.reactions[emoji].splice(index, 1);
        if (message.reactions[emoji].length === 0) {
          delete message.reactions[emoji];
        }
      } else {
        message.reactions[emoji].push(username);
      }
      broadcastReactions(roomId, messageId, message.reactions);
    }
  }
}

function broadcastReactions(roomId, messageId, reactions) {
  broadcastToRoom(roomId, {
    type: 'updateReactions',
    messageId: messageId,
    reactions: reactions
  });
}

app.use((req, res, next) => {
  res.status(404).render('404');
});

function retrieveFromHostIni(section, key) {
  const fs = require('fs');
  const ini = require('ini');
  const config = ini.parse(fs.readFileSync('host.ini', 'utf-8'));
  return config[section][key];
}

function ThreadRunJPRQ() {
  // retrieve COMMAND from host.ini
  const COMMAND = retrieveFromHostIni('JPRQ', 'COMMAND');
  // retrieve ARGS from host.ini
  const ARGS = retrieveFromHostIni('JPRQ', 'ARGS');

  // execute command
  exec(`${COMMAND} http ${retrieveFromHostIni('JPRQ', 'PORT')} ${ARGS}`, (error, stdout, stderr) => {
    if (error) {
      console.error(`exec error: ${error}`);
      return;
    }
    console.log(`stdout: ${stdout}`);
    console.error(`stderr: ${stderr}`);
  });
}

const PORT = retrieveFromHostIni('JPRQ', 'PORT');
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  if (retrieveFromHostIni('GENERAL', 'MODE') === 'JPRQ') {
    ThreadRunJPRQ();
  }
});