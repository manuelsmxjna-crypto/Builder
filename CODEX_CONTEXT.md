# BixStudio — Contexto persistente para Codex

> Este archivo sirve como memoria técnica y funcional del proyecto para sesiones de Codex. Léelo antes de modificar el Builder. **No asumas que todo lo descrito aquí sigue implementado exactamente igual: inspecciona el código actual antes de tocarlo.** Cuando este documento y el código difieran, el código actual manda y debes señalar la discrepancia.

## 1. Qué es BixStudio

BixStudio es un **Gang Sheet Builder web para producción DTF**. Permite que clientes suban diseños, los dimensionen y acomoden sobre hojas de impresión, agreguen texto, organicen automáticamente los objetos y finalmente envíen el trabajo para producción/Shopify.

El objetivo principal no es ser un editor gráfico genérico: es preparar lienzos DTF de forma rápida, segura y predecible, evitando errores de tamaño, resolución, superposición y exportación.

Repositorio principal: `manuelsmxjna-crypto/Builder`.

## 2. Regla de trabajo para Codex

Antes de implementar una tarea:

1. Inspecciona el repositorio y el código realmente involucrado.
2. Identifica archivos, funciones, estado y eventos relacionados.
3. Reutiliza lógica existente cuando sea posible.
4. Propón cambios mínimos; evita reescrituras amplias sin necesidad.
5. Señala riesgos de regresión antes de modificar zonas delicadas.
6. No inventes nombres de funciones o arquitectura basándote solamente en este documento.
7. Mantén sincronizados preview, geometría interna y resultado de producción.
8. Prioriza rendimiento: el Builder puede manejar cientos o incluso muchos más objetos.
9. No elimines funciones existentes para simplificar una implementación nueva salvo autorización explícita.
10. Después de modificar, prueba los flujos relacionados y no solamente el caso feliz de la función nueva.

## 3. Estructura conocida del repositorio

El proyecto actualmente es principalmente una aplicación web con una parte importante de la lógica en `index.html`. También existen workers y carpetas dedicadas al procesamiento y nesting.

Archivos/componentes conocidos:

- `index.html` — Builder principal actual; contiene gran parte de UI y lógica.
- `Index.html` — existe además una variante/archivo histórico con mayúscula; no asumir que es el entrypoint de producción.
- `processor.worker.js` — procesamiento auxiliar.
- `bgremove.worker.js` — background removal local.
- `upscaler.worker.js` — upscale local.
- `bixnest/` — lógica relacionada con Auto Organizar / nesting.
- `models/` — modelos locales de IA.
- `ort/` — runtime ONNX relacionado con procesamiento local.
- `INICIAR_BIXSTUDIO.bat` — arranque local en Windows.

Antes de modificar, verifica cuál archivo está realmente activo y desplegado.

## 4. Lienzo y hojas

Conceptos funcionales importantes:

- Ancho de producción DTF: **62 cm**.
- El usuario no debe poder convertir accidentalmente la hoja en un ancho arbitrario.
- La altura puede crecer según el contenido hasta los límites definidos por el Builder.
- Hay soporte para múltiples hojas.
- Existe hoja activa y navegación/listado de hojas.
- El sistema debe manejar correctamente creación/eliminación de hojas y operaciones que afectan una hoja o todas.
- Auto Organizar puede reorganizar contenido y existen flujos para organizar la hoja actual / múltiples hojas según la versión actual.
- Debe evitarse la creación explosiva de hojas o loops infinitos cuando existen muchos duplicados.

## 5. Objetos del editor

### Imágenes

- Importación de PNG/JPG/WEBP/SVG según soporte actual.
- Se conservan dimensiones físicas/DPI de forma coherente.
- Los objetos pueden moverse, redimensionarse, rotarse, voltearse, duplicarse y eliminarse.
- Existe bloqueo/desbloqueo de proporciones.
- Hay indicadores de calidad/resolución.

### Texto

El texto es un objeto real del Builder y debe comportarse lo más parecido posible a una imagen en las operaciones geométricas.

Funciones desarrolladas o requeridas históricamente:

- edición de texto;
- fuentes;
- instalación de fuentes del usuario;
- bold/italic/alineación según soporte actual;
- color;
- stroke/contorno;
- ancho del stroke;
- resize;
- rotación;
- duplicado;
- participación en Auto Organizar;
- saltos de línea con Enter durante edición;
- límite razonable de texto para impedir congelamientos por entradas absurdamente grandes.

Regresiones que deben evitarse:

