const socket = io({ autoConnect: false });

let sistemaActivo = false;
let modoActual = 'automatico';
let accionPendiente = '';
let accionAnteriorPendiente = '';
let ultimaTransicionFeedback = '';
let pausarActualizaciones = false; // Detiene la actualización visual si el pop-up está abierto
let temperaturaActualRutina = null;
let rutinasCargadas = false;
let revisionRutinasSocket = 0;
let fechasHistorico = [];
let fechaSeleccionada = fechaLocal(new Date());
let historicoDatos = [];
const claveTema = 'eunice-tema';

// Referencias del DOM
const animInicio = document.getElementById('animacion-principal');
const animHero = document.getElementById('animacion-hero');
const estadoTextoInicio = document.getElementById('estado-texto-inicio');
const estadoTextoHero = document.getElementById('estado-texto-hero');
const btnPower = document.getElementById('btn-power');
const btnPowerHero = document.getElementById('btn-power-hero');
const interruptorLampara = document.getElementById('interruptor-lampara');
const btnEntrar = document.getElementById('btn-entrar');
const modalFeedback = document.getElementById('modal-feedback');
const btnAceptarFeedback = document.getElementById('btn-aceptar-feedback');

const ctx = document.getElementById('graficaTemp').getContext('2d');
const chartTemp = new Chart(ctx, {
    type: 'line',
    data: {
        labels: [],
        datasets: [
            {
                label: 'Temperatura (°C)',
                borderColor: '#E07A5F',
                backgroundColor: 'rgba(224, 122, 95, 0.15)',
                data: [],
                fill: true,
                tension: 0.35
            },
            {
                label: 'Humedad (%)',
                borderColor: '#81B29A',
                backgroundColor: 'rgba(129, 178, 154, 0.1)',
                data: [],
                fill: true,
                tension: 0.35
            }
        ]
    },
    options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 400 },
        scales: {
            y: { beginAtZero: false }
        }
    }
});

