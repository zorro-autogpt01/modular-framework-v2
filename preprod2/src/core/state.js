export const state = {
  editor: null,
  diffEditor: null,
  openFiles: new Map(),
  activeFile: null,
  isConnected: false,
  currentWorkspace: 'local',
  git: { branch: 'main', url: 'https://github.com/user/repo.git' },
  fileTree: {}
};
