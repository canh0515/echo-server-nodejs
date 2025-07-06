const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const httpProxy = require('http-proxy');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const proxy = httpProxy.createProxyServer();

const PORT = process.env.PORT || 3000; // Cổng mà máy chủ proxy sẽ lắng nghe
const LOCAL_MACHINE_WS_PORT = 3001; // Cổng trên máy cục bộ của bạn cho kết nối WebSocket

let localMachineWs = null; // Để lưu trữ kết nối WebSocket đến máy cục bộ của bạn

// --- Máy chủ WebSocket để giao tiếp với máy cục bộ ---
wss.on('connection', (ws) => {
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
            // Đây là dữ liệu WebSocket từ phía máy khách.
            // Bạn sẽ cần một cơ chế để ánh xạ nó trở lại WebSocket máy khách chính xác.
            // Để đơn giản, chúng ta sẽ giả định nó dành cho một WebSocket máy khách,
            // nhưng trong một kịch bản thực tế, bạn sẽ cần ID duy nhất cho các WebSocket máy khách.
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

// --- Proxy yêu cầu HTTP ---

app.locals.pendingResponses = {}; // Để lưu trữ các phản hồi HTTP đang chờ xử lý
app.locals.clientWebSockets = {}; // Để lưu trữ các WebSocket máy khách đang hoạt động

app.use((req, res, next) => {
    if (!localMachineWs) {
        return res.status(503).send('Máy phát triển cục bộ không được kết nối.');
    }

    const requestId = Date.now().toString() + Math.random().toString(36).substring(2, 9);
    app.locals.pendingResponses[requestId] = res;

    // Chuyển tiếp yêu cầu HTTP đến máy cục bộ qua WebSocket
    localMachineWs.send(JSON.stringify({
        type: 'httpRequest',
        requestId: requestId,
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body ? req.body.toString('base64') : null, // Gửi body dưới dạng base64
    }));
});

// --- Proxy WebSocket cho các WebSocket máy khách ---
server.on('upgrade', (request, socket, head) => {
    if (!localMachineWs) {
        socket.destroy(); // Hủy nếu máy cục bộ không được kết nối
        return;
    }

    const clientId = Date.now().toString() + Math.random().toString(36).substring(2, 9);
    // Tạo một WebSocket giả lập cho phía máy khách để chúng ta có thể quản lý nó
    // và chuyển tiếp tin nhắn qua localMachineWs.
    // Lưu ý: Việc này phức tạp hơn một chút so với proxy HTTP.
    // Trong một giải pháp mạnh mẽ hơn, bạn có thể sử dụng thư viện proxy WebSocket chuyên dụng.
    // Đối với ví dụ này, chúng ta sẽ lưu trữ WebSocket của máy khách và chuyển tiếp dữ liệu.

    wss.handleUpgrade(request, socket, head, (ws) => {
        // ws ở đây là WebSocket thực tế của máy khách vừa kết nối
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
});


server.listen(PORT, () => {
    console.log(`Máy chủ Proxy Node.js đang lắng nghe trên cổng ${PORT}`);
});