function fechaLocal(fecha) {
    const year = fecha.getFullYear();
    const month = String(fecha.getMonth() + 1).padStart(2, '0');
    const day = String(fecha.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function mostrarFecha(fecha) {
    const [year, month, day] = fecha.split('-');
    return `${day}/${month}/${year}`;
}

function escaparHtml(valor) {
    return String(valor ?? '').replace(/[&<>"']/g, caracter => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[caracter]);
}

// 1. Escuchar datos en tiempo real desde el servidor
socket.on('datos_actualizados', (datos) => {
    const estabaEncendido = sistemaActivo;
    sistemaActivo = datos.sistema_encendido;
    actualizarUI(datos);
    if (Number.isFinite(datos.temperatura) && datos.temperatura >= 5 && datos.temperatura <= 40) {
        temperaturaActualRutina = datos.temperatura;
        actualizarRutinas();
    }

    evaluarNecesidadFeedback(datos, sistemaActivo && !estabaEncendido);
});

socket.on('historico_actualizado', ({ fecha, registros }) => {
    if (fecha !== fechaSeleccionada) return;
    const registrosAnteriores = historicoDatos;
    historicoDatos = registros;
    window.historicoDatos = registros;
    document.getElementById('marca-datos-simulados').hidden =
        !registros.length || !registros.every(registro => registro.simulado === true);
    if (!actualizarGraficaEnVivo(registrosAnteriores, registros)) {
        actualizarHistorico();
    } else {
        actualizarTablaHistorico();
    }
});

socket.on('dias_disponibles', (fechas) => {
    fechasHistorico = fechas;
    actualizarControlesDia();
});

socket.on('configuracion_actualizada', (configuracion) => {
    modoActual = configuracion.modo;
    document.getElementById('select-modo').value = configuracion.modo;
    document.getElementById('col-frio').value = configuracion.colores.frio;
    document.getElementById('col-neutro').value = configuracion.colores.neutro;
    document.getElementById('col-calor').value = configuracion.colores.calor;
    ultimaTransicionFeedback = '';
});

socket.on('rutinas_actualizadas', rutinasServidor => {
    if (!Array.isArray(rutinasServidor) || !rutinasServidor.every(rutinaValida)) {
        console.error('El servidor envió una lista de rutinas no válida.');
        mostrarMensajeRutina('No se pudo actualizar la lista de rutinas recibida del servidor.', true);
        return;
    }
    revisionRutinasSocket += 1;
    rutinas = rutinasServidor.map(normalizarRutina);
    rutinasCargadas = true;
    actualizarRutinas();
});

socket.on('error_persistencia', mensaje => alert(mensaje));
socket.on('error_comando', mensaje => {
    interruptorLampara.checked = sistemaActivo;
    alert(mensaje);
});
socket.on('connect_error', error => {
    console.error('No se pudo abrir la conexión en tiempo real:', error.message);
});

interruptorLampara.addEventListener('change', () => {
    cambiarEstadoSistema(interruptorLampara.checked);
});

function actualizarControlTema() {
    const temaOscuro = document.documentElement.dataset.theme === 'dark';
    const controlTema = document.getElementById('theme-switch-checkbox');
    controlTema.checked = temaOscuro;
    controlTema.setAttribute(
        'aria-label',
        temaOscuro ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'
    );
    document.querySelector('meta[name="theme-color"]').content = temaOscuro ? '#151b19' : '#f3f5f0';
    chartTemp.options.color = temaOscuro ? '#a2b0a8' : '#77827c';
    if (chartTemp.options.scales?.y) {
        chartTemp.options.scales.y.grid = {
            color: temaOscuro ? 'rgba(162, 176, 168, 0.12)' : 'rgba(119, 130, 124, 0.12)'
        };
        chartTemp.options.scales.y.ticks = { color: temaOscuro ? '#a2b0a8' : '#77827c' };
    }
    chartTemp.update();
}

function alternarTema() {
    const temaNuevo = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = temaNuevo;
    localStorage.setItem(claveTema, temaNuevo);
    actualizarControlTema();
}

actualizarControlTema();

function evaluarNecesidadFeedback(datos, omitirSolicitud = false) {
    if (pausarActualizaciones) return;

    let accionNecesaria = '';
    if (modoActual === 'feedback' && datos.sistema_encendido) {
        if (datos.temperatura < 25) {
            accionNecesaria = 'calefaccion';
        } else if (datos.temperatura > 28) {
            accionNecesaria = 'aire_acondicionado';
        } else {
            accionNecesaria = 'apagado';
        }
    }

    const accionActual = datos.ventilador || 'apagado';
    const necesitaCambio = accionNecesaria && accionNecesaria !== accionActual;
    const transicion = necesitaCambio ? `${accionActual}->${accionNecesaria}` : '';

    if (transicion !== ultimaTransicionFeedback) {
        ultimaTransicionFeedback = transicion;
        if (necesitaCambio && !omitirSolicitud) {
            solicitarFeedback(accionNecesaria, datos.temperatura, accionActual);
        }
    }
}

function actualizarHistorico() {
    const tipo = document.getElementById('tipo-grafico').value;
    const nombreGrafica = {
        line: 'Líneas',
        bar: 'Barras',
        doughnut: 'Circular'
    }[tipo];
    const botonExportar = document.getElementById('btn-exportar-excel');
    botonExportar.innerText = `Exportar Excel · ${nombreGrafica}`;
    botonExportar.disabled = historicoDatos.length === 0;
    if (tipo === 'doughnut') {
        const rangos = [
            historicoDatos.filter(dato => dato.temperatura < 25).length,
            historicoDatos.filter(dato => dato.temperatura >= 25 && dato.temperatura <= 28).length,
            historicoDatos.filter(dato => dato.temperatura > 28).length
        ];
        chartTemp.config.type = 'doughnut';
        chartTemp.data.labels = ['Frío (<25 °C)', 'Ideal (25-28 °C)', 'Calor (>28 °C)'];
        chartTemp.data.datasets = [{
            label: 'Lecturas',
            data: rangos,
            backgroundColor: ['#4A90E2', '#52B788', '#E07A5F']
        }];
        chartTemp.options.scales = {};
    } else {
        chartTemp.config.type = tipo;
        chartTemp.data.labels = historicoDatos.map(dato => dato.hora);
        chartTemp.data.datasets = [
            {
                label: 'Temperatura (°C)',
                borderColor: '#E07A5F',
                backgroundColor: tipo === 'bar' ? '#E07A5F' : 'rgba(224, 122, 95, 0.15)',
                data: historicoDatos.map(dato => dato.temperatura),
                fill: tipo === 'line',
                tension: 0.35
            },
            {
                label: 'Humedad (%)',
                borderColor: '#81B29A',
                backgroundColor: tipo === 'bar' ? '#81B29A' : 'rgba(129, 178, 154, 0.1)',
                data: historicoDatos.map(dato => dato.humedad),
                fill: tipo === 'line',
                tension: 0.35
            }
        ];
        chartTemp.options.scales = { y: { beginAtZero: false } };
    }
    chartTemp.update();

    actualizarTablaHistorico();
}

function actualizarGraficaEnVivo(registrosAnteriores, registros) {
    const hoy = fechaLocal(new Date());
    const esNuevaLectura = registros.length === registrosAnteriores.length + 1
        && registrosAnteriores.every((registro, indice) =>
            registro.timestamp === registros[indice]?.timestamp
        );
    if (
        fechaSeleccionada !== hoy
        || document.getElementById('tipo-grafico').value !== 'line'
        || chartTemp.config.type !== 'line'
        || !esNuevaLectura
        || chartTemp.data.labels.length !== registrosAnteriores.length
    ) {
        return false;
    }

    const ultimoRegistro = registros[registros.length - 1];
    chartTemp.data.labels.push(ultimoRegistro.hora);
    chartTemp.data.datasets[0].data.push(ultimoRegistro.temperatura);
    chartTemp.data.datasets[1].data.push(ultimoRegistro.humedad);
    chartTemp.update('none');
    return true;
}

function actualizarTablaHistorico() {
    const tbody = document.getElementById('tabla-historico-body');
    if (historicoDatos.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5">No hay lecturas guardadas para este día.</td></tr>';
        return;
    }

    tbody.innerHTML = [...historicoDatos].reverse().map(item => `
        <tr>
            <td>${escaparHtml(item.hora)}</td>
            <td><strong>${escaparHtml(item.temperatura)} °C</strong></td>
            <td>${escaparHtml(item.humedad)} %</td>
            <td>${escaparHtml(item.luz || '--')}</td>
            <td>${escaparHtml((item.ventilador || 'apagado').toUpperCase())}</td>
        </tr>
    `).join('');
}

function actualizarControlesDia() {
    const hoy = fechaLocal(new Date());
    document.getElementById('fecha-estadisticas').innerText =
        fechaSeleccionada === hoy ? `Hoy · ${mostrarFecha(hoy)}` : mostrarFecha(fechaSeleccionada);
    document.getElementById('dia-anterior').disabled =
        !fechasHistorico.some(fecha => fecha < fechaSeleccionada);
    document.getElementById('dia-siguiente').disabled = fechaSeleccionada === hoy;
}

function cambiarDia(direccion) {
    const hoy = fechaLocal(new Date());
    const disponibles = fechasHistorico.filter(fecha => fecha <= hoy);
    if (direccion < 0) {
        const anteriores = disponibles.filter(fecha => fecha < fechaSeleccionada);
        if (anteriores.length) fechaSeleccionada = anteriores[anteriores.length - 1];
    } else {
        const siguientes = disponibles.filter(fecha => fecha > fechaSeleccionada);
        fechaSeleccionada = siguientes.length ? siguientes[0] : hoy;
    }
    actualizarControlesDia();
    socket.emit('solicitar_historico_dia', fechaSeleccionada);
}

function cambiarTipoGrafico() {
    actualizarHistorico();
}

// 3. Actualizar la interfaz visual
function actualizarUI(datos) {
    interruptorLampara.checked = datos.sistema_encendido;
    if (datos.sistema_encendido) {
        animInicio.className = 'animacion-cozy animacion-principal encendido';
        animHero.className = 'animacion-cozy pequeña encendido';

        estadoTextoInicio.innerText = 'Sistema encendido';
        estadoTextoHero.innerText = 'Estado: Encendido (ON)';

        btnPower.innerText = 'Apagar Dispositivo';
        btnPower.classList.add('btn-peligro');
        btnPowerHero.innerText = 'Apagar';
        btnPowerHero.classList.add('btn-peligro');

        btnEntrar.style.display = 'inline-block';
    } else {
        animInicio.className = 'animacion-cozy animacion-principal apagado';
        animHero.className = 'animacion-cozy pequeña apagado';

        estadoTextoInicio.innerText = 'Sistema apagado';
        estadoTextoHero.innerText = 'Estado: Apagado (OFF)';

        btnPower.innerText = 'Encender Dispositivo';
        btnPower.classList.remove('btn-peligro');
        btnPowerHero.innerText = 'Encender';
        btnPowerHero.classList.remove('btn-peligro');

        btnEntrar.style.display = 'none';
    }

    // Si no estamos esperando respuesta de un pop-up, actualizamos los números
    if (!pausarActualizaciones) {
        document.getElementById('val-temp').innerText = datos.temperatura;
        document.getElementById('val-hum').innerText = datos.humedad;
        document.getElementById('val-luz').innerText = datos.luz;
        document.getElementById('val-vent').innerText = datos.ventilador.replace('_', ' ').toUpperCase();
    }
}

// 4. Encender y Apagar por MQTT
function cambiarEstadoSistema(encender) {
    if (encender === sistemaActivo) return;
    const accion = encender ? "encender" : "apagar";
    socket.emit('enviar_comando', { "acción": accion });
}

function togglePower() {
    cambiarEstadoSistema(!sistemaActivo);
}

// 5. Cambiar modo (Automático / Feedback)
function cambiarModo() {
    modoActual = document.getElementById('select-modo').value;
    ultimaTransicionFeedback = '';
    socket.emit('enviar_comando', { "modo": modoActual });
}

function solicitarFeedback(accion, tempActual, accionActual) {
    pausarActualizaciones = true; // Pausa la recogida visual hasta que el usuario conteste
    accionPendiente = accion;
    accionAnteriorPendiente = accionActual;

    let texto;
    if (accion === 'apagado') {
        texto = `La temperatura está en ${tempActual}°C. ¿Deseas apagar la climatización?`;
        btnAceptarFeedback.innerText = 'Sí, apagar';
    } else {
        const nombreAccion = accion === 'calefaccion' ? 'la calefacción' : 'el aire acondicionado';
        const verbo = accionActual === 'apagado' ? 'encender' : 'cambiar a';
        texto = `La temperatura está en ${tempActual}°C. ¿Deseas ${verbo} ${nombreAccion}?`;
        btnAceptarFeedback.innerText = 'Sí, aceptar';
    }
    document.getElementById('texto-feedback').innerText = texto;
    modalFeedback.classList.add('activa');
}

function responderFeedback(autorizado) {
    modalFeedback.classList.remove('activa');
    pausarActualizaciones = false;

    if (autorizado && accionPendiente) {
        socket.emit('enviar_comando', { "ventilador_forzado": accionPendiente });
    } else if (accionPendiente) {
        socket.emit('enviar_comando', {
            feedback_denegado: {
                accion: accionPendiente,
                mantener: accionAnteriorPendiente
            }
        });
    }
    accionPendiente = '';
    accionAnteriorPendiente = '';
}

// 7. Configuración de Colores LED (Conversión HEX -> RGB 0-255 para tu Python)
function hexToRgb(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return [r, g, b];
}

function guardarColores() {
    const frio = hexToRgb(document.getElementById('col-frio').value);
    const neutro = hexToRgb(document.getElementById('col-neutro').value);
    const calor = hexToRgb(document.getElementById('col-calor').value);

    socket.emit('enviar_comando', {
        "config_led": {
            "frio": frio,
            "neutro": neutro,
            "calor": calor
        }
    });
}

function resetColores() {
    document.getElementById('col-frio').value = "#0000ff";
    document.getElementById('col-neutro').value = "#00ff00";
    document.getElementById('col-calor').value = "#ff0000";
    guardarColores();
}

// 8. Navegación entre pantallas y pestañas
function navegar(idPantalla) {
    document.querySelectorAll('.pantalla').forEach(p => p.classList.remove('activa'));
    document.getElementById(idPantalla).classList.add('activa');
}

function cambiarVista(idVista, btnPulsado) {
    document.querySelectorAll('.vista').forEach(v => v.classList.remove('activa'));
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('activo'));

    document.getElementById(idVista).classList.add('activa');
    btnPulsado.classList.add('activo');
}

const clavesRutinasAnteriores = ['eunice-rutinas-v2', 'eunice-rutinas-demo-v1'];
const etiquetasDiasRutina = [
    { valor: 1, nombre: 'Lun' },
    { valor: 2, nombre: 'Mar' },
    { valor: 3, nombre: 'Mié' },
    { valor: 4, nombre: 'Jue' },
    { valor: 5, nombre: 'Vie' },
    { valor: 6, nombre: 'Sáb' },
    { valor: 0, nombre: 'Dom' }
];

function rutinaValida(rutina) {
    if (
        !rutina
        || typeof rutina.id !== 'string'
        || !/^[A-Za-z0-9_-]{1,80}$/.test(rutina.id)
        || typeof rutina.nombre !== 'string'
        || !rutina.nombre.trim()
        || rutina.nombre.trim().length > 48
        || !['Casa', 'Oficina'].includes(rutina.lugar)
        || !Array.isArray(rutina.dias)
        || !rutina.dias.length
        || !rutina.dias.every(dia => Number.isInteger(dia) && dia >= 0 && dia <= 6)
        || typeof rutina.hora !== 'string'
        || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(rutina.hora)
        || !Number.isFinite(rutina.temperatura)
        || rutina.temperatura < 16
        || rutina.temperatura > 28
    ) {
        return false;
    }
    return new Set(rutina.dias).size === rutina.dias.length;
}

function normalizarRutina(rutina) {
    return { ...rutina, dias: [...rutina.dias], activa: rutina.activa === true };
}

function cargarRutinasLocalesAnteriores() {
    try {
        for (const clave of clavesRutinasAnteriores) {
            const guardado = localStorage.getItem(clave);
            if (!guardado) continue;
            const estado = JSON.parse(guardado);
            if (!Array.isArray(estado.rutinas)) {
                throw new Error('El formato de las rutinas guardadas localmente no es válido.');
            }
            return estado.rutinas
                .filter(rutina => rutinaValida(rutina) && !rutina.id.startsWith('ejemplo-'))
                .map(normalizarRutina);
        }
        return [];
    } catch (error) {
        console.error('No se pudieron leer las rutinas guardadas localmente:', error);
        mostrarMensajeRutina('No se pudieron recuperar las rutinas anteriores de este dispositivo.', true);
        return [];
    }
}

function limpiarRutinasLocalesAnteriores() {
    try {
        clavesRutinasAnteriores.forEach(clave => localStorage.removeItem(clave));
    } catch (error) {
        console.error('No se pudieron borrar las rutinas locales ya sincronizadas:', error);
    }
}

async function leerRespuestaRutinas(response, mensajeError) {
    const resultado = await response.json();
    if (!response.ok) throw new Error(resultado.error || mensajeError);
    if (!Array.isArray(resultado.rutinas) || !resultado.rutinas.every(rutinaValida)) {
        throw new Error('El servidor devolvió una lista de rutinas no válida.');
    }
    return resultado;
}

let rutinas = [];

async function cargarRutinasDesdeServidor() {
    const revisionInicial = revisionRutinasSocket;
    mostrarMensajeRutina('Cargando rutinas...');
    try {
        let resultado = await leerRespuestaRutinas(
            await fetch('/api/rutinas'),
            'No se pudieron cargar las rutinas.'
        );
        const rutinasAnteriores = cargarRutinasLocalesAnteriores();
        if (rutinasAnteriores.length > 0) {
            resultado = await leerRespuestaRutinas(await fetch('/api/rutinas/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rutinas: rutinasAnteriores })
            }), 'No se pudieron sincronizar las rutinas anteriores.');
        }

        if (revisionInicial === revisionRutinasSocket) {
            rutinas = resultado.rutinas.map(normalizarRutina);
        }
        rutinasCargadas = true;
        limpiarRutinasLocalesAnteriores();
        actualizarRutinas();
        mostrarMensajeRutina('');
    } catch (error) {
        console.error('No se pudieron sincronizar las rutinas:', error);
        mostrarMensajeRutina(error.message, true);
    }
}

function describirDiasRutina(dias) {
    const ordenados = etiquetasDiasRutina.filter(dia => dias.includes(dia.valor));
    if (ordenados.length === 7) return 'Todos los días';
    if ([1, 2, 3, 4, 5].every(dia => dias.includes(dia)) && dias.length === 5) return 'Lunes a viernes';
    return ordenados.map(dia => dia.nombre).join(' · ');
}

function proximaLlegadaRutina(rutina, ahora = new Date()) {
    const [hora, minuto] = rutina.hora.split(':').map(Number);
    for (let desplazamiento = 0; desplazamiento <= 7; desplazamiento += 1) {
        const fecha = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() + desplazamiento, hora, minuto);
        if (rutina.dias.includes(fecha.getDay()) && fecha > ahora) return fecha;
    }
    return null;
}

function duracionRutina(minutos) {
    const horas = Math.floor(minutos / 60);
    const resto = minutos % 60;
    if (!horas) return `${resto} min`;
    if (!resto) return `${horas} h`;
    return `${horas} h ${resto} min`;
}

function horaRutina(fecha, incluirDia = false) {
    const opciones = incluirDia
        ? { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
        : { hour: '2-digit', minute: '2-digit' };
    return new Intl.DateTimeFormat('es-ES', opciones).format(fecha);
}

function crearPlanRutina(rutina, ahora = new Date()) {
    if (temperaturaActualRutina === null) {
        return { accion: 'Climatización', llegada: proximaLlegadaRutina(rutina, ahora), inicio: null, minutos: null };
    }
    const diferencia = rutina.temperatura - temperaturaActualRutina;
    const llegada = proximaLlegadaRutina(rutina, ahora);
    if (Math.abs(diferencia) < 0.5) {
        return {
            accion: 'Confort',
            llegada,
            inicio: null,
            minutos: 0
        };
    }

    const calefaccion = diferencia > 0;
    const ritmoPorHora = calefaccion ? 1.8 : 2.4;
    const minutos = Math.ceil((Math.abs(diferencia) / ritmoPorHora * 60) / 5) * 5;
    const inicio = llegada ? new Date(llegada.getTime() - minutos * 60 * 1000) : null;
    return {
        accion: calefaccion ? 'Calefacción' : 'Aire acondicionado',
        llegada,
        inicio,
        minutos
    };
}

function mostrarMensajeRutina(mensaje, esError = false) {
    const elemento = document.getElementById('rutina-mensaje');
    elemento.innerText = mensaje;
    elemento.classList.toggle('error', esError);
}

function actualizarRutinas() {
    const lista = document.getElementById('rutina-lista');
    if (rutinas.length === 0) {
        lista.innerHTML = '<div class="rutina-vacia"><strong>Aún no hay rutinas</strong><span>Pulsa «Nueva rutina» para crear la primera.</span></div>';
        return;
    }

    lista.innerHTML = rutinas.map(rutina => {
        const plan = crearPlanRutina(rutina);
        const objetivo = Number(rutina.temperatura).toLocaleString('es-ES', { maximumFractionDigits: 1 });
        const inicio = plan.minutos === null
            ? 'Esperando lectura'
            : !plan.minutos
                ? 'Temperatura ideal'
                : plan.inicio <= new Date() ? 'Ahora' : horaRutina(plan.inicio, true);
        const horaLlegada = plan.llegada ? horaRutina(plan.llegada, true) : '—';
        return `
            <article class="rutina-tarjeta${rutina.activa ? '' : ' pausada'}">
                <div class="rutina-tarjeta-cabecera">
                    <div>
                        <span class="rutina-lugar">${escaparHtml(rutina.lugar)}</span>
                        <h3>${escaparHtml(rutina.nombre)}</h3>
                    </div>
                    <div class="rutina-control-estado">
                        <span>${rutina.activa ? 'Activa' : 'Pausada'}</span>
                        <label class="rutina-interruptor">
                            <input type="checkbox" data-rutina-toggle="${escaparHtml(rutina.id)}" ${rutina.activa ? 'checked' : ''}
                                aria-label="${rutina.activa ? 'Desactivar' : 'Activar'} ${escaparHtml(rutina.nombre)}">
                            <span></span>
                        </label>
                    </div>
                </div>
                <p class="rutina-dias-resumen">${escaparHtml(describirDiasRutina(rutina.dias))} · ${escaparHtml(rutina.hora)} · ${objetivo} °C</p>
                <div class="rutina-plan">
                    <span>${rutina.activa ? escaparHtml(plan.accion) : 'Pausada'}</span>
                    <strong>${rutina.activa ? escaparHtml(inicio) : 'Rutina desactivada'}</strong>
                    <small>${rutina.activa && plan.llegada ? `Llegada ${escaparHtml(horaLlegada)}` : ''}</small>
                </div>
                <button class="rutina-eliminar" type="button" data-rutina-eliminar="${escaparHtml(rutina.id)}"
                    aria-label="Eliminar rutina ${escaparHtml(rutina.nombre)}">Eliminar</button>
            </article>
        `;
    }).join('');

    lista.querySelectorAll('[data-rutina-toggle]').forEach(control => {
        control.addEventListener('change', async () => {
            if (!rutinasCargadas) {
                mostrarMensajeRutina('Espera a que se carguen las rutinas antes de cambiar su estado.', true);
                actualizarRutinas();
                return;
            }
            control.disabled = true;
            try {
                const resultado = await leerRespuestaRutinas(await fetch(
                    `/api/rutinas/${encodeURIComponent(control.dataset.rutinaToggle)}`,
                    {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ activa: control.checked })
                    }
                ), 'No se pudo actualizar la rutina.');
                rutinas = resultado.rutinas.map(normalizarRutina);
                actualizarRutinas();
                mostrarMensajeRutina(`Rutina ${control.checked ? 'activada' : 'pausada'}.`);
            } catch (error) {
                console.error('No se pudo cambiar el estado de la rutina:', error);
                actualizarRutinas();
                mostrarMensajeRutina(error.message, true);
            }
        });
    });

    lista.querySelectorAll('[data-rutina-eliminar]').forEach(boton => {
        boton.addEventListener('click', async () => {
            if (!rutinasCargadas) {
                mostrarMensajeRutina('Espera a que se carguen las rutinas antes de eliminarlas.', true);
                return;
            }
            boton.disabled = true;
            try {
                const resultado = await leerRespuestaRutinas(await fetch(
                    `/api/rutinas/${encodeURIComponent(boton.dataset.rutinaEliminar)}`,
                    { method: 'DELETE' }
                ), 'No se pudo eliminar la rutina.');
                rutinas = resultado.rutinas.map(normalizarRutina);
                actualizarRutinas();
                mostrarMensajeRutina('Rutina eliminada.');
            } catch (error) {
                console.error('No se pudo eliminar la rutina:', error);
                actualizarRutinas();
                mostrarMensajeRutina(error.message, true);
            }
        });
    });
}

