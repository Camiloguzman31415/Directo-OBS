# DirectoOBS v2.0 🎬🏆

Sistema profesional de **Overlays y Consola de Switcher Broadcast en tiempo real** para transmisiones de torneos de Speedcubing de la World Cube Association (WCA) en **OBS Studio**.

Diseñado en **Node.js** con soporte nativo de **OBS WebSocket v5**, sincronización en vivo con **WCA Live**, motor maestro de emisión digital (**Señal En Vivo /envivo**), simulador multiview de hasta 6 cámaras, mini-cámara PiP de casteo, transiciones animadas con canal alfa y una consola de control táctil de alta productividad.

---

## 🚀 Inicio Rápido

### 1. Requisitos
* [Node.js](https://nodejs.org/) v18 o superior.
* [OBS Studio](https://obsproject.com/) v28 o superior (con servidor WebSocket integrado).

### 2. Instalación y Ejecución
```bash
# 1. Instalar dependencias (solo la primera vez)
npm install

# 2. Iniciar el servidor (con datos de torneo de ejemplo)
node server.js --data ColombianNationalsPaipa2026_data.json

# O iniciar con script por defecto
npm start
```

### 3. Enlaces del Sistema
* 🎛️ **Panel de Control (Operador):** [http://localhost:3000](http://localhost:3000)
* 🔴 **Señal En Vivo Master (OBS Master 1080p60):** [http://localhost:3000/envivo](http://localhost:3000/envivo) *(Recomendado para OBS)*
* 📺 **Overlay Transparente (OBS Clásico):** [http://localhost:3000/overlay](http://localhost:3000/overlay)
* 🖥️ **Tabla FullScreen Clasificatoria:** [http://localhost:3000/fullscreen](http://localhost:3000/fullscreen)
* 🔄 **Escena de Transición / Estado:** [http://localhost:3000/transicion](http://localhost:3000/transicion)

---

## 🔴 Señal En Vivo Master (`/envivo`): 1 Única Escena en OBS

DirectoOBS funciona como una **mesa de control y conmutación broadcast completa**. En OBS Studio ya **no necesitas crear ni alternar múltiples escenas físicas**, evitando desincronizaciones, recargas del navegador de Chromium CEF y desconexiones de WebSockets.

### Configuración en OBS Studio (Solo 2 pasos):
1. En OBS, crea **1 sola escena** (puedes llamarla `En Vivo` o `Directo`).
2. Agrega una **Fuente de Navegador** (*Browser Source*):
   * **URL:** `http://localhost:3000/envivo`
   * **Ancho:** `1920`
   * **Alto:** `1080`
   * **FPS:** `60`
   * *(Recomendado)* Desmarca *"Cerrar la fuente cuando no sea visible"*.

A partir de ahí, **todas las transiciones y conmutaciones se controlan 100% desde el Panel de Control** sin tocar OBS.

---

## 🎛️ Las 4 Escenas Principales Conmutables

Desde la pestaña **Switcher y Cámaras**, puedes conmutar fluidamente entre las 4 escenas del programa:

| Escena | Descripción y Contenido |
| :--- | :--- |
| **`1 · Escena Principal`** | Cámaras en vivo (de 1 a 6 cámaras con layouts dinámicos) + **Cámara PiP de Casteo** esquinada + Overlays de WCA (Mesa de competidores, Ticker de noticias inferior, Logos de torneo y tarjeta lateral Showcase). |
| **`2 · PreEscena (Preview)`** | Entorno de preparación independiente. Permite seleccionar cámaras, ranuras y composiciones sin alterar la señal al aire, con botón **`⇄ CONMUTAR PREESCENA ⇄ PRINCIPAL`** instantáneo. |
| **`3 · FullScreen (Tabla)`** | Oculta las cámaras y despliega a pantalla completa la tabla de resultados WCA Live (estilo European Championship 2026) con bandera colombiana animada, cubos isométricos, desglose de los 5 solves, columnas de **AVG** y **BEST**, banderas nacionales y patrocinadores. |
| **`4 · Transición`** | Cortinillas temáticas de transmisión con videos animados y carrusel de patrocinadores: `Iniciando` (con videos duales y día de torneo), `Pausa` (hora de almuerzo), `Reconectando` (aviso técnico) y `Despedida` (gracias por vernos). |

---

## 📹 Distribución Multicámara y PiP de Casteo

### Selector Dinámico de 1 a 6 Cámaras:
* **1 Cámara:** `Pantalla Completa (1)`.
* **2 Cámaras:** `Split Izq/Der`, `Split Der/Izq`, `Split Arriba/Abajo`, `Split Abajo/Arriba`, `Focus 1+2`.
* **3 Cámaras:** `1 Principal Izq + 2 Der`, `1 Principal Arriba + 2 Abajo`, `3 Columnas (1 | 1 | 1)`.
* **4 Cámaras:** `Cuadrícula 2×2`, `1 Principal Izq + 3 Der`, `1 Principal Arriba + 3 Abajo`.
* **5 Cámaras:** `2 Arriba + 3 Abajo`, `1 Principal Izq + 4 Der`.
* **6 Cámaras:** `Cuadrícula 3×2`, `1 Principal Arriba + 5 Abajo`.

### 🎙️ Mini-cámara PiP de Casteo (Comentaristas):
* Control independiente con interruptor **ON / OFF** y selector de cámara dedicada.
* **Auto-posicionamiento inteligente:** Si el banner inferior de noticias (ticker) está activo, la mini-cámara se apoya automáticamente justo encima del banner; si está limpio, se posiciona al ras de la esquina de la pantalla.
* Posicionamiento en 4 esquinas: Abajo Derecha (`BR`), Abajo Izquierda (`BL`), Arriba Derecha (`TR`) y Arriba Izquierda (`TL`).

### 📺 Multiviews en Tiempo Real:
1. **Multiview de las 4 Escenas Principales:** Miniaturas en vivo de Principal, PreEscena, FullScreen y Transición (con fondo `#020409` oscuro y relación 16:9).
2. **Multiview de Entradas de Cámaras (6 canales):** Grilla interactiva con los videos en bucle de cada cámara con botones directos para enviar a `Mesa 1 (A)`, `Mesa 2 (B)` o `Pantalla Completa`.

---

## 🐑 Transición Stinger Personalizada (Cortina Animada)

El sistema incluye una cortina animada con transparencia y audio estéreo para cambios de escena opcionales en OBS Studio:

* **Archivo del video:** [`public/videos/cortina_transparente.webm`](public/videos/cortina_transparente.webm)
* **Formato:** WebM (Códec VP9 con Canal Alfa a 1080p, ~580 KB) con audio Opus estéreo incrustado.

### Configuración en OBS Studio:
1. En el panel **Transiciones de escena**, añade una transición de tipo **Stinger**.
2. **Archivo de video:** Selecciona `public/videos/cortina_transparente.webm`.
3. **Tipo de punto de transición:** `Fotograma` (o `Tiempo`).
4. **Punto de transición:** `1` (o `33 ms`).

---

## 🎛️ Integración con OBS Studio WebSocket v5

El panel web se integra con OBS Studio mediante **OBS WebSocket v5** (incluido desde OBS 28 en adelante):

1. En OBS Studio, ve a: **Herramientas > Ajustes del servidor WebSocket**.
2. Marca la casilla **"Habilitar el servidor WebSocket"** (puerto por defecto: `4455`).
3. Al abrir [http://localhost:3000](http://localhost:3000), el panel se conectará automáticamente.
4. **Modo Master Digital:** Los cambios de escenas digitales en `/envivo` no forzarán cambios físicos de escena en OBS, manteniendo la emisión sólida y estable.

---

## 🏆 Clasificaciones en Vivo (WCA Live) y Patrocinadores

* **Clasificatoria FullScreen:** Paginación dinámica y auto-balance de filas, colores oficiales para tiempos promedio (**AVG**) y récord (**BEST**), nombres de rondas traducidos al español (*Ronda 1*, *Semifinal*, *Final*) y carrusel de patrocinadores oficiales.
* **Banners de Competidor:**
  * **Mesa Individual y Dual (Mesa 1 y Mesa 2)** con tiempos PR Single y PR Average.
  * **Head to Head (H2H):** Comparación directa cara a cara entre dos finalistas.
  * **Showcase Card:** Tarjeta de presentación lateral con foto, país y récords del competidor.
* **Fotos y Avatares WCA:** Se descargan y almacenan en caché local en [`public/uploads/avatars/`](public/uploads/avatars/) con fallback por WCA ID.

---

## ⚡ Atajos de Teclado del Operador

| Atajo | Acción |
| :---: | :--- |
| `/` | Enfocar buscador de competidores |
| `F8` | Alternar tarjeta del competidor (Showcase / Mesa) |
| `F9` | Alternar banner inferior de disciplina y ticker de avisos |
| `F10` | **Pánico:** Ocultar todos los overlays de inmediato |

---

## 📁 Estructura del Proyecto

```text
DirectoOBS/
├── public/
│   ├── audio/              # Efectos de sonido y jingles
│   ├── videos/             # Animaciones de la mascota, cortina Stinger y bucles de cámaras
│   │   └── camaras/        # Archivos de video para el simulador de 6 cámaras en vivo
│   ├── uploads/            # Logos del torneo, marcas de patrocinadores y avatares WCA
│   ├── icons/              # Iconos vectoriales oficiales WCA (3x3, 4x4, Pyraminx, etc.)
│   ├── overlay.html        # Motor gráfico broadcast para OBS (/envivo, /overlay, /fullscreen)
│   ├── index.html          # Consola web de control del operador
│   ├── js/                 # Lógica de switcher, WebSockets, WCA Live y controles táctiles
│   └── css/                # Hojas de estilo modulares optimizadas
├── server.js               # Motor central en Node.js, WebSockets duales y APIs WCA
├── live_state.json         # Estado persistente de configuraciones, temas y rondas
├── package.json            # Dependencias y scripts
└── README.md               # Documentación oficial del sistema
```

---

## 📄 Licencia

Desarrollado para la comunidad de Speedcubing y organizadores de torneos oficiales de la **World Cube Association (WCA)**.
