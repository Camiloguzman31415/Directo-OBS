# DirectoOBS v2.0 🎬🏆

Sistema profesional de **Overlays y Control Deck en tiempo real** para transmisiones de torneos de Speedcubing de la World Cube Association (WCA) en **OBS Studio**.

Refactorizado completamente en **Node.js** con soporte nativo de **OBS WebSocket v5**, sincronización en vivo con **WCA Live**, transiciones personalizadas con canal alfa y una interfaz de operador táctil de alta productividad.

---

## 🚀 Inicio Rápido

### 1. Requisitos
* [Node.js](https://nodejs.org/) v18 o superior.
* [OBS Studio](https://obsproject.com/) v28 o superior (con OBS WebSocket integrado).

### 2. Instalación y Ejecución
```bash
# Instalar dependencias (solo la primera vez)
npm install

# Iniciar el servidor
npm start
```

* 🎛️ **Panel de Control (Operador):** [http://localhost:3000](http://localhost:3000) (accesible también desde tablets o celulares en la misma red Wi-Fi).
* 📺 **Overlay Principal (OBS):** [http://localhost:3000/overlay](http://localhost:3000/overlay)
* 🖥️ **Escenas Fullscreen / Descansos:** [http://localhost:3000/fullscreen](http://localhost:3000/fullscreen)
* 🔄 **Escena de Transición:** [http://localhost:3000/transicion](http://localhost:3000/transicion)

---

## 🐑 Transición Stinger Personalizada (Cortina Animada)

El sistema incluye una cortina animada con transparencia y efecto de sonido sincronizado para cambios de escena profesionales en OBS Studio:

* **Archivo del video:** [`public/videos/cortina_transparente.webm`](public/videos/cortina_transparente.webm)
* **Formato:** WebM (Códec VP9 con Canal Alfa a 1080p, ~580 KB) con audio Opus estéreo incrustado.

### Configuración en OBS Studio:
1. En el panel **Transiciones de escena**, añade una transición de tipo **Stinger**.
2. **Archivo de video:** Selecciona `public/videos/cortina_transparente.webm`.
3. **Tipo de punto de transición:** `Fotograma` (o `Tiempo`).
4. **Punto de transición:** `1` (o `33 ms`).
5. **Monitorización de audio:** Configúralo en **Monitorización y salida** en las Propiedades de audio avanzadas de OBS para escuchar el sonido en audífonos y enviarlo al stream.

---

## 🎛️ Conectar OBS Studio para Control Remoto

El panel web se integra con OBS Studio mediante **OBS WebSocket v5** (incluido desde OBS 28):

1. En OBS Studio, ve a: **Herramientas > Ajustes del servidor WebSocket**.
2. Marca la casilla **"Habilitar el servidor WebSocket"** (puerto por defecto: `4455`).
3. Al abrir [http://localhost:3000](http://localhost:3000), el panel se conectará automáticamente:
   * **Rejilla Stream Deck:** Tus escenas se convierten en botones táctiles con indicador rojo `PROGRAM` para la escena al aire.
   * **Control de Capas y Fuentes:** Activa o apaga cámaras, overlays o reproductores multimedia con un clic.
   * **Presets de Cámara:** `⛶ Full`, `◲ PiP Abajo`, `◳ PiP Arriba`, `◫ Izq / Der` y `▣ Centro`.
   * **Monitoreo de Emisión:** Botones para supervisar e iniciar/detener `STREAM` y `REC`.

---

## 📺 Configuración de Fuentes en OBS Studio

Para cada overlay en tu colección de escenas de OBS, crea una fuente de tipo **Navegador** (*Browser Source*):

| Escena / Uso | URL en OBS | Resolución | Notas |
| :--- | :--- | :---: | :--- |
| **Overlays en vivo (cámaras, competidor, eventos)** | `http://localhost:3000/overlay` | 1920 × 1080 | Marcar *"Actualizar el navegador cuando la escena se active"* |
| **Pantalla completa (ranking clasificatorio y pausas)** | `http://localhost:3000/fullscreen` | 1920 × 1080 | Permite rotar clasificaciones completas |
| **Escena de Transición / Estado** | `http://localhost:3000/transicion` | 1920 × 1080 | Muestra el estado activo seleccionado en el panel |

---

## 🏆 Clasificaciones en Vivo (WCA Live) y Escenas

* **Clasificatoria Fullscreen:** Paginación dinámica y auto-balance, con columnas diferenciadas en color azul para **AVG** y verde para **BEST**, nombres de rondas traducidos al español (*Ronda 1*, *Semifinal*, *Final*) y carrusel automático de patrocinadores.
* **Escenas de Pausa y Descanso:**
  * 🍽️ **Hora de almuerzo:** Con video animado de la mascota compartiendo la mesa (`Almuerzo animación.mp4`).
  * 🔌 **Reconectando:** Con video animado de la mascota con cables (`Oveja con cables.mp4`).
  * 👋 **Iniciando transmisión y despedida.**
* **Head to Head (H2H):** Comparación directa cara a cara entre dos competidores con récords personales y fotos de perfil.

---

## 🖼️ Avatares y Fotos de Competidores

* Las fotos de los competidores se descargan y almacenan en caché local en [`public/uploads/avatars/`](public/uploads/avatars/).
* **Personalización manual:** Si un competidor no tiene foto en la WCA o deseas colocar una imagen en alta definición, basta con guardar su foto en `public/uploads/avatars/` con el nombre de su WCA ID en mayúsculas (ejemplo: `2024GARC01.jpg`). El sistema la mostrará automáticamente en pantalla.

---

## ⚡ Atajos de Teclado del Operador

| Atajo | Acción |
| :---: | :--- |
| `/` | Enfocar buscador de competidores |
| `F8` | Alternar tarjeta del competidor (Showcase) |
| `F9` | Alternar badge del evento y ronda activa |
| `F10` | **Pánico:** Ocultar todos los overlays de inmediato |

---

## 📁 Estructura del Proyecto

```text
DirectoOBS/
├── public/
│   ├── audio/              # Efectos de sonido (transiciones, alertas)
│   ├── videos/             # Animaciones de la mascota y cortina transparente (WebM)
│   ├── uploads/            # Logos de torneo, patrocinadores y avatares de cuberos
│   ├── overlay.html        # Plantilla principal del overlay en vivo
│   ├── index.html          # Panel de control del operador
│   ├── js/                 # Lógica del cliente, websockets y controles táctiles
│   └── css/                # Estilos visuales optimizados
├── server.js               # Motor central en Node.js, WebSocket v5 y APIs WCA
├── live_state.json         # Estado persistente de temas y configuración
└── package.json            # Dependencias y scripts
```