const formularioRutina = document.getElementById('rutina-form');
formularioRutina.addEventListener('submit', async event => {
    event.preventDefault();
    if (!rutinasCargadas) {
        mostrarMensajeRutina('Espera a que se carguen las rutinas antes de guardar.', true);
        return;
    }
    const dias = [...formularioRutina.querySelectorAll('input[name="rutina-dias"]:checked')]
        .map(input => Number(input.value));
    if (!dias.length) {
        mostrarMensajeRutina('Selecciona al menos un día para esta rutina.', true);
        return;
    }

    const nombre = document.getElementById('rutina-nombre').value.trim();
    if (!nombre) {
        mostrarMensajeRutina('Escribe un nombre para la rutina.', true);
        return;
    }
    const lugar = document.getElementById('rutina-lugar').value;
    const rutina = {
        nombre,
        lugar,
        dias,
        hora: document.getElementById('rutina-hora').value,
        temperatura: Number(document.getElementById('rutina-objetivo').value)
    };
    const guardar = formularioRutina.querySelector('button[type="submit"]');
    guardar.disabled = true;
    try {
        const resultado = await leerRespuestaRutinas(await fetch('/api/rutinas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rutina)
        }), 'No se pudo guardar la rutina.');
        rutinas = resultado.rutinas.map(normalizarRutina);
        actualizarRutinas();
        mostrarMensajeRutina('Rutina guardada y activada.');
        formularioRutina.reset();
        document.getElementById('rutina-nueva').open = false;
    } catch (error) {
        console.error('No se pudo guardar la rutina:', error);
        mostrarMensajeRutina(error.message, true);
    } finally {
        guardar.disabled = false;
    }
});