- el stroke debe escalar coherentemente al redimensionar el texto;
- “estirar al ancho útil” debe transformar el texto real, no únicamente su hitbox;
- al rotar texto, editar ancho/alto debe respetar la geometría visual actual y no actuar ingenuamente sobre dimensiones originales;
- la hitbox debe considerar ascenders, descenders y overhangs (por ejemplo `g`, `p`, `q`, etc.);
- el texto no debe sobresalir incorrectamente de su propia geometría de selección;
- Auto Organizar debe tratar texto correctamente, idealmente usando su geometría/máscara real cuando la implementación lo permita.

## 6. Selección y transformación

Funciones importantes existentes o históricas:

- selección individual;
- selección múltiple (Shift y/o marquee según versión actual);
- marquee desde fuera de la mesa de trabajo;
- clic en espacio vacío para deseleccionar;
- handles de esquina suficientemente grandes para resize;
- handle de rotación visible fuera del objeto;
- girar 90°;
- voltear horizontal/vertical;
- alinear/centrar;
- estirar al ancho útil;
- duplicar;
- Alt + arrastrar para duplicar según soporte actual;
- menú contextual;
- pan con Espacio + arrastre;
- zoom con Ctrl + rueda según comportamiento actual.

**Espacio + arrastrar para pan debe tener prioridad sobre otros comandos de interacción cuando esté activo.**

La hitbox y la geometría visible deben mantenerse sincronizadas después de rotación, resize, stretch y transformaciones múltiples.

## 7. DPI y calidad

El Builder muestra calidad/resolución de diseños. Históricamente se han usado niveles similares a:

- verde: óptima, normalmente >= 300 DPI;
- amarillo: intermedia/buena;
- rojo: baja.

Verifica los umbrales actuales antes de modificarlos.

Una misma imagen importada repetidamente debería obtener resultados de resolución consistentes cuando sus dimensiones físicas y píxeles son iguales. Evitar cálculos dependientes accidentalmente del estado previo de una instancia.

## 8. Semitransparencias / revisión

Existe o ha existido `Revisar lienzo` para detectar problemas antes de producción.

Principios:

- semitransparencia significa alpha entre completamente transparente y completamente opaco;
- no confundir alpha 0 o 1 con semitransparencia;
- el análisis no debe bloquear innecesariamente la UI;
- las comprobaciones finales son una segunda defensa y no sustituyen restricciones interactivas útiles.

## 9. Auto Organizar / BixNest

Auto Organizar es una parte crítica del Builder.

Objetivo: aprovechar el área de impresión reduciendo huecos y respetando separación, dimensiones y rotaciones permitidas.

El proyecto ha trabajado con **BixNest**, con estrategias de búsqueda/nesting avanzadas (incluyendo Random Search / BRKGA de forma adaptativa en versiones desarrolladas). Antes de modificar esta parte, inspecciona `bixnest/` y las llamadas desde el Builder.

Reglas:

- no degradar Auto Organizar para implementar una función manual;
- respetar separación configurada;
- respetar límites de hoja;
- considerar rotación cuando está permitida;
- evitar objetos fuera del lienzo;
- imágenes y textos deben participar correctamente;
- operaciones con muchos objetos deben terminar y no bloquear indefinidamente el navegador.

## 10. Preview vs resultado final

Esta es una invariancia crítica:

**Lo que el cliente ve debe corresponder con lo que se manda a producción.**

Ha existido un caso donde el preview mostraba objetos desacomodados pero el pedido/render final llegaba correctamente. Por ello, cualquier modificación de geometría debe considerar:

- estado fuente de verdad;
- transformaciones visuales;
- render del preview;
- serialización/exportación;
- renderer de producción.

No “arregles” solamente CSS/canvas visual si el modelo geométrico queda diferente.

## 11. Agregar al carrito / pedido

El flujo de pedido es sensible.

Requisitos desarrollados o solicitados:

- confirmación antes de continuar al carrito;
- la confirmación no debe cerrarse/desaparecer accidentalmente cuando hay varias hojas;
- durante subida/agregado debe existir feedback visible de progreso;
- mientras se está enviando un trabajo no debe permitirse que el usuario continúe modificando silenciosamente un estado que ya se está serializando;
- se eliminó un flujo previo que obligaba a ir a una revisión intermedia antes de agregar al carrito; verificar comportamiento actual antes de cambiarlo.

## 12. Procesamiento IA local

Actualmente el repositorio contiene procesamiento local:

- background removal mediante modelo en `models/`;
- ONNX Runtime;
- WebGPU cuando está disponible;
- fallback WASM;
- `bgremove.worker.js`;
- `upscaler.worker.js`.

