export const remoteTree = {
  'var': {
    type: 'folder',
    children: {
      'www': {
        type: 'folder',
        children: {
          'html': {
            type: 'folder',
            children: {
              'index.php': {
                type: 'file',
                content: "<?php\necho 'Hello from remote server!';\nphpinfo();\n?>"
              },
              'config.php': {
                type: 'file',
                content: "<?php\ndefine('DB_HOST','localhost');\ndefine('DB_NAME','production_db');\n?>"
              }
            }
          }
        }
      }
    }
  },
  'home': {
    type: 'folder',
    children: {
      'developer': {
        type: 'folder',
        children: {
          'projects': {
            type: 'folder',
            children: {
              'my-app': {
                type: 'folder',
                children: {
                  'app.js': {
                    type: 'file',
                    content:
                      "const express = require('express');\n" +
                      "const app = express();\n" +
                      "app.get('/', (req, res) => {\n" +
                      "  res.send('Hello from remote server!');\n" +
                      "});\n" +
                      "app.listen(3000);"
                  }
                }
              }
            }
          }
        }
      }
    }
  }
};

export const remoteTree = {
  'var': {
    type: 'folder',
    children: {
      'www': {
        type: 'folder',
        children: {
          'html': {
            type: 'folder',
            children: {
              'index.php': {
                type: 'file',
                content: "<?php\necho 'Hello from remote server!';\nphpinfo();\n?>"
              },
              'config.php': {
                type: 'file',
                content: "<?php\ndefine('DB_HOST','localhost');\ndefine('DB_NAME','production_db');\n?>"
              }
            }
          }
        }
      }
    }
  },
  'home': {
    type: 'folder',
    children: {
      'developer': {
        type: 'folder',
        children: {
          'projects': {
            type: 'folder',
            children: {
              'my-app': {
                type: 'folder',
                children: {
                  'app.js': {
                    type: 'file',
                    content:
                      "const express = require('express');\n" +
                      "const app = express();\n" +
                      "app.get('/', (req, res) => {\n" +
                      "  res.send('Hello from remote server!');\n" +
                      "});\n" +
                      "app.listen(3000);"
                  }
                }
              }
            }
          }
        }
      }
    }
  }
};