actualizarRutinas();

async function exportarExcel() {
    if (historicoDatos.length === 0) {
        alert('No hay datos para exportar en el día seleccionado.');
        return;
    }

    try {
        const tipo = document.getElementById('tipo-grafico').value;
        const nombreTipo = { line: 'lineas', bar: 'barras', doughnut: 'circular' }[tipo];
        const esDemostracion = historicoDatos.every(registro => registro.simulado === true);
        const response = await fetch(
            `/api/exportar-excel?fecha=${encodeURIComponent(fechaSeleccionada)}&tipo=${encodeURIComponent(tipo)}`
        );
        if (!response.ok) throw new Error(await response.text());
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `euNICE_${fechaSeleccionada}_${nombreTipo}${esDemostracion ? '_demostracion' : ''}.xlsx`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
    } catch (error) {
        console.error('Error al descargar el Excel:', error);
        alert(`No se pudo descargar el Excel: ${error.message}`);
    }
}

const loginForm = document.getElementById('login-form');
const loginUsername = document.getElementById('login-username');
const loginPassword = document.getElementById('login-password');
const loginMessage = document.getElementById('login-message');
const pushStatus = document.getElementById('push-status');
const pushToggle = document.getElementById('push-toggle');
const pushTest = document.getElementById('push-test');
let registroServiceWorker = null;
let suscripcionPush = null;

