# Modular Framework Documentation

## High-Level System Overview

### Problem Statement
The Modular Framework aims to provide a flexible and extensible architecture for building modular applications. It allows developers to create, manage, and interact with various modules, each serving distinct functionalities. The framework is particularly focused on enabling browser automation, API interaction, and modular integration with third-party services like GitHub.

### Architecture Overview
The Modular Framework is organized into a multi-module structure, where each module encapsulates specific features and functionalities. The core components of the framework include:

- **Core Framework**: Contains the foundational configurations and settings, including Docker configurations for containerization.
- **Modules**: Each module is a self-contained unit that provides specific capabilities:
  - **RAG**: A module for managing retrieval-augmented generation tasks.
  - **Browser**: A module that facilitates browser automation and interaction via Puppeteer.
  - **GitHub Hub**: A module for interacting with GitHub's API.
  - **LLM Chat**: A module for implementing chat functionalities using large language models.

The framework utilizes Docker for containerization, ensuring that each module can run in isolation with its dependencies.

### Data Flow
1. **Client Interaction**: Users interact with the system through a web interface or API endpoints.
2. **API Requests**: The server processes incoming API requests, which may involve launching browser sessions, navigating to URLs, or managing bookmarks.
3. **Browser Automation**: The Browser module utilizes Puppeteer to automate browser actions such as navigation, clicking, and typing.
4. **Data Handling**: Responses from external APIs or browser sessions are processed and returned to the client, ensuring that content is appropriately formatted (e.g., injecting `<base>` tags for HTML responses).
5. **WebSocket Communication**: Real-time communication is facilitated through WebSocket connections, allowing for dynamic updates and interactions between the client and server.

### Security Model
The security model of the Modular Framework includes the following components:

- **Authentication**: Basic authentication is implemented using a control token for WebSocket connections. This is currently set to allow all requests in a development environment but can be extended for production use.
- **Input Validation**: The framework validates incoming requests to ensure that URLs are properly formatted and do not point to private IP addresses, mitigating server-side request forgery (SSRF) risks.
- **CORS**: Cross-Origin Resource Sharing (CORS) is enabled to allow controlled access to resources from different origins.
- **Session Management**: Each browser session is managed through unique identifiers, and sessions can be created or terminated via API endpoints.

### Key Decisions
- **Modular Design**: The decision to structure the framework into discrete modules allows for better maintainability and scalability. Each module can be developed, tested, and deployed independently.
- **Use of Puppeteer**: Puppeteer was chosen for browser automation due to its robust API and ability to control headless Chrome instances, making it suitable for various web scraping and testing tasks.
- **Dockerization**: The entire framework is containerized using Docker, ensuring consistent environments across development, testing, and production stages.
- **WebSocket Integration**: The choice to use WebSockets for real-time communication enhances the interactivity of the application, allowing for immediate feedback and updates.

### Conclusion
The Modular Framework provides a comprehensive solution for building modular applications with a focus on browser automation and API interactions. Its architecture promotes flexibility and scalability, making it suitable for a wide range of use cases. The security model and key design decisions ensure that the framework is robust and maintainable, paving the way for future enhancements and integrations.