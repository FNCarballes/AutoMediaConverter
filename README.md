 Auto Media Converter (AVIF/WebP Converter)
Una aplicación de escritorio moderna y de alto rendimiento construida con Electron.js y Node.js. Permite la conversión masiva de imágenes (JPG/PNG) a formatos de nueva generación (AVIF/WebP) mediante procesamiento manual, automatización programada o vigilancia de carpetas en tiempo real.

-   Características Principales
Conversión Ultrarrápida: Utiliza la librería sharp (basada en C/C++) para procesar múltiples imágenes en paralelo sin bloquear la interfaz.
Carpetas Vigiladas (Tiempo Real): Mediante chokidar, la aplicación vigila carpetas de origen. Si se detecta una nueva imagen descargada, se convierte automáticamente en milisegundos.
Automatización en Segundo Plano: Las tareas programadas (ej. "Ejecutar cada 1 día") se ejecutan silenciosamente desde la Bandeja del Sistema (System Tray), sin interrumpir al usuario.
Seguridad Moderna (Context Isolation): Sigue los estándares estrictos de Electron, separando por completo el entorno web del entorno de Node.js mediante un puente seguro (preload).
Drag & Drop Seguro: Permite arrastrar y soltar carpetas directamente a la interfaz, utilizando webUtils para saltar las restricciones de seguridad modernas de Chromium de forma nativa.
Notificaciones Nativas: Integración con el sistema operativo para avisar cuando las conversiones automáticas finalizan.

-   Arquitectura del Proyecto
Electron divide la aplicación en dos "mundos" que no se pueden tocar directamente por razones de seguridad.

1. El Backend: main.js (Proceso Principal)
Este es el "cerebro". Se ejecuta directamente sobre Node.js y tiene acceso completo a tu computadora (archivos, notificaciones, iconos del sistema).

Gestión de Ventanas: Inicia la app de forma oculta (show: false) para que viva en el Tray (junto al reloj).
Módulo fs (File System): Usamos fs/promises para tareas asíncronas (readdir, mkdir) y no congelar la app. Usamos la versión síncrona existsSync solo para comprobaciones rápidas.
Módulo sharp: Ejecuta la conversión de imágenes. Se usa Promise.all para enviar todas las imágenes a la GPU/CPU al mismo tiempo, en lugar de procesarlas una por una.
Módulo chokidar: Mantiene procesos abiertos escuchando eventos del sistema de archivos (add) para reaccionar a nuevos archivos.

2. El Puente de Seguridad: preload.cjs (Context Bridge)
Es la "frontera". Como el Frontend es solo una página web, si un hacker inyecta código malicioso, podría borrar tu disco duro. El Preload evita esto.

Por qué .cjs: Aunque todo el proyecto usa Módulos ES modernos ("type": "module"), Electron requiere que el Preload use el sistema tradicional CommonJS (require).
contextBridge.exposeInMainWorld: Crea un objeto window.api que el Frontend puede usar. El Frontend pide cosas, el Preload las traduce y se las manda al Backend usando IPC (Inter-Process Communication).

3. El Frontend: index.html y renderer.js (Proceso de Renderizado)
Es la "cara". De esta manera. no sabe que Node.js existe. Solo manipula el DOM (HTML/CSS) y manda mensajes a través del puente.
Gestiona los clics, los sliders de opciones y el Drag & Drop.
Recibe eventos en tiempo real desde el Backend (como el progreso de la barra de carga) mediante ipcRenderer.on().

- Flujos Principales de Datos
*   Flujo A: Creación y Persistencia de Tareas
El usuario hace clic en "Crear Tarea" en el Frontend.
renderer.js llama a window.api.addTask(datos).
preload.cjs intercepta la llamada y grita: ipcRenderer.invoke('tasks:add').
main.js escucha ese grito, toma la nueva tarea, lee un archivo llamado tareas.json ubicado en app.getPath('userData') (una carpeta segura en AppData o ~/.config que sobrevive a las actualizaciones de la app), añade la tarea y vuelve a guardar el JSON.
*   Flujo B: Arrastrar y Soltar (Drag & Drop)
El usuario arrastra una carpeta al cuadro gris. HTML5 captura el objeto File.
Por seguridad de Electron v31+, la ruta original de la carpeta viene censurada.
Se invoca window.api.getPathForFile(file) que usa webUtils (herramienta nativa de Electron) para desencriptar la ruta real (/home/usuario/Descargas).
Se envía la ruta limpia al backend.
*   Flujo C: Watchers (Tiempo Real)
Cuando la app arranca, lee tareas.json.
Filtra las tareas que tienen modo: 'tiempo_real'.
Por cada una, enciende un chokidar.watch(ruta).
Cuando el sistema operativo detecta un archivo nuevo en esa ruta, chokidar dispara el evento add.
Se invoca silenciosamente a sharp, se convierte la imagen, se borra la original (si está configurado) y se lanza una Notification nativa. Todo esto sin que la ventana de la app se dibuje en pantalla.

-   Tecnologías y Dependencias
*   Electron: Framework principal (app, BrowserWindow, ipcMain, Tray, Notification).
*   Node.js Nativo: path (rutas), fs (archivos), url (importaciones de módulos).
*   Sharp (npm install sharp): El motor de conversión. Extremadamente rápido y eficiente en memoria RAM.
*   Chokidar (npm install chokidar): Envoltura sobre fs.watch de Node.js, soluciona problemas nativos de eventos duplicados al vigilar archivos.