function mostrarAplicacion() {
    document.body.classList.add('autenticado');
    socket.connect();
    void cargarRutinasDesdeServidor();
    prepararNotificaciones();
    if (new URLSearchParams(window.location.search).has('notificacion')) {
        navegar('pantalla-app');
    }
}

function esIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function estaInstaladaComoPWA() {
    return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

async function prepararNotificaciones() {
    if (esIOS() && !estaInstaladaComoPWA()) {
        pushStatus.innerText = 'En iPhone, añade euNICE a la pantalla de inicio antes de activar avisos.';
        pushToggle.disabled = true;
        pushTest.disabled = true;
        return;
    }
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        pushStatus.innerText = 'Este navegador no admite notificaciones web push.';
        pushToggle.disabled = true;
        pushTest.disabled = true;
        return;
    }

    try {
        registroServiceWorker = await navigator.serviceWorker.register('/service-worker.js');
        suscripcionPush = await registroServiceWorker.pushManager.getSubscription();
        if (!suscripcionPush) {
            const statusResponse = await fetch('/api/push/status');
            const statusResult = await statusResponse.json();
            if (!statusResponse.ok || !statusResult.configured) {
                pushStatus.innerText = 'El servidor todavía no está configurado para enviar notificaciones push.';
                pushToggle.disabled = true;
                pushTest.disabled = true;
                return;
            }
        }
        pushToggle.disabled = false;
        pushTest.disabled = !suscripcionPush;
        pushToggle.innerText = suscripcionPush ? 'Desactivar notificaciones' : 'Activar notificaciones';
        pushStatus.innerText = suscripcionPush
            ? 'Avisos activos para solicitudes de confirmación y cambios de estado.'
            : 'Activa los avisos para solicitudes de confirmación y cambios de estado.';
    } catch (error) {
        console.error('No se pudo preparar el service worker:', error);
        pushStatus.innerText = `No se pudieron preparar las notificaciones: ${error.message}`;
        pushToggle.disabled = true;
        pushTest.disabled = true;
    }
}

