const btnInput = document.getElementById('btnInput');
const btnOutput = document.getElementById('btnOutput');
const inputPathDisplay = document.getElementById('inputPath');
const outputPathDisplay = document.getElementById('outputPath');
const btnConvert = document.getElementById('btnConvert');
const logDiv = document.getElementById('log');

const selFormat = document.getElementById('selFormat');
const rngQuality = document.getElementById('rngQuality');
const lblQuality = document.getElementById('lblQuality');
const chkDelete = document.getElementById('chkDelete');

const btnAddTask = document.getElementById('btnAddTask');
const taskList = document.getElementById('taskList');
const chkAutoStart = document.getElementById('chkAutoStart');
let inputFolder = null;
let outputFolder = null;

rngQuality.addEventListener('input', (e) => lblQuality.innerText = e.target.value);

function checkReady() {
    const ready = inputFolder && outputFolder;
    btnConvert.disabled = !ready;
    btnAddTask.disabled = !ready;
}

async function inicializarAjustes() {
    // 1. Consultamos si ya está registrado en el sistema operativo
    const isAutoStartEnabled = await window.api.getAutoStart();

    // 2. Si el sistema dice que FALSE, pero es la primera vez que se abre la app,
    // forzamos la activación para cumplir con tu regla de "por defecto true".
    if (!isAutoStartEnabled) {
        // Verificamos si existe una marca en el localStorage para saber si el usuario lo apagó en el pasado
        const deshabilitadoPorUsuario = localStorage.getItem('autoStartDesactivado') === 'true';

        if (!deshabilitadoPorUsuario) {
            // Es el primer arranque de la app: lo activamos en el sistema de fondo
            await window.api.toggleAutoStart(true);
            chkAutoStart.checked = true;
        } else {
            // El usuario explícitamente lo desmarcó en una sesión anterior
            chkAutoStart.checked = false;
        }
    } else {
        // Si ya estaba activo en el sistema, se mantiene marcado
        chkAutoStart.checked = true;
    }
}


function getOptions() {
    return {
        format: selFormat.value,
        quality: parseInt(rngQuality.value),
        deleteOriginal: chkDelete.checked
    };
}

async function handleFolderSelection(path, type) {
    if (await window.api.checkDirectory(path)) {
        if (type === 'input') { inputFolder = path; inputPathDisplay.innerText = path; }
        else { outputFolder = path; outputPathDisplay.innerText = path; }
        checkReady();
    } else {
        alert("Por favor, selecciona o arrastra una CARPETA, no un archivo.");
    }
}

function setupDragAndDrop(elementId, type) {
    const el = document.getElementById(elementId);
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('active'); });
    el.addEventListener('dragleave', (e) => { e.preventDefault(); el.classList.remove('active'); });
    el.addEventListener('drop', async (e) => {
        e.preventDefault();
        el.classList.remove('active');

        if (e.dataTransfer.files.length > 0) {
            const droppedFile = e.dataTransfer.files[0];

            const realPath = window.api.getPathForFile(droppedFile);

            if (!realPath) {
                alert("La seguridad del sistema ocultó la ruta. Usa el botón manual.");
                return;
            }

            handleFolderSelection(realPath, type);
        }
    });
}

setupDragAndDrop('dropInput', 'input');
setupDragAndDrop('dropOutput', 'output');


chkAutoStart.addEventListener('change', async (e) => {
    chkAutoStart.disabled = true;

    const estadoActivo = e.target.checked;
    await window.api.toggleAutoStart(estadoActivo);

    // Si el usuario lo desmarca, guardamos la persistencia local para que la app 
    // recuerde su decisión y no lo vuelva a activar a la fuerza la próxima vez.
    if (!estadoActivo) {
        localStorage.setItem('autoStartDesactivado', 'true');
    } else {
        localStorage.removeItem('autoStartDesactivado');
    }

    chkAutoStart.disabled = false;
});


btnInput.addEventListener('click', async () => {
    const path = await window.api.selectFolder();
    if (path) handleFolderSelection(path, 'input');
});
btnOutput.addEventListener('click', async () => {
    const path = await window.api.selectFolder();
    if (path) handleFolderSelection(path, 'output');
});

btnConvert.addEventListener('click', async () => {
    logDiv.innerHTML = ''; btnConvert.disabled = true;

    window.api.onProgress((data) => {
        const span = document.createElement('div');
        span.className = data.status; span.innerText = data.message;
        logDiv.appendChild(span);
        logDiv.scrollTop = logDiv.scrollHeight;
    });

    const result = await window.api.convertImages({ inputFolder, outputFolder, options: getOptions() });
    window.api.removeAllListeners();
    btnConvert.disabled = false;

    const final = document.createElement('div');
    final.innerHTML = result.success ? `<br><strong>¡Listo! ${result.total} imágenes.</strong>` : `<br><strong>Error: ${result.error}</strong>`;
    final.style.color = result.success ? '#4CAF50' : '#f44336';
    logDiv.appendChild(final);
});

async function renderTareas() {
    const tareas = await window.api.getTasks();
    taskList.innerHTML = '';

    if (tareas.length === 0) {
        taskList.innerHTML = '<div style="color: #666; text-align: center; margin-top: 20px;">No hay tareas activas.</div>';
        return;
    }

    tareas.forEach(tarea => {
        const options = tarea.options || {
            format: 'avif',
            quality: 65,
            deleteOriginal: false
        };

        const div = document.createElement('div');
        div.className = tarea.modo === 'tiempo_real' ? 'task-item task-realtime' : 'task-item';

        const modoTexto = tarea.modo === 'tiempo_real'
            ? '⚡ Vigilando en tiempo real'
            : `⏳ Cada ${tarea.intervaloDias} día(s)`;

        const borrarTexto = options.deleteOriginal ? '<span style="color: #f44336"> (Borrando original)</span>' : '';

        div.innerHTML = `
            <strong>${modoTexto}</strong><br>
            <span style="color: #ccc">De: ${tarea.input}</span><br>
            <span style="color: #ccc">A: ${tarea.output}</span><br>
            <span style="color: #888">Formato: ${options.format.toUpperCase()} al ${options.quality}% ${borrarTexto}</span><br>
            <button class="danger" onclick="eliminarTarea(${tarea.id})">Eliminar Tarea</button>
        `;
        taskList.appendChild(div);
    });
}

btnAddTask.addEventListener('click', async () => {
    const modo = document.querySelector('input[name="modo"]:checked').value;
    const dias = parseInt(document.getElementById('inputDias').value) || 1;

    await window.api.addTask({
        input: inputFolder,
        output: outputFolder,
        modo: modo,
        intervaloDias: dias,
    });
    renderTareas();
});

window.eliminarTarea = async (id) => {
    await window.api.deleteTask(id);
    renderTareas();
};

window.api.onTasksUpdated(() => renderTareas());
renderTareas();
inicializarAjustes();