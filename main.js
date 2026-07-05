import { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, Notification } from 'electron';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import sharp from 'sharp';
import chokidar from 'chokidar';
import { fileURLToPath } from 'url';
import AutoLaunch from 'auto-launch';

// 1. Configurar auto-launch
const appAutoLauncher = new AutoLaunch({
    name: 'Auto Media Converter',
    // Envolvemos la ruta en comillas literales para que Linux la lea entera
    path: `"${process.execPath}"`, 
    isHidden: true 
});


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let tray = null;
let tasksFilePath;
let isQuitting = false;
const activeWatchers = {};

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1050, height: 750, show: false, // Inicia oculta por defecto
        icon: path.join(__dirname, 'assets', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true, nodeIntegration: false,
        }
    });
    
    mainWindow.loadFile('index.html');
    
    mainWindow.once('ready-to-show', () => {
        // Detectar si el SO la abrió de forma automática
        const esInicioAutomatico = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAsHidden;
        
        if (!esInicioAutomatico) {
            // El usuario hizo doble clic en el ícono, mostramos la ventana
            mainWindow.show();
        } else {
            // Arrancó con el sistema. Dejamos la ventana oculta pero avisamos.
            mostrarNotificacion('Media Converter', 'Iniciado en segundo plano. Vigilando carpetas...');
        }
    });

    mainWindow.on('close', (event) => {
        if (!isQuitting) { event.preventDefault(); mainWindow.hide(); }
    });
}

function createTray() {
    const iconPath = path.join(__dirname, 'assets', 'icon.png');
    const icon = nativeImage.createFromPath(iconPath);
    tray = new Tray(icon.resize({ width: 16, height: 16 }));
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Abrir Media converter', click: () => mainWindow.show() },
        { type: 'separator' },
        { label: 'Salir', click: () => { isQuitting = true; app.quit(); } }
    ]);
    tray.setToolTip('Media converter - En segundo plano');
    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => { if (mainWindow) mainWindow.show(); });
}

function mostrarNotificacion(titulo, cuerpo) {
    if (Notification.isSupported()) {
        new Notification({ title: titulo, body: cuerpo }).show();
    }
}

async function procesarImagen(rutaEntrada, outputFolder, options, eventSender = null) {
    if (!options) options = { format: 'avif', quality: 65, deleteOriginal: false };

    const archivo = path.basename(rutaEntrada);
    const nombrePuro = path.parse(archivo).name;
    const extension = options.format || 'avif';
    const rutaSalida = path.join(outputFolder, `${nombrePuro}.${extension}`);

    try {
        let procesador = sharp(rutaEntrada);
        if (extension === 'webp') procesador = procesador.webp({ quality: options.quality });
        else procesador = procesador.avif({ quality: options.quality, effort: 5 });

        await procesador.toFile(rutaSalida);


        if (eventSender) {
            eventSender.send('conversion:progress', { status: 'success', message: `✓ ${archivo} -> ${nombrePuro}.${extension}` });
        }
        return true;
    } catch (err) {
        if (eventSender) eventSender.send('conversion:progress', { status: 'error', message: `✗ Error con ${archivo}: ${err.message}` });
        return false;
    }
}

async function procesarCarpetas(inputFolder, outputFolder, options, eventSender = null) {
    if (!existsSync(outputFolder)) await fs.mkdir(outputFolder, { recursive: true });
    const extensionesPermitidas = ['.jpg', '.jpeg', '.png'];
    const archivos = await fs.readdir(inputFolder);
    const imagenes = archivos.filter(a => extensionesPermitidas.includes(path.extname(a).toLowerCase()));

    if (imagenes.length === 0) return { success: true, total: 0 };

    let procesadas = 0;
    await Promise.all(imagenes.map(async (archivo) => {
        const exito = await procesarImagen(path.join(inputFolder, archivo), outputFolder, options, eventSender);
        if (exito) procesadas++;
    }));
    return { success: true, total: procesadas };
}

async function obtenerTareas() {
    try { return existsSync(tasksFilePath) ? JSON.parse(await fs.readFile(tasksFilePath, 'utf-8')) : []; }
    catch (e) { return []; }
}
async function guardarTareas(tareas) { await fs.writeFile(tasksFilePath, JSON.stringify(tareas, null, 2)); }

