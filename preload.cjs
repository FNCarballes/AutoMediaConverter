const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
    getPathForFile: (file) => {
        if (webUtils && webUtils.getPathForFile) return webUtils.getPathForFile(file);
        return file.path; // Respaldo para versiones antiguas de Electron
    },

    selectFolder: () => ipcRenderer.invoke('dialog:openDirectory'),
    checkDirectory: (path) => ipcRenderer.invoke('utils:checkDirectory', path),
    convertImages: (data) => ipcRenderer.invoke('image:convert', data),

    getTasks: () => ipcRenderer.invoke('tasks:get'),
    addTask: (tarea) => ipcRenderer.invoke('tasks:add', tarea),
    deleteTask: (id) => ipcRenderer.invoke('tasks:delete', id),

    onProgress: (callback) => {
        ipcRenderer.on('conversion:progress', (event, data) => callback(data));
    },
    removeAllListeners: () => ipcRenderer.removeAllListeners('conversion:progress'),
    onTasksUpdated: (callback) => ipcRenderer.on('tasks:updated', () => callback()),
    getAutoStart: () => ipcRenderer.invoke('settings:getAutoStart'),
    toggleAutoStart: (enable) => ipcRenderer.invoke('settings:toggleAutoStart', enable),
});