### Migración en curso a servidor GPU

Existe un proyecto separado `manuelsmxjna-crypto/BixAI-Server` para mover background removal y upscale fuera del dispositivo del cliente.

Objetivo:

- el cliente sube la imagen al backend;
- el backend procesa con GPU;
- devuelve resultado;
- rendimiento deja de depender de la GPU/WebGPU del cliente.

Endpoints probados localmente:

- `/remove-background`
- `/upscale`

Modelos actuales: conservar los existentes mientras se valida infraestructura; no sustituirlos automáticamente por otros.

Benchmark local observado en CPU durante pruebas:

- quitar fondo: ~16 s para la imagen de prueba utilizada;
- upscale x4: ~86 s para la misma imagen.

Se está preparando despliegue en Google Cloud Run con NVIDIA L4, sujeto a disponibilidad/cuota GPU. La infraestructura de IA es un proyecto separado: no mezclar cambios de infraestructura con cambios del editor salvo que la tarea lo requiera.

## 13. Seguridad / backend

No asumir que ocultar JavaScript o el origen del frontend protege secretos.

Principios:

- secretos/API keys sensibles deben vivir en backend;
- endpoints GPU en producción no deberían quedar abusables gratuitamente por terceros;
- aplicar autenticación/autorización/rate limiting según la arquitectura final;
- el cliente nunca debe recibir credenciales privilegiadas;
- evitar que terceros puedan consumir GPU a costa del negocio simplemente copiando una URL pública.

## 14. Rendimiento

El Builder se somete a pruebas con grandes cantidades de imágenes y duplicados.

Evitar:

- trabajo O(n²) por `pointermove` cuando pueda sustituirse por broad-phase espacial;
- recreación masiva innecesaria de canvas/bitmaps;
- procesamiento pesado en el hilo principal cuando exista worker apropiado;
- loops sin límite;
- serializaciones completas en cada pequeño movimiento si no son necesarias;
- recalcular máscaras/píxeles cuando la geometría basta.

Priorizar experiencia fluida incluso con cientos de objetos.

## 15. NUEVA FUNCIÓN PRIORITARIA — prevención de colisiones manuales

### Objetivo

Evitar que el usuario superponga accidentalmente diseños cuando los acomoda manualmente.

### Comportamiento deseado

1. Al arrastrar manualmente un diseño, no debe poder atravesar/solaparse con otro cuando la función está activa.
2. Debe respetar la separación configurada entre diseños (por ejemplo 0.5 cm).
3. Debe funcionar con imágenes.
4. Debe funcionar con texto.
5. Debe funcionar con objetos rotados.
6. Debe funcionar con selección múltiple.
7. El objeto/grupo debe detenerse en la última posición válida justo antes de la colisión.
8. Si es viable sin volver frágil la interacción, permitir deslizamiento tangencial por el borde del obstáculo en vez de bloquear completamente el movimiento.
9. Añadir una opción tipo **“Evitar superposición de diseños”**, activada por defecto.
10. Si el usuario la desactiva, debe poder superponer manualmente objetos.
11. La restricción es para edición manual; no debe romper ni interferir incorrectamente con Auto Organizar.
12. `Revisar lienzo` continúa como segunda defensa.
13. No usar únicamente AABB para la fase precisa si produce falsos positivos importantes con objetos rotados.
14. Para narrow-phase, considerar **OBB + SAT** o una geometría equivalente coherente con las transformaciones reales del editor.
15. Para rendimiento, usar broad-phase (por ejemplo spatial hash/grid) para obtener candidatos cercanos y ejecutar SAT solamente contra ellos.
16. La separación debe formar parte de la geometría de exclusión de forma consistente.
17. No hacer detección pixel-perfect durante cada `pointermove`; sería innecesariamente cara y puede generar comportamientos extraños con transparencia interna.

### Selección múltiple

Durante drag de múltiples objetos:

- los objetos seleccionados no deben colisionar entre sí por el hecho de moverse juntos;
- sí deben comprobarse contra objetos externos a la selección;
- mantener offsets relativos del grupo;
- si una parte del grupo colisiona, limitar el desplazamiento completo coherentemente.

### Geometría y rotación

Antes de implementar, determinar exactamente:

- dónde se almacenan `x/y`;
- punto de origen/pivote;
- ancho/alto lógico;
- escala;
- ángulo;
- transformaciones de texto;
- cómo se calcula actualmente `rotatedAABB` o equivalente;
- qué geometría usa `Revisar lienzo`;
- qué geometría usa BixNest.