function actualizarWatchers(tareas) {
    // Cerramos los vigilantes anteriores para no duplicar
    Object.values(activeWatchers).forEach(watcher => watcher.close());

    const tareasVigiladas = tareas.filter(t => t.modo === 'tiempo_real');

    tareasVigiladas.forEach(tarea => {
        // Quitamos awaitWriteFinish. En Linux a veces causa bloqueos con archivos pequeños
        const watcher = chokidar.watch(tarea.input, {
            ignored: /(^|[\/\\])\../,
            persistent: true,
            depth: 0,
            ignoreInitial: true
        });

        watcher.on('add', async (filePath) => {
            console.log(`[Chokidar] Nuevo archivo detectado: ${filePath}`); // Para debug en terminal

            const ext = path.extname(filePath).toLowerCase();
            if (['.jpg', '.jpeg', '.png'].includes(ext)) {
                try {
                    if (!existsSync(tarea.output)) await fs.mkdir(tarea.output, { recursive: true });

                    const exito = await procesarImagen(filePath, tarea.output, tarea.options);

                    if (exito) {
                        mostrarNotificacion('¡Imagen Procesada!', `Se convirtió: ${path.basename(filePath)}`);
                    } else {
                        mostrarNotificacion('Error Silencioso', `Falló al convertir: ${path.basename(filePath)}`);
                    }
                } catch (error) {
                    console.error("Error crítico en Chokidar:", error);
                    mostrarNotificacion('Error Crítico', error.message);
                }
            }
        });

        activeWatchers[tarea.id] = watcher;
    });
}

async function ejecutarTareasAutomaticas() {
    const tareas = await obtenerTareas();
    const ahora = Date.now();
    let tareasActualizadas = false;

    for (let tarea of tareas.filter(t => t.modo === 'intervalo')) {
        const msIntervalo = tarea.intervaloDias * 24 * 60 * 60 * 1000;
        if (!tarea.ultimoRun || (ahora - tarea.ultimoRun) >= msIntervalo) {
            const result = await procesarCarpetas(tarea.input, tarea.output, tarea.options);
            if (result.total > 0) mostrarNotificacion('Automatización Completada', `Se procesaron ${result.total} imágenes.`);
            tarea.ultimoRun = ahora;
            tareasActualizadas = true;
        }
    }
    if (tareasActualizadas) {
        await guardarTareas(tareas);
        if (mainWindow) mainWindow.webContents.send('tasks:updated');
    }
}

app.whenReady().then(async () => {
    tasksFilePath = path.join(app.getPath('userData'), 'tareas.json');
    createWindow(); 
    createTray();

    const tareas = await obtenerTareas();
    actualizarWatchers(tareas); // Encendemos Chokidar silenciosamente
    
    setInterval(ejecutarTareasAutomaticas, 60 * 1000);
});

ipcMain.handle('utils:checkDirectory', async (e, p) => { try { return (await fs.stat(p)).isDirectory(); } catch { return false; } });
ipcMain.handle('dialog:openDirectory', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    return canceled ? null : filePaths[0];
});
ipcMain.handle('image:convert', async (event, data) => await procesarCarpetas(data.inputFolder, data.outputFolder, data.options, event.sender));
ipcMain.handle('tasks:get', async () => await obtenerTareas());
ipcMain.handle('tasks:add', async (event, tarea) => {
    const tareas = await obtenerTareas();
    tareas.push({ ...tarea, id: Date.now(), ultimoRun: null });
    await guardarTareas(tareas);
    actualizarWatchers(tareas);
    ejecutarTareasAutomaticas();
    return tareas;
});
ipcMain.handle('tasks:delete', async (event, id) => {
    let tareas = await obtenerTareas();
    tareas = tareas.filter(t => t.id !== id);
    await guardarTareas(tareas);
    actualizarWatchers(tareas);
    return tareas;
});
// 2. Crear los manejadores IPC para el Frontend
// Obtener el estado actual al abrir la app
ipcMain.handle('settings:getAutoStart', async () => {
    if (process.platform === 'linux') {
        return await appAutoLauncher.isEnabled();
    }
    // Para Windows y macOS usamos el nativo de Electron
    return app.getLoginItemSettings().openAtLogin;
});

// Cambiar el estado según el checkbox del usuario
ipcMain.handle('settings:toggleAutoStart', async (event, enable) => {
    try {
        if (enable) {
            // Activar en Win/Mac
            app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true, args: ['--hidden'] });
            // Activar en Linux
            if (process.platform === 'linux') await appAutoLauncher.enable();
        } else {
            // Desactivar en Win/Mac
            app.setLoginItemSettings({ openAtLogin: false });
            // Desactivar en Linux
            if (process.platform === 'linux') await appAutoLauncher.disable();
        }
        return true;
    } catch (error) {
        console.error("Error cambiando el inicio automático:", error);
        return false;
    }
});