function convertirClavePublica(clave) {
    const base64 = clave.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = window.atob(base64);
    return Uint8Array.from(bytes, caracter => caracter.charCodeAt(0));
}

async function alternarNotificaciones() {
    pushToggle.disabled = true;
    try {
        if (!registroServiceWorker) {
            throw new Error('El service worker todavía no está preparado.');
        }

        if (suscripcionPush) {
            const response = await fetch('/api/push-subscriptions', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint: suscripcionPush.endpoint })
            });
            if (!response.ok) throw new Error((await response.json()).error || 'No se pudo desactivar el aviso.');
            await suscripcionPush.unsubscribe();
            suscripcionPush = null;
        } else {
            const permissionPromise = Notification.permission === 'default'
                ? Notification.requestPermission()
                : Promise.resolve(Notification.permission);
            const keyResponsePromise = fetch('/api/push/public-key');
            const [permission, keyResponse] = await Promise.all([permissionPromise, keyResponsePromise]);
            const keyResult = await keyResponse.json();
            if (!keyResponse.ok) throw new Error(keyResult.error || 'No se pudo cargar la clave push.');
            if (permission !== 'granted') throw new Error('No se concedió permiso para las notificaciones.');

            suscripcionPush = await registroServiceWorker.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: convertirClavePublica(keyResult.publicKey)
            });
            const response = await fetch('/api/push-subscriptions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(suscripcionPush)
            });
            if (!response.ok) {
                await suscripcionPush.unsubscribe();
                suscripcionPush = null;
                throw new Error((await response.json()).error || 'No se pudo guardar la suscripción.');
            }
        }
        await prepararNotificaciones();
    } catch (error) {
        console.error('No se pudo cambiar la suscripción push:', error);
        pushStatus.innerText = error.message;
    } finally {
        pushToggle.disabled = false;
    }
}

