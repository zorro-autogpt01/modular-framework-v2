/**
 * MODULE REGISTRY
 * 
 * Central registry for all application modules.
 * Each module is self-contained with its own:
 * - Database operations
 * - Business logic
 * - API endpoints (registered separately)
 * 
 * HOW TO ADD A NEW MODULE:
 * 1. Create your-module.js in this directory
 * 2. Export functions following the pattern below
 * 3. Add to modules object in this file
 * 4. Module is automatically available throughout the app
 * 
 * No changes to core code needed!
 */

const conversations = require('./conversations');
const branching = require('./branching');
const contextManager = require('./context-manager');
const promptAdvisor = require('./prompt-advisor');
const personalities = require('./personalities');
const structuredOutput = require('./structured-output');
const templates = require('./templates');
const smartActions = require('./smart-actions');
const workflows = require('./workflows');
const analytics = require('./analytics');

/**
 * Module Registry
 * Add your module here to make it available app-wide
 */
const modules = {
  conversations,
  branching,
  contextManager,
  promptAdvisor,
  personalities,
  structuredOutput,
  templates,
  smartActions,
  workflows,
  analytics
};

/**
 * Get a specific module
 * @param {string} moduleName - Name of the module
 * @returns {object} Module exports
 */
function getModule(moduleName) {
  if (!modules[moduleName]) {
    throw new Error(`Module '${moduleName}' not found in registry`);
  }
  return modules[moduleName];
}

/**
 * Get all available modules
 * @returns {object} All modules
 */
function getAllModules() {
  return modules;
}

/**
 * Get list of module names
 * @returns {string[]} Module names
 */
function getModuleNames() {
  return Object.keys(modules);
}

/**
 * Check if module exists
 * @param {string} moduleName - Name of the module
 * @returns {boolean}
 */
function hasModule(moduleName) {
  return moduleName in modules;
}

/**
 * Initialize all modules
 * Called on application startup
 */
async function initializeModules() {
  console.log('Initializing modules...');
  
  for (const [name, module] of Object.entries(modules)) {
    if (typeof module.initialize === 'function') {
      try {
        await module.initialize();
        console.log(`  ✅ ${name} initialized`);
      } catch (error) {
        console.error(`  ❌ ${name} initialization failed:`, error.message);
      }
    }
  }
  
  console.log('Modules initialized successfully');
}

/**
 * Get module metadata (for API docs, admin panel, etc.)
 */
function getModuleMetadata() {
  return Object.entries(modules).map(([name, module]) => ({
    name,
    version: module.version || '1.0.0',
    description: module.description || 'No description available',
    endpoints: module.endpoints || [],
    features: module.features || []
  }));
}

module.exports = {
  // Main exports
  ...modules,
  
  // Registry functions
  getModule,
  getAllModules,
  getModuleNames,
  hasModule,
  initializeModules,
  getModuleMetadata
};
