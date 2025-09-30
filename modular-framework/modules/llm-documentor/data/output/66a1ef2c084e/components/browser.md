# High-Level System Overview

## Problem Statement
The modular framework aims to provide a browser automation solution that allows users to programmatically control a headless browser instance. This is particularly useful for tasks such as web scraping, automated testing, and simulating user interactions with web applications. The system needs to handle multiple sessions, manage WebSocket connections for real-time communication, and ensure security against common vulnerabilities such as Server-Side Request Forgery (SSRF).

## Architecture Overview
The system is built using Node.js and leverages several key libraries:
- **Express**: For setting up the web server and handling HTTP requests.
- **Puppeteer**: For controlling the headless browser.
- **WebSocket**: For real-time communication between the server and client.
- **Axios**: For making HTTP requests to external URLs.
- **http-proxy**: For proxying requests to other servers.

### Components
1. **Express Server**: The core of the application, handling incoming HTTP requests and routing them to the appropriate handlers.
2. **WebSocket Server**: Facilitates real-time communication with UI clients, allowing commands to be sent and received.
3. **Puppeteer**: Manages browser sessions, enabling navigation, interaction, and data retrieval from web pages.
4. **Session Management**: Keeps track of active browser sessions, including their state and associated data.

### Data Flow
1. **Client Interaction**: Clients send HTTP requests to the Express server to perform actions such as creating sessions, navigating to URLs, and executing commands.
2. **Session Management**: Each session is launched using Puppeteer, and the session details (browser instance, page, etc.) are stored in a Map for easy access.
3. **WebSocket Communication**: Clients can establish a WebSocket connection to receive real-time updates and send commands to the server.
4. **Proxying Requests**: The server can proxy requests to external URLs, ensuring that only safe requests are processed, and modifying responses as necessary (e.g., injecting `<base>` tags into HTML).

## Security Model
The system incorporates several security measures:
- **Authorization**: A control token can be used to restrict access to certain endpoints (though currently disabled for development).
- **Input Validation**: Incoming requests are validated to ensure they contain the necessary parameters and that URLs are well-formed.
- **SSRF Protection**: The system checks resolved IP addresses against a list of private IP ranges to prevent unauthorized access to internal services.
- **WebSocket Security**: Connections are only allowed if they meet certain criteria, including valid authorization and session ID.

## Key Decisions
1. **Use of Puppeteer**: Puppeteer was chosen for its robust API for browser automation and its ability to run headlessly, making it suitable for server-side applications.
2. **WebSocket for Real-Time Communication**: The decision to use WebSocket allows for efficient, low-latency communication between the server and clients, which is essential for interactive applications.
3. **Session Management via Maps**: Utilizing JavaScript Maps for session management provides efficient access and manipulation of session data.
4. **CORS and Proxying**: Implementing CORS and a proxy mechanism allows the server to interact with external resources while maintaining security and flexibility.

This overview provides a comprehensive understanding of the system's architecture, data flow, and security considerations, setting the stage for further development and enhancements.