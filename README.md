# DirectoOBS v2.0 🎬🏆

Sistema profesional de **Overlays y Control Deck en tiempo real** para transmisiones de torneos de Speedcubing de la World Cube Association (WCA) en **OBS Studio**.

Refactorizado completamente a **Node.js** con soporte nativo de **OBS WebSocket v5** e interfaz de operador táctil optimizada bajo estándares de diseño de alta productividad (Operate Mode).

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

* 🎛️ **Panel de Control:** Abre en tu navegador [http://localhost:3000](http://localhost:3000) (también compatible con tablets y iPads en la misma red local).
* 📺 **Overlay para OBS Studio:** [http://localhost:3000/overlay](http://localhost:3000/overlay)

---

## 🎛️ Conectar OBS Studio para Control Remoto de Escenas

A partir de OBS Studio 28, el servidor WebSocket viene incluido de fábrica:

1. En OBS Studio, ve al menú superior: **Herramientas > Ajustes del servidor WebSocket**.
2. Marca la casilla **"Habilitar el servidor WebSocket"** (puerto por defecto: `4455`).
3. Opcionalmente, desmarca la contraseña para acceso local directo, o copia la contraseña generada.
4. Al abrir [http://localhost:3000](http://localhost:3000), el panel se conectará automáticamente a OBS:
   * **Rejilla Stream Deck:** Verás automáticamente todas tus escenas de OBS convertidas en botones.
   * **Cambio de Escena:** Haz clic en cualquier escena para pasarla a Programa (al aire) al instante.
   * **Indicador en Vivo:** La escena activa se resalta con borde rojo brillante y la etiqueta `PROGRAM`.
   * **Control de Capas y Fuentes:** Lista en tiempo real de todas las cámaras, videos y elementos de la escena activa.
     * Conmutador con botón de ojo (`👁️`) para prender/apagar cualquier capa al instante.
     * **Presets de Encuadre para Cámaras:** Botones táctiles para transformar la posición de la cámara:
       - `⛶ Full`: Pantalla completa ($1920 \times 1080$).
       - `◲ PiP Abajo`: Esquina inferior derecha (Picture-in-Picture).
       - `◳ PiP Arriba`: Esquina superior derecha.
       - `◫ Izq / Der`: Pantalla dividida al 50%.
       - `▣ Centro`: Centrado con margen para overlays.
     * **Control Multimedia para Videos:** Si la fuente es un video o repetición, incluye controles para `↺ Reiniciar`, `⏸ Pausa`, `▶ Play` y `⏹ Stop`.
   * **Botones STREAM y REC:** Permiten monitorear e iniciar/detener tu transmisión y grabación desde la web.

---

## 📺 Configuración de la Fuente en OBS Studio

1. En tu escena de OBS, añade una nueva fuente: **Navegador** (*Browser Source*).
2. Configura los siguientes parámetros:
   * **URL:** `http://localhost:3000/overlay`
   * **Ancho:** `1920`
   * **Alto:** `1080`
   * **Actualizar el navegador cuando la escena se active:** Marcado.
3. ¡Listo! El overlay se conectará automáticamente por WebSocket.

*(Nota: Si prefieres seguir usando el archivo local `overlay.html`, también sigue siendo 100% compatible conectándose al puerto fallback `8765`).*

---

## ⚡ Atajos de Teclado del Operador

| Atajo | Acción |
| :--- | :--- |
| `/` | Enfocar instantáneamente el buscador de competidores |
| `F8` | Mostrar / Ocultar tarjeta del competidor en OBS |
| `F9` | Mostrar / Ocultar badge del evento y ronda en OBS |
| `F10` | **Pánico:** Ocultar todos los overlays de OBS de inmediato |

---

## 🌐 Gestión de Datos WCA

* **Descarga Automática:** En la pestaña **🌐 API WCA**, ingresa el ID oficial de la competencia (ej. `RoadToSACSantander2026`). El servidor descargará la lista de competidores aceptados y consultará los récords personales (Single y Average) de todos los veteranos en tiempo real.
* **Carga de Archivo Local:** En la pestaña **📂 Archivos**, puedes subir cualquier archivo `_data.json` previamente generado.
