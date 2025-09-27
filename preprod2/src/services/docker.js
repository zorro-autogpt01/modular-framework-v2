import { addToDockerLogs } from '../terminal/index.js';
import { bus } from '../core/eventBus.js';

export function build(){ bus.emit('panel:show', { name: 'docker' }); addToDockerLogs('🐳 Building Docker image...'); }
export function run(){ bus.emit('panel:show', { name: 'docker' }); addToDockerLogs('🐳 Starting containers...'); }
export function ps(){ addToDockerLogs('📋 Listing containers...'); }
export function stopAll(){ addToDockerLogs('🛑 Stopping containers...'); }
