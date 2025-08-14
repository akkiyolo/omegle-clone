class CollegeConnect {
    constructor() {
        // Initialize Socket.IO with better error handling
        this.socket = io({
            transports: ['websocket', 'polling'],
            upgrade: true,
            rememberUpgrade: true,
            timeout: 20000,
            forceNew: false,
            autoConnect: true,
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionAttempts: 5,
            maxReconnectionAttempts: 5
        });
        
        this.localStream = null;
        this.remoteStream = null;
        this.peerConnection = null;
        this.currentUser = null;
        this.connectionTimer = null;
        this.startTime = null;
        this.partnerId = null;
        this.isConnecting = false;
        
        this.initializeEventListeners();
        this.setupSocketListeners();
        this.checkConnectionStatus();
        this.addConnectionStatusIndicator();
    }

    addConnectionStatusIndicator() {
        const statusDiv = document.createElement('div');
        statusDiv.id = 'connection-status';
        statusDiv.className = 'connection-status';
        statusDiv.textContent = 'Connecting...';
        document.body.appendChild(statusDiv);
    }

    initializeEventListeners() {
        // Registration form
        document.getElementById('registration-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleRegistration();
        });

        // Matching controls
        document.getElementById('cancel-matching').addEventListener('click', () => {
            this.showScreen('auth-screen');
        });

        // Video controls
        document.getElementById('toggle-video').addEventListener('click', () => {
            this.toggleVideo();
        });

        document.getElementById('toggle-audio').addEventListener('click', () => {
            this.toggleAudio();
        });

        document.getElementById('share-screen').addEventListener('click', () => {
            this.shareScreen();
        });

        document.getElementById('next-connection').addEventListener('click', () => {
            this.nextConnection();
        });

        document.getElementById('report-user').addEventListener('click', () => {
            this.reportUser();
        });

        // Chat functionality
        document.getElementById('send-message').addEventListener('click', () => {
            this.sendMessage();
        });

        document.getElementById('message-input').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.sendMessage();
            }
        });

        // Icebreaker suggestions
        document.querySelectorAll('.icebreaker').forEach(button => {
            button.addEventListener('click', (e) => {
                document.getElementById('message-input').value = e.target.textContent;
            });
        });
    }

    setupSocketListeners() {
        this.socket.on('connect', () => {
            console.log('✅ Connected to server');
            this.updateConnectionStatus('Connected', 'connected');
        });

        this.socket.on('disconnect', (reason) => {
            console.log('❌ Disconnected from server:', reason);
            this.updateConnectionStatus('Disconnected', 'disconnected');
        });

        this.socket.on('reconnect', (attemptNumber) => {
            console.log('🔄 Reconnected after', attemptNumber, 'attempts');
            this.updateConnectionStatus('Reconnected', 'connected');
        });

        this.socket.on('reconnect_attempt', (attemptNumber) => {
            console.log('🔄 Reconnection attempt', attemptNumber);
            this.updateConnectionStatus(`Reconnecting... (${attemptNumber})`, 'disconnected');
        });

        this.socket.on('waiting-for-match', (data) => {
            console.log('⏳ Waiting for match...', data);
            const position = data?.position || '';
            this.updateMatchingStatus(`Finding your study buddy... ${position ? `(Position: ${position})` : ''}`);
        });

        this.socket.on('match-found', async (data) => {
            console.log('🎉 Match found:', data);
            this.partnerId = data.partnerId;
            await this.handleMatchFound(data);
        });

        this.socket.on('offer', async (data) => {
            console.log('📞 Received offer');
            await this.handleOffer(data);
        });

        this.socket.on('answer', async (data) => {
            console.log('✅ Received answer');
            await this.handleAnswer(data);
        });

        this.socket.on('ice-candidate', async (data) => {
            console.log('🧊 Received ICE candidate');
            await this.handleIceCandidate(data);
        });

        this.socket.on('chat-message', (data) => {
            this.displayMessage(data.message, false);
        });

        this.socket.on('partner-disconnected', () => {
            this.handlePartnerDisconnected();
        });

        this.socket.on('error', (error) => {
            console.error('❌ Socket error:', error);
            this.showError(error.message || 'Connection error occurred');
        });

        this.socket.on('report-submitted', (data) => {
            this.showSuccess(`Report submitted successfully. Report ID: ${data.reportId}`);
        });
    }

    handleRegistration() {
        const email = document.getElementById('email').value.trim();
        const name = document.getElementById('name').value.trim();
        const university = document.getElementById('university').value;
        const major = document.getElementById('major').value;
        const year = document.getElementById('year').value;

        // Validation
        if (!email || !name || !university) {
            this.showError('Please fill in all required fields');
            return;
        }

        // Basic .edu email validation
        if (!email.endsWith('.edu')) {
            this.showError('Please use a valid .edu email address');
            return;
        }

        this.currentUser = {
            email,
            name,
            university,
            major,
            year,
            filters: {
                sameUniversity: document.getElementById('same-university').checked,
                sameMajor: document.getElementById('same-major').checked,
                sameYear: document.getElementById('same-year').checked
            }
        };

        this.startMatching();
    }

    async startMatching() {
        if (this.isConnecting) return;
        this.isConnecting = true;
        
        this.showScreen('matching-screen');
        
        try {
            // Get user media with better error handling
            this.localStream = await navigator.mediaDevices.getUserMedia({
                video: { 
                    width: { ideal: 1280, max: 1920 },
                    height: { ideal: 720, max: 1080 },
                    frameRate: { ideal: 30, max: 60 }
                },
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });

            console.log('📹 Media access granted');

            // Update filters from UI
            this.currentUser.filters = {
                sameUniversity: document.getElementById('same-university').checked,
                sameMajor: document.getElementById('same-major').checked,
                sameYear: document.getElementById('same-year').checked
            };

            // Join matching queue
            this.socket.emit('join-queue', this.currentUser);
        } catch (error) {
            console.error('❌ Error accessing media devices:', error);
            let errorMessage = 'Please allow camera and microphone access to continue.';
            
            if (error.name === 'NotFoundError') {
                errorMessage = 'No camera or microphone found. Please connect your devices and try again.';
            } else if (error.name === 'NotAllowedError') {
                errorMessage = 'Camera and microphone access denied. Please allow access and refresh the page.';
            } else if (error.name === 'NotReadableError') {
                errorMessage = 'Camera or microphone is already in use by another application.';
            }
            
            this.showError(errorMessage);
            this.showScreen('auth-screen');
        } finally {
            this.isConnecting = false;
        }
    }

    async handleMatchFound(data) {
        this.showScreen('chat-screen');
        this.setupPeerConnection();
        
        // Display partner info
        const partnerInfo = data.partnerInfo;
        document.getElementById('partner-name').textContent = partnerInfo.name;
        document.getElementById('partner-details').textContent = 
            `${partnerInfo.university} • ${partnerInfo.major || 'Undeclared'} • ${partnerInfo.year || 'Unknown year'}`;

        // Start connection timer
        this.startConnectionTimer();

        // Display local video
        const localVideo = document.getElementById('local-video');
        localVideo.srcObject = this.localStream;

        // Create and send offer
        try {
            const offer = await this.peerConnection.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            });
            await this.peerConnection.setLocalDescription(offer);
            
            this.socket.emit('offer', {
                offer: offer,
                target: data.partnerId
            });
            console.log('📤 Sent offer to partner');
        } catch (error) {
            console.error('❌ Error creating offer:', error);
        }
    }

    setupPeerConnection() {
        const configuration = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
                { urls: 'stun:stun3.l.google.com:19302' },
                { urls: 'stun:stun4.l.google.com:19302' }
            ],
            iceCandidatePoolSize: 10
        };

        this.peerConnection = new RTCPeerConnection(configuration);

        // Add local stream
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => {
                this.peerConnection.addTrack(track, this.localStream);
            });
        }

        // Handle remote stream
        this.peerConnection.ontrack = (event) => {
            console.log('📺 Received remote stream');
            const remoteVideo = document.getElementById('remote-video');
            if (event.streams && event.streams[0]) {
                remoteVideo.srcObject = event.streams[0];
            }
        };

        // Handle ICE candidates
        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate && this.partnerId) {
                this.socket.emit('ice-candidate', {
                    candidate: event.candidate,
                    target: this.partnerId
                });
            }
        };

        // Handle connection state changes
        this.peerConnection.onconnectionstatechange = () => {
            console.log('🔗 Connection state:', this.peerConnection.connectionState);
            if (this.peerConnection.connectionState === 'failed') {
                this.handleConnectionFailure();
            }
        };

        this.peerConnection.oniceconnectionstatechange = () => {
            console.log('🧊 ICE connection state:', this.peerConnection.iceConnectionState);
        };
    }

    async handleOffer(data) {
        this.partnerId = data.sender;
        this.setupPeerConnection();
        
        try {
            await this.peerConnection.setRemoteDescription(data.offer);
            const answer = await this.peerConnection.createAnswer();
            await this.peerConnection.setLocalDescription(answer);
            
            this.socket.emit('answer', {
                answer: answer,
                target: data.sender
            });

            // Display local video
            const localVideo = document.getElementById('local-video');
            localVideo.srcObject = this.localStream;
            console.log('📤 Sent answer to partner');
        } catch (error) {
            console.error('❌ Error handling offer:', error);
        }
    }

    async handleAnswer(data) {
        try {
            await this.peerConnection.setRemoteDescription(data.answer);
            console.log('✅ Set remote description from answer');
        } catch (error) {
            console.error('❌ Error handling answer:', error);
        }
    }

    async handleIceCandidate(data) {
        try {
            await this.peerConnection.addIceCandidate(data.candidate);
        } catch (error) {
            console.error('❌ Error adding ICE candidate:', error);
        }
    }

    toggleVideo() {
        const videoTrack = this.localStream?.getVideoTracks()[0];
        if (videoTrack) {
            videoTrack.enabled = !videoTrack.enabled;
            const button = document.getElementById('toggle-video');
            button.textContent = videoTrack.enabled ? '📹' : '📹❌';
            button.style.opacity = videoTrack.enabled ? '1' : '0.5';
        }
    }

    toggleAudio() {
        const audioTrack = this.localStream?.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            const button = document.getElementById('toggle-audio');
            button.textContent = audioTrack.enabled ? '🎤' : '🎤❌';
            button.style.opacity = audioTrack.enabled ? '1' : '0.5';
        }
    }

    async shareScreen() {
        try {
            const screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: true
            });

            const videoTrack = screenStream.getVideoTracks()[0];
            const sender = this.peerConnection?.getSenders().find(s => 
                s.track && s.track.kind === 'video'
            );

            if (sender) {
                await sender.replaceTrack(videoTrack);
            }

            videoTrack.onended = () => {
                // Switch back to camera when screen sharing ends
                const cameraTrack = this.localStream?.getVideoTracks()[0];
                if (sender && cameraTrack) {
                    sender.replaceTrack(cameraTrack);
                }
            };
        } catch (error) {
            console.error('❌ Error sharing screen:', error);
            this.showError('Screen sharing failed. Please try again.');
        }
    }

    nextConnection() {
        this.socket.emit('next-connection');
        this.resetConnection();
        this.startMatching();
    }

    reportUser() {
        const reasons = [
            '1. Inappropriate behavior',
            '2. Harassment or bullying',
            '3. Spam or scam',
            '4. Nudity or sexual content',
            '5. Violence or threats',
            '6. Other'
        ];
        
        const reason = prompt(`Please select a reason for reporting:\n${reasons.join('\n')}`);
        if (reason) {
            this.socket.emit('report-user', {
                reportedUser: this.partnerId,
                reason: reason,
                timestamp: new Date()
            });
        }
    }

    sendMessage() {
        const input = document.getElementById('message-input');
        const message = input.value.trim();
        
        if (message && message.length <= 500) {
            this.socket.emit('chat-message', { message });
            this.displayMessage(message, true);
            input.value = '';
        } else if (message.length > 500) {
            this.showError('Message too long (max 500 characters)');
        }
    }

    displayMessage(message, isSent) {
        const messagesContainer = document.getElementById('chat-messages');
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${isSent ? 'sent' : 'received'}`;
        messageDiv.textContent = message;
        
        const timestamp = document.createElement('span');
        timestamp.className = 'timestamp';
        timestamp.textContent = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        messageDiv.appendChild(timestamp);
        
        messagesContainer.appendChild(messageDiv);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    startConnectionTimer() {
        this.startTime = Date.now();
        this.connectionTimer = setInterval(() => {
            const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
            const minutes = Math.floor(elapsed / 60);
            const seconds = elapsed % 60;
            document.getElementById('connection-timer').textContent = 
                `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }, 1000);
    }

    handlePartnerDisconnected() {
        this.showError('Your partner has disconnected');
        this.resetConnection();
        setTimeout(() => this.startMatching(), 2000);
    }

    resetConnection() {
        if (this.connectionTimer) {
            clearInterval(this.connectionTimer);
            this.connectionTimer = null;
        }

        if (this.peerConnection) {
            this.peerConnection.close();
            this.peerConnection = null;
        }

        // Clear chat messages
        document.getElementById('chat-messages').innerHTML = '';
        
        // Reset partner info
        document.getElementById('partner-name').textContent = 'Connecting...';
        document.getElementById('partner-details').textContent = '';
        document.getElementById('connection-timer').textContent = '00:00';
        
        this.partnerId = null;
    }

    showScreen(screenId) {
        document.querySelectorAll('.screen').forEach(screen => {
            screen.classList.remove('active');
        });
        document.getElementById(screenId).classList.add('active');
    }

    checkConnectionStatus() {
        setInterval(() => {
            if (!this.socket.connected) {
                this.updateConnectionStatus('Reconnecting...', 'disconnected');
            }
        }, 5000);
    }

    updateConnectionStatus(status, type = 'connecting') {
        const statusElement = document.getElementById('connection-status');
        if (statusElement) {
            statusElement.textContent = status;
            statusElement.className = `connection-status ${type}`;
        }
        console.log('📡 Connection status:', status);
    }

    updateMatchingStatus(message) {
        const matchingScreen = document.querySelector('.matching-container h2');
        if (matchingScreen) {
            matchingScreen.textContent = message;
        }
    }

    handleConnectionFailure() {
        console.log('❌ WebRTC connection failed, attempting to reconnect...');
        this.showError('Connection failed. Trying to reconnect...');
        setTimeout(() => {
            if (this.partnerId) {
                this.resetConnection();
                this.startMatching();
            }
        }, 3000);
    }

    showError(message) {
        // Create or update error notification
        let errorDiv = document.getElementById('error-notification');
        if (!errorDiv) {
            errorDiv = document.createElement('div');
            errorDiv.id = 'error-notification';
            errorDiv.className = 'notification error';
            document.body.appendChild(errorDiv);
        }
        
        errorDiv.textContent = message;
        errorDiv.style.display = 'block';
        
        setTimeout(() => {
            errorDiv.style.display = 'none';
        }, 5000);
    }

    showSuccess(message) {
        // Create or update success notification
        let successDiv = document.getElementById('success-notification');
        if (!successDiv) {
            successDiv = document.createElement('div');
            successDiv.id = 'success-notification';
            successDiv.className = 'notification success';
            document.body.appendChild(successDiv);
        }
        
        successDiv.textContent = message;
        successDiv.style.display = 'block';
        
        setTimeout(() => {
            successDiv.style.display = 'none';
        }, 3000);
    }
}

// Initialize the app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    console.log('🎓 College Connect initializing...');
    new CollegeConnect();
});