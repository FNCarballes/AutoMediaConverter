import { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, Notification } from 'electron';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import sharp from 'sharp';
import chokidar from 'chokidar';
import { fileURLToPath } from 'url';
import os from 'os';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let tray = null;
let tasksFilePath;
let isQuitting = false;
const activeWatchers = {};


const linuxAutostartFile = path.join(app.getPath('appData'), 'autostart', 'auto-media-converter.desktop');

// 2. Función manual para manejar el autostart en Linux
async function manageLinuxAutoStart(enable) {
    if (enable) {
        const autostartDir = path.dirname(linuxAutostartFile);
        if (!existsSync(autostartDir)) {
            await fs.mkdir(autostartDir, { recursive: true });
        }

        const desktopContent = `[Desktop Entry]
Type=Application
Version=1.0
Name=Auto Media Converter
Comment=Second plane execution
Exec="${process.execPath}" --hidden
StartupNotify=false
Terminal=false`;

        await fs.writeFile(linuxAutostartFile, desktopContent.trim());
    } else {
        if (existsSync(linuxAutostartFile)) {
            await fs.unlink(linuxAutostartFile);
        }
    }
}


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

        if (options.deleteOriginal) {
            try {
                await fs.unlink(rutaEntrada);
            } catch (deleteErr) {
                console.error(`No se pudo eliminar el original ${archivo}:`, deleteErr);
            }
        }

        if (eventSender) {
            eventSender.send('conversion:progress', { status: 'success', message: `✓ ${archivo} -> ${nombrePuro}.${extension}` });
        }
        return true;
    } catch (err) {
        if (eventSender) eventSender.send('conversion:progress', { status: 'error', message: `✗ Error con ${archivo}: ${err.message}` });
        return false;
    }
}


async function procesarEntradas(rutas, outputFolder, options, eventSender = null) {
    if (!existsSync(outputFolder)) await fs.mkdir(outputFolder, { recursive: true });
    const extensionesPermitidas = ['.jpg', '.jpeg', '.png'];
    
    let listaFinalImagenes = [];
    let totalProcesadas = 0;

    // 1. Clasificar y aplanar todas las rutas recibidas
    for (const ruta of rutas) {
        try {
            const info = await fs.stat(ruta);
            
            if (info.isDirectory()) {
                // Si es una carpeta, leemos su interior y filtramos las imágenes
                const archivos = await fs.readdir(ruta);
                const imagenesDeCarpeta = archivos
                    .filter(a => extensionesPermitidas.includes(path.extname(a).toLowerCase()))
                    .map(a => path.join(ruta, a)); // Convertimos a ruta absoluta
                
                listaFinalImagenes.push(...imagenesDeCarpeta);
            } else if (info.isFile()) {
                // Si es un archivo suelto, verificamos su extensión directamente
                if (extensionesPermitidas.includes(path.extname(ruta).toLowerCase())) {
                    listaFinalImagenes.push(ruta);
                }
            }
        } catch (err) {
            console.error(`Error al analizar la ruta ${ruta}:`, err);
        }
    }

    if (listaFinalImagenes.length === 0) return { success: true, total: 0 };

    // 2. Procesar el lote final con la concurrencia inteligente de tu CPU
    const CONCURRENCIA_MAXIMA = os.cpus().length || 4;
    
    for (let i = 0; i < listaFinalImagenes.length; i += CONCURRENCIA_MAXIMA) {
        const lote = listaFinalImagenes.slice(i, i + CONCURRENCIA_MAXIMA);
        
        await Promise.all(lote.map(async (rutaImg) => {
            const exito = await procesarImagen(rutaImg, outputFolder, options, eventSender);
            if (exito) totalProcesadas++;
        }));
    }

    return { success: true, total: totalProcesadas };
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
            const result = await procesarEntradas(tarea.input, tarea.output, tarea.options);
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

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    // Si ya hay otra instancia corriendo, cerramos esta inmediatamente
    app.quit();
} else {
    // Si somos la instancia principal, escuchamos si alguien intenta abrir una segunda
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        // Alguien intentó abrir la app de nuevo. Restauramos y enfocamos nuestra ventana.
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });

app.whenReady().then(async () => {
    tasksFilePath = path.join(app.getPath('userData'), 'tareas.json');
    createWindow();
    createTray();

    const tareas = await obtenerTareas();
    actualizarWatchers(tareas); // Encendemos Chokidar silenciosamente

    setInterval(ejecutarTareasAutomaticas, 60 * 1000);
});}

ipcMain.handle('utils:checkDirectory', async (e, p) => { try { return (await fs.stat(p)).isDirectory(); } catch { return false; } });
ipcMain.handle('dialog:openMixed', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        // La magia está aquí: permitimos archivos, carpetas y selección múltiple
        properties: ['openFile', 'openDirectory', 'multiSelections'],
        filters: [
            { name: 'Imágenes Soportadas', extensions: ['jpg', 'jpeg', 'png'] }
        ]
    });
    // Ahora devolvemos un arreglo de rutas (pueden ser archivos sueltos o carpetas)
    return canceled ? null : filePaths; 
});
ipcMain.handle('image:convert', async (event, data) => await procesarEntradas(data.inputFolder, data.outputFolder, data.options, event.sender));
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
        return existsSync(linuxAutostartFile);
    }
    return app.getLoginItemSettings().openAtLogin;
});

ipcMain.handle('settings:toggleAutoStart', async (event, enable) => {
    try {
        if (process.platform === 'linux') {
            await manageLinuxAutoStart(enable);
        } else {
            // Lógica para Windows y macOS
            app.setLoginItemSettings({
                openAtLogin: enable,
                openAsHidden: enable,
                args: enable ? ['--hidden'] : []
            });
        }
        return true;
    } catch (error) {
        console.error("Error cambiando el inicio automático:", error);
        return false;
    }
});