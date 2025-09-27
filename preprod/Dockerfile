FROM node:18-alpine

# Create app directory
WORKDIR /app

# Copy all project files
COPY . .

# Install global lightweight static server 'serve'
RUN npm install -g serve@14.1.2

# Expose the port the app will run on
EXPOSE 3020

# Serve the current directory as a static site on 0.0.0.0:3020
# Using tcp://0.0.0.0:3020 ensures binding to all interfaces inside the container
CMD ["serve", "-s", ".", "-l", "tcp://0.0.0.0:3020"]