No crear un segundo sistema geométrico incompatible si puede reutilizarse el existente.

### Estrategia sugerida (no obligatoria)

Broad phase:

- spatial hash / uniform grid por hoja;
- indexar AABB expandida de cada objeto estático;
- consultar solamente celdas tocadas por el AABB expandido del objeto/grupo que se mueve.

Narrow phase:

- construir los cuatro vértices transformados de cada OBB;
- incorporar separación de forma matemáticamente consistente;
- usar SAT para detectar intersección real.

Resolución:

- calcular posición propuesta desde el pointer;
- si es válida, aceptarla;
- si colisiona, encontrar el máximo desplazamiento válido entre posición anterior y propuesta;
- opcionalmente intentar componente X/Y o proyección tangencial para sensación de “deslizamiento”.

Evitar jitter en contactos de borde mediante epsilon/tolerancia pequeña en unidades del mundo, no píxeles de pantalla.

### Casos de prueba obligatorios

- arrastre libre sin colisiones;
- choque frontal;
- movimiento diagonal;
- deslizar junto a un borde;
- imagen vs imagen;
- texto vs imagen;
- texto vs texto;
- objeto rotado vs no rotado;
- rotado vs rotado;
- selección múltiple;
- separación 0 cm;
- separación 0.5 cm;
- cambiar separación;
- función desactivada;
- objetos tocándose exactamente sin solapamiento;
- objetos cerca de límites de hoja;
- cientos de objetos;
- zoom alto/bajo (la colisión debe depender de coordenadas del documento, no de pantalla);
- pan activo;
- Alt+drag/duplicado si existe;
- undo/redo;
- Auto Organizar después de mover manualmente;
- Revisar lienzo después de mover manualmente.

## 16. Flujo recomendado para la primera tarea de colisiones

**Primero inspeccionar, no modificar.**

Localiza y reporta:

1. handlers reales de `pointerdown` / `pointermove` / `pointerup` o equivalentes usados para drag;
2. estructura de datos de un objeto;
3. funciones geométricas actuales;
4. cálculo de objetos rotados / `rotatedAABB` si existe;
5. dónde se almacena y lee la separación;
6. selección múltiple;
7. undo/redo;
8. detección de overlap usada por `Revisar lienzo`;
9. geometría usada por BixNest;
10. dónde conviene insertar broad-phase y narrow-phase sin duplicar lógica.

Antes de escribir código, entregar:

- archivos involucrados;
- funciones relevantes;
- propuesta concreta;
- lógica reutilizable;
- riesgos de regresión;
- plan de pruebas.

Solo después proceder a implementar.

## 17. Bugs/regresiones históricas a vigilar

No reintroducir:

- preview borroso o degradado por cambios de selección/zoom;
- Ctrl+rueda desplazando la ventana en vez del preview;
- marquee rompiendo el preview;
- hitbox que no sigue rotación;
- duplicados colocados fuera de hoja;
- Auto Organizar dejando huecos absurdos o ignorando rotaciones;
- objetos fuera del área válida;
- texto sobresaliendo de su hitbox;
- Enter necesitando dos pulsaciones para crear un salto de línea;
- freeze al pegar cantidades enormes de texto;
- confirmación de carrito que desaparece con varias hojas;
- progreso de subida que desaparece y deja editar durante envío;
- inconsistencias de DPI entre instancias de la misma imagen;
- preview diferente al archivo final enviado a producción.

## 18. Prioridades de diseño

En orden aproximado:

1. Correctitud del archivo de producción.
2. Evitar errores del cliente.
3. Interacción intuitiva y fluida.
4. Rendimiento con trabajos grandes.
5. Calidad visual del preview.
6. Aprovechamiento de material mediante nesting.
7. Mantener arquitectura comprensible y modificable.

Una función visualmente elegante que pueda producir un archivo incorrecto no es aceptable.

## 19. Cómo responder en sesiones futuras

Cuando se te pida una modificación importante:

- explica brevemente qué encontraste en el código;
- distingue comportamiento actual de comportamiento deseado;
- modifica solamente después de comprender el flujo;
- menciona archivos cambiados;
- describe pruebas realizadas;
- señala cualquier caso que no hayas podido verificar;
- no declares “resuelto” un problema si solo se cambió código sin validar el flujo relevante.

---

Última prioridad añadida: **prevención de colisiones durante acomodo manual con soporte correcto para rotación, texto, selección múltiple y separación, sin perjudicar Auto Organizar ni el rendimiento.**
