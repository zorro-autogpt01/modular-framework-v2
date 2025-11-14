import React, { useState, useEffect, useRef } from 'react';
import { Copy, Check, MoreVertical, Pin, Star, GitBranch } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

const MessageBubble = ({ message, onCopy, onPin, onRate, onEdit, onBranch, metadata }) => {
  const [copied, setCopied] = useState(false);
  const [showActions, setShowActions] = useState(false);

  const handleCopy = () => {
    onCopy(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  return (
    <div 
      className={`group relative mb-4 ${isSystem ? 'opacity-60' : ''}`}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      <div className={`flex items-start gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
        {/* Avatar */}
        <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold
          ${isUser ? 'bg-blue-500 text-white' : 'bg-gray-700 text-gray-200'}`}>
          {isUser ? 'U' : 'AI'}
        </div>

        {/* Message Content */}
        <div className={`flex-1 max-w-3xl ${isUser ? 'text-right' : ''}`}>
          <div className={`inline-block px-4 py-3 rounded-2xl ${
            isUser 
              ? 'bg-blue-600 text-white' 
              : 'bg-gray-800 text-gray-100 border border-gray-700'
          }`}>
            {metadata?.is_pinned && (
              <div className="flex items-center gap-1 mb-2 text-xs text-yellow-400">
                <Pin size={12} />
                <span>Pinned</span>
              </div>
            )}
            
            <div className="prose prose-invert max-w-none">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  code({node, inline, className, children, ...props}) {
                    const match = /language-(\w+)/.exec(className || '');
                    return !inline && match ? (
                      <SyntaxHighlighter
                        style={vscDarkPlus}
                        language={match[1]}
                        PreTag="div"
                        {...props}
                      >
                        {String(children).replace(/\n$/, '')}
                      </SyntaxHighlighter>
                    ) : (
                      <code className={className} {...props}>
                        {children}
                      </code>
                    );
                  }
                }}
              >
                {message.content}
              </ReactMarkdown>
            </div>

            {/* Metadata badges */}
            <div className="flex items-center gap-2 mt-2 text-xs opacity-60">
              {message.tokens && (
                <span>{message.tokens} tokens</span>
              )}
              {message.cost && (
                <span>${message.cost.toFixed(4)}</span>
              )}
              {metadata?.rating && (
                <div className="flex items-center gap-0.5">
                  {[...Array(metadata.rating)].map((_, i) => (
                    <Star key={i} size={10} fill="currentColor" />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        {showActions && !isSystem && (
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={handleCopy}
              className="p-1.5 rounded hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
              title="Copy to clipboard"
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
            
            <button
              onClick={() => onPin(message.id)}
              className={`p-1.5 rounded hover:bg-gray-700 transition-colors ${
                metadata?.is_pinned ? 'text-yellow-400' : 'text-gray-400 hover:text-white'
              }`}
              title="Pin message"
            >
              <Pin size={16} />
            </button>

            <button
              onClick={() => onBranch(message.id)}
              className="p-1.5 rounded hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
              title="Branch from here"
            >
              <GitBranch size={16} />
            </button>

            <div className="relative">
              <button
                className="p-1.5 rounded hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
                title="More options"
              >
                <MoreVertical size={16} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export const ConversationView = ({ 
  conversationId, 
  branchId, 
  onSendMessage,
  onBranchCreate 
}) => {
  const [messages, setMessages] = useState([]);
  const [metadata, setMetadata] = useState({});
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    if (branchId) {
      loadMessages();
    }
  }, [branchId]);

  const loadMessages = async () => {
    try {
      const response = await fetch(`http://localhost:3020/api/branches/${branchId}/messages`);
      const data = await response.json();
      setMessages(data.messages);
      
      // Load metadata for each message
      const metaMap = {};
      for (const msg of data.messages) {
        if (msg.is_pinned !== null) {
          metaMap[msg.id] = {
            is_pinned: msg.is_pinned,
            priority_level: msg.priority_level,
            rating: msg.rating,
            in_context: msg.in_context
          };
        }
      }
      setMetadata(metaMap);
    } catch (error) {
      console.error('Failed to load messages:', error);
    }
  };

  const handleSend = async () => {
    if (!input.trim()) return;

    const userMessage = {
      role: 'user',
      content: input,
      conversation_id: conversationId,
      branch_id: branchId
    };

    // Add user message optimistically
    setMessages(prev => [...prev, { ...userMessage, id: Date.now() }]);
    setInput('');
    setIsLoading(true);

    try {
      await onSendMessage(input);
      // Reload messages to get assistant response
      await loadMessages();
    } catch (error) {
      console.error('Failed to send message:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopy = (text) => {
    navigator.clipboard.writeText(text);
  };

  const handlePin = async (messageId) => {
    try {
      const currentMeta = metadata[messageId] || {};
      const newPinState = !currentMeta.is_pinned;
      
      await fetch(`http://localhost:3020/api/messages/${messageId}/metadata`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_pinned: newPinState })
      });

      setMetadata(prev => ({
        ...prev,
        [messageId]: { ...prev[messageId], is_pinned: newPinState }
      }));
    } catch (error) {
      console.error('Failed to pin message:', error);
    }
  };

  const handleRate = async (messageId, rating) => {
    try {
      await fetch(`http://localhost:3020/api/messages/${messageId}/metadata`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating })
      });

      setMetadata(prev => ({
        ...prev,
        [messageId]: { ...prev[messageId], rating }
      }));
    } catch (error) {
      console.error('Failed to rate message:', error);
    }
  };

  const handleBranch = (messageId) => {
    onBranchCreate(messageId);
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="flex flex-col h-full bg-gray-900">
      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {messages.map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            metadata={metadata[message.id]}
            onCopy={handleCopy}
            onPin={handlePin}
            onRate={handleRate}
            onBranch={handleBranch}
          />
        ))}
        {isLoading && (
          <div className="flex items-center gap-2 text-gray-400">
            <div className="animate-spin w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full" />
            <span>Thinking...</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="border-t border-gray-800 p-4 bg-gray-900">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Type your message... (Shift+Enter for new line)"
            className="flex-1 bg-gray-800 text-white rounded-lg px-4 py-3 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 border border-gray-700"
            rows={3}
          />
          <button
            onClick={handleSend}
            disabled={isLoading || !input.trim()}
            className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConversationView;