async function enviarNotificacionPrueba() {
    if (!suscripcionPush) return;

    pushTest.disabled = true;
    pushStatus.innerText = 'Enviando una notificación de prueba...';
    try {
        const response = await fetch('/api/push/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: suscripcionPush.endpoint })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'No se pudo enviar la notificación de prueba.');
        pushStatus.innerText = 'Prueba enviada. Comprueba las notificaciones del móvil.';
    } catch (error) {
        console.error('No se pudo enviar la notificación push de prueba:', error);
        pushStatus.innerText = error.message;
    } finally {
        pushTest.disabled = !suscripcionPush;
    }
}

loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    loginMessage.innerText = '';
    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: loginUsername.value,
                password: loginPassword.value
            })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'No se pudo iniciar sesión.');
        loginPassword.value = '';
        mostrarAplicacion();
    } catch (error) {
        loginMessage.innerText = error.message;
    }
});

pushToggle.addEventListener('click', alternarNotificaciones);
pushTest.addEventListener('click', enviarNotificacionPrueba);

document.getElementById('logout-button').addEventListener('click', async () => {
    try {
        const response = await fetch('/api/logout', { method: 'POST' });
        if (!response.ok) throw new Error('No se pudo cerrar la sesión.');
        window.location.reload();
    } catch (error) {
        alert(error.message);
    }
});

fetch('/api/session')
    .then(response => {
        if (!response.ok) throw new Error('No se pudo comprobar la sesión.');
        return response.json();
    })
    .then(result => {
        if (result.authenticated) {
            mostrarAplicacion();
        } else {
            loginUsername.focus();
        }
    })
    .catch(error => {
        console.error('No se pudo comprobar la sesión:', error);
        loginMessage.innerText = error.message;
    });