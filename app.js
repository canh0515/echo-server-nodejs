const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
// Quan trọng: Tạo WebSocket.Server mà không tự động gắn vào máy chủ HTTP
// để chúng ta có thể kiểm soát việc xử lý sự kiện 'upgrade' một cách thủ công.
const wss = new WebSocket.Server({ noServer: true });

const PORT = process.env.PORT || 3000; // Cổng mà máy chủ proxy sẽ lắng nghe

let localMachineWs = null; // Để lưu trữ kết nối WebSocket đến máy cục bộ của bạn
app.locals.pendingResponses = {}; // Để lưu trữ các phản hồi HTTP đang chờ xử lý
app.locals.clientWebSockets = {}; // Để lưu trữ các WebSocket máy khách đang hoạt động

// --- Xử lý yêu cầu HTTP (proxy đến máy cục bộ) ---
app.use((req, res, next) => {
    // Nếu đây là yêu cầu nâng cấp WebSocket, bỏ qua middleware HTTP này
    if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
        next();
        return;
    }

    if (!localMachineWs) {
        return res.status(503).send('Máy phát triển cục bộ không được kết nối.');
    }

    const requestId = Date.now().toString() + Math.random().toString(36).substring(2, 9);
    app.locals.pendingResponses[requestId] = res;

    // Đọc body của yêu cầu HTTP (nếu có)
    let requestBody = '';
    req.on('data', chunk => {
        requestBody += chunk.toString();
    });
    req.on('end', () => {
        // Chuyển tiếp yêu cầu HTTP đến máy cục bộ qua WebSocket
        localMachineWs.send(JSON.stringify({
            type: 'httpRequest',
            requestId: requestId,
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: requestBody ? Buffer.from(requestBody).toString('base64') : null, // Gửi body dưới dạng base64
        }));
    });
});

// --- Xử lý sự kiện 'upgrade' cho WebSocket ---
server.on('upgrade', (request, socket, head) => {
    // Kiểm tra đường dẫn yêu cầu để phân biệt kết nối từ ứng dụng cục bộ và máy khách
    if (request.url === '/local-app-ws') {
        // Đây là kết nối từ ứng dụng cục bộ của bạn
        wss.handleUpgrade(request, socket, head, (ws) => {
            // Phát ra một sự kiện tùy chỉnh để xử lý kết nối ứng dụng cục bộ
            wss.emit('local-app-connection', ws, request);
        });
    } else {
        // Đây là kết nối từ máy khách (trình duyệt)
        wss.handleUpgrade(request, socket, head, (ws) => {
            // Phát ra một sự kiện tùy chỉnh để xử lý kết nối máy khách
            wss.emit('client-connection', ws, request);
        });
    }
});

// --- Trình lắng nghe cho kết nối WebSocket từ máy cục bộ ---
wss.on('local-app-connection', (ws, request) => {
    console.log('Máy cục bộ đã kết nối qua WebSocket.');
    localMachineWs = ws;

    ws.on('message', (message) => {
        // Xử lý tin nhắn từ máy cục bộ (ví dụ: phản hồi cho các yêu cầu đã proxy)
        const data = JSON.parse(message);
        if (data.type === 'httpResponse' && data.requestId) {
            const res = app.locals.pendingResponses[data.requestId];
            if (res) {
                // Chuyển tiếp tiêu đề
                if (data.headers) {
                    for (const header in data.headers) {
                        res.setHeader(header, data.headers[header]);
                    }
                }
                res.writeHead(data.statusCode);
                res.end(Buffer.from(data.body, 'base64')); // Giả định body được mã hóa base64
                delete app.locals.pendingResponses[data.requestId];
            }
        } else if (data.type === 'wsData') {
            // Đây là dữ liệu WebSocket từ phía máy khách, được gửi từ máy cục bộ
            if (data.clientId && app.locals.clientWebSockets[data.clientId]) {
                app.locals.clientWebSockets[data.clientId].send(Buffer.from(data.data, 'base64'));
            }
        }
    });

    ws.on('close', () => {
        console.log('Máy cục bộ đã ngắt kết nối khỏi WebSocket.');
        localMachineWs = null;
    });

    ws.on('error', (error) => {
        console.error('Lỗi WebSocket với máy cục bộ:', error);
    });
});

// --- Trình lắng nghe cho kết nối WebSocket từ máy khách ---
wss.on('client-connection', (ws, request) => {
    if (!localMachineWs) {
        // Nếu máy cục bộ không được kết nối, đóng kết nối WebSocket của máy khách
        ws.close(1008, 'Local development machine not connected.'); // Mã lỗi 1008: Policy Violation
        console.log('WebSocket máy khách bị từ chối: Máy phát triển cục bộ không được kết nối.');
        return;
    }

    const clientId = Date.now().toString() + Math.random().toString(36).substring(2, 9);
    app.locals.clientWebSockets[clientId] = ws; // Lưu trữ WebSocket thực tế của máy khách

    console.log(`WebSocket máy khách đã kết nối với ID: ${clientId}`);
    // Thông báo cho máy cục bộ về WebSocket máy khách mới
    localMachineWs.send(JSON.stringify({
        type: 'wsClientConnect',
        clientId: clientId,
        url: request.url,
        headers: request.headers,
    }));

    ws.on('message', (message) => {
        // Chuyển tiếp tin nhắn WebSocket của máy khách đến máy cục bộ
        localMachineWs.send(JSON.stringify({
            type: 'wsClientData',
            clientId: clientId,
            data: message.toString('base64'),
        }));
    });

    ws.on('close', () => {
        console.log(`WebSocket máy khách đã ngắt kết nối với ID: ${clientId}`);
        delete app.locals.clientWebSockets[clientId];
        localMachineWs.send(JSON.stringify({
            type: 'wsClientDisconnect',
            clientId: clientId,
        }));
    });

    ws.on('error', (err) => {
        console.error(`Lỗi WebSocket máy khách cho ID ${clientId}:`, err);
    });
});

server.listen(PORT, () => {
    console.log(`Máy chủ Proxy Node.js đang lắng nghe trên cổng ${PORT}`);
});
