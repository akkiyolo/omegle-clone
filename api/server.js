const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.socket.io"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "wss:", "ws:", "https:"],
      mediaSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameSrc: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(cors({
  origin: "*",
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"]
}));

app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// In-memory storage (use Redis for production scaling)
const users = new Map();
const waitingQueue = [];
const activeConnections = new Map();
const reportedUsers = new Map();

// Create HTTP server and Socket.IO
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000
});

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    users: users.size, 
    queue: waitingQueue.length,
    connections: activeConnections.size,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/stats', (req, res) => {
  res.json({
    totalUsers: users.size,
    waitingUsers: waitingQueue.length,
    activeConnections: activeConnections.size,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/report', (req, res) => {
  const { reportedUserId, reason, reporterInfo } = req.body;
  
  if (!reportedUserId || !reason) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const reportId = Date.now().toString();
  reportedUsers.set(reportId, {
    reportedUserId,
    reason,
    reporterInfo,
    timestamp: new Date(),
    status: 'pending'
  });

  console.log('User reported:', { reportedUserId, reason });
  res.json({ success: true, reportId });
});

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-queue', (userData) => {
    try {
      // Validate .edu email
      if (!userData.email || !userData.email.endsWith('.edu')) {
        socket.emit('error', { message: 'Valid .edu email required' });
        return;
      }

      // Validate required fields
      if (!userData.name || !userData.university) {
        socket.emit('error', { message: 'Name and university are required' });
        return;
      }

      users.set(socket.id, {
        ...userData,
        socketId: socket.id,
        joinedAt: new Date(),
        ipAddress: socket.handshake.address
      });
      
      findMatch(socket);
    } catch (error) {
      console.error('Error in join-queue:', error);
      socket.emit('error', { message: 'Server error occurred' });
    }
  });

  socket.on('offer', (data) => {
    try {
      if (data.target && io.sockets.sockets.has(data.target)) {
        socket.to(data.target).emit('offer', {
          offer: data.offer,
          sender: socket.id
        });
      }
    } catch (error) {
      console.error('Error in offer:', error);
    }
  });

  socket.on('answer', (data) => {
    try {
      if (data.target && io.sockets.sockets.has(data.target)) {
        socket.to(data.target).emit('answer', {
          answer: data.answer,
          sender: socket.id
        });
      }
    } catch (error) {
      console.error('Error in answer:', error);
    }
  });

  socket.on('ice-candidate', (data) => {
    try {
      if (data.target && io.sockets.sockets.has(data.target)) {
        socket.to(data.target).emit('ice-candidate', {
          candidate: data.candidate,
          sender: socket.id
        });
      }
    } catch (error) {
      console.error('Error in ice-candidate:', error);
    }
  });

  socket.on('chat-message', (data) => {
    try {
      const connection = activeConnections.get(socket.id);
      if (connection && data.message) {
        // Basic profanity filter
        const filteredMessage = filterProfanity(data.message);
        
        socket.to(connection.partnerId).emit('chat-message', {
          message: filteredMessage,
          sender: socket.id,
          timestamp: new Date()
        });
      }
    } catch (error) {
      console.error('Error in chat-message:', error);
    }
  });

  socket.on('next-connection', () => {
    try {
      disconnectUser(socket.id);
      const user = users.get(socket.id);
      if (user) {
        findMatch(socket);
      }
    } catch (error) {
      console.error('Error in next-connection:', error);
    }
  });

  socket.on('report-user', (data) => {
    try {
      const reportId = Date.now().toString();
      reportedUsers.set(reportId, {
        ...data,
        reporterId: socket.id,
        timestamp: new Date()
      });
      console.log('User reported via socket:', data);
      socket.emit('report-submitted', { reportId });
    } catch (error) {
      console.error('Error in report-user:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    disconnectUser(socket.id);
  });

  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

function findMatch(socket) {
  const user = users.get(socket.id);
  if (!user) return;

  // Remove from waiting queue if already there
  const queueIndex = waitingQueue.findIndex(id => id === socket.id);
  if (queueIndex > -1) {
    waitingQueue.splice(queueIndex, 1);
  }

  // Find potential matches
  let potentialMatches = waitingQueue.filter(waitingId => {
    const waitingUser = users.get(waitingId);
    if (!waitingUser || !io.sockets.sockets.has(waitingId)) return false;

    // Apply matching filters
    if (user.filters?.sameUniversity && user.university !== waitingUser.university) {
      return false;
    }
    if (user.filters?.sameMajor && user.major && waitingUser.major && user.major !== waitingUser.major) {
      return false;
    }
    if (user.filters?.sameYear && user.year && waitingUser.year && user.year !== waitingUser.year) {
      return false;
    }

    return true;
  });

  if (potentialMatches.length > 0) {
    // Match with random user from potential matches
    const randomIndex = Math.floor(Math.random() * potentialMatches.length);
    const partnerId = potentialMatches[randomIndex];
    const partnerSocket = io.sockets.sockets.get(partnerId);
    
    if (partnerSocket) {
      // Remove partner from queue
      const partnerIndex = waitingQueue.indexOf(partnerId);
      if (partnerIndex > -1) {
        waitingQueue.splice(partnerIndex, 1);
      }

      // Create connection
      activeConnections.set(socket.id, { 
        partnerId, 
        connectedAt: new Date(),
        university: user.university 
      });
      activeConnections.set(partnerId, { 
        partnerId: socket.id, 
        connectedAt: new Date(),
        university: users.get(partnerId)?.university 
      });

      // Notify both users with sanitized info
      const partnerInfo = users.get(partnerId);
      const sanitizedPartnerInfo = {
        name: partnerInfo.name,
        university: partnerInfo.university,
        major: partnerInfo.major || 'Undeclared',
        year: partnerInfo.year || 'Unknown'
      };

      const sanitizedUserInfo = {
        name: user.name,
        university: user.university,
        major: user.major || 'Undeclared',
        year: user.year || 'Unknown'
      };

      socket.emit('match-found', { partnerId, partnerInfo: sanitizedPartnerInfo });
      partnerSocket.emit('match-found', { partnerId: socket.id, partnerInfo: sanitizedUserInfo });
    }
  } else {
    // Add to waiting queue
    if (!waitingQueue.includes(socket.id)) {
      waitingQueue.push(socket.id);
    }
    socket.emit('waiting-for-match', { position: waitingQueue.length });
  }
}

function disconnectUser(socketId) {
  const connection = activeConnections.get(socketId);
  if (connection) {
    const partnerSocket = io.sockets.sockets.get(connection.partnerId);
    if (partnerSocket) {
      partnerSocket.emit('partner-disconnected');
    }
    activeConnections.delete(socketId);
    activeConnections.delete(connection.partnerId);
  }

  // Remove from waiting queue
  const queueIndex = waitingQueue.findIndex(id => id === socketId);
  if (queueIndex > -1) {
    waitingQueue.splice(queueIndex, 1);
  }

  users.delete(socketId);
}

function filterProfanity(message) {
  // Basic profanity filter - expand as needed
  const profanityList = ['spam', 'scam', 'inappropriate', 'fuck', 'shit', 'damn'];
  let filtered = message;
  
  profanityList.forEach(word => {
    const regex = new RegExp(word, 'gi');
    filtered = filtered.replace(regex, '*'.repeat(word.length));
  });
  
  return filtered;
}

// Handle all other routes - serve index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Export for Vercel
module.exports = app;

// For local development
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`🎓 College Connect server running on port ${PORT}`);
    console.log(`📱 Visit: http://localhost:${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
  });
}