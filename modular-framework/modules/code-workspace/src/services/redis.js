const redis = require('redis');

class RedisService {
  constructor() {
    this.client = null;
    this.publisher = null;
    this.subscriber = null;
    this.isConnected = false;
  }

  async connect() {
    try {
      // Main client for general operations
      this.client = redis.createClient({
        url: process.env.REDIS_URL || 'redis://redis:6379',
        socket: {
          reconnectStrategy: (retries) => Math.min(retries * 100, 3000)
        }
      });

      // Publisher client for pub/sub
      this.publisher = this.client.duplicate();
      
      // Subscriber client for pub/sub
      this.subscriber = this.client.duplicate();

      // Connect all clients
      await this.client.connect();
      await this.publisher.connect();
      await this.subscriber.connect();

      // Set up error handlers
      this.client.on('error', (err) => console.error('Redis Client Error:', err));
      this.publisher.on('error', (err) => console.error('Redis Publisher Error:', err));
      this.subscriber.on('error', (err) => console.error('Redis Subscriber Error:', err));

      this.isConnected = true;
      console.log('✅ Redis connected successfully');
    } catch (error) {
      console.error('❌ Redis connection failed:', error);
      throw error;
    }
  }

  async disconnect() {
    try {
      if (this.client) await this.client.quit();
      if (this.publisher) await this.publisher.quit();
      if (this.subscriber) await this.subscriber.quit();
      this.isConnected = false;
      console.log('Redis disconnected');
    } catch (error) {
      console.error('Error disconnecting Redis:', error);
    }
  }

  // Key-Value Operations
  async get(key) {
    if (!this.isConnected) throw new Error('Redis not connected');
    return await this.client.get(key);
  }

  async set(key, value, ttl = null) {
    if (!this.isConnected) throw new Error('Redis not connected');
    if (ttl) {
      return await this.client.setEx(key, ttl, value);
    }
    return await this.client.set(key, value);
  }

  async setex(key, ttl, value) {
    if (!this.isConnected) throw new Error('Redis not connected');
    return await this.client.setEx(key, ttl, value);
  }

  async del(key) {
    if (!this.isConnected) throw new Error('Redis not connected');
    return await this.client.del(key);
  }

  async exists(key) {
    if (!this.isConnected) throw new Error('Redis not connected');
    return await this.client.exists(key);
  }

  async expire(key, seconds) {
    if (!this.isConnected) throw new Error('Redis not connected');
    return await this.client.expire(key, seconds);
  }

  async ttl(key) {
    if (!this.isConnected) throw new Error('Redis not connected');
    return await this.client.ttl(key);
  }

  async keys(pattern) {
    if (!this.isConnected) throw new Error('Redis not connected');
    return await this.client.keys(pattern);
  }

  // Hash Operations
  async hget(key, field) {
    if (!this.isConnected) throw new Error('Redis not connected');
    return await this.client.hGet(key, field);
  }

  async hset(key, field, value) {
    if (!this.isConnected) throw new Error('Redis not connected');
    return await this.client.hSet(key, field, value);
  }

  async hgetall(key) {
    if (!this.isConnected) throw new Error('Redis not connected');
    return await this.client.hGetAll(key);
  }

  async hdel(key, field) {
    if (!this.isConnected) throw new Error('Redis not connected');
    return await this.client.hDel(key, field);
  }

  // List Operations
  async lpush(key, value) {
    if (!this.isConnected) throw new Error('Redis not connected');
    return await this.client.lPush(key, value);
  }

  async rpush(key, value) {
    if (!this.isConnected) throw new Error('Redis not connected');
    return await this.client.rPush(key, value);
  }

  async lrange(key, start, stop) {
    if (!this.isConnected) throw new Error('Redis not connected');
    return await this.client.lRange(key, start, stop);
  }

  async llen(key) {
    if (!this.isConnected) throw new Error('Redis not connected');
    return await this.client.lLen(key);
  }

  // Set Operations
  async sadd(key, member) {
    if (!this.isConnected) throw new Error('Redis not connected');
    return await this.client.sAdd(key, member);
  }

  async srem(key, member) {
    if (!this.isConnected) throw new Error('Redis not connected');
    return await this.client.sRem(key, member);
  }

  async smembers(key) {
    if (!this.isConnected) throw new Error('Redis not connected');
    return await this.client.sMembers(key);
  }

  async sismember(key, member) {
    if (!this.isConnected) throw new Error('Redis not connected');
    return await this.client.sIsMember(key, member);
  }

  // Pub/Sub Operations
  async publish(channel, message) {
    if (!this.isConnected) throw new Error('Redis not connected');
    return await this.publisher.publish(channel, message);
  }

  async subscribe(channel, callback) {
    if (!this.isConnected) throw new Error('Redis not connected');
    await this.subscriber.subscribe(channel, (message) => {
      callback(message);
    });
  }

  async unsubscribe(channel) {
    if (!this.isConnected) throw new Error('Redis not connected');
    return await this.subscriber.unsubscribe(channel);
  }

  // Atomic Operations
  async incr(key) {
    if (!this.isConnected) throw new Error('Redis not connected');
    return await this.client.incr(key);
  }

  async decr(key) {
    if (!this.isConnected) throw new Error('Redis not connected');
    return await this.client.decr(key);
  }

  async incrby(key, increment) {
    if (!this.isConnected) throw new Error('Redis not connected');
    return await this.client.incrBy(key, increment);
  }

  // Transactions
  async multi() {
    if (!this.isConnected) throw new Error('Redis not connected');
    return this.client.multi();
  }

  // Cache helpers
  async getOrSet(key, fetchFn, ttl = 3600) {
    let value = await this.get(key);
    if (value) {
      return JSON.parse(value);
    }

    value = await fetchFn();
    await this.setex(key, ttl, JSON.stringify(value));
    return value;
  }

  async invalidatePattern(pattern) {
    const keys = await this.keys(pattern);
    if (keys.length > 0) {
      await Promise.all(keys.map(key => this.del(key)));
    }
    return keys.length;
  }
}

module.exports = new RedisService();
