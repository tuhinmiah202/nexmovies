# Use Node.js 18 LTS as base image
FROM node:18-slim

# Install ffmpeg and other dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files first (for better layer caching)
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy rest of the application
COPY . .

# Set environment variables
ENV PORT=8080
ENV NODE_ENV=production

# Expose port 8080
EXPOSE 8080

# Start the application
CMD ["node", "server.js"